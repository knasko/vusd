import { ethers } from "ethers";
import {
  V3_ROUTER_ADDRESS, V3_ROUTER_ABI,
  USDC_ADDRESS, VUSD_ADDRESS, USDC_DECIMALS, VUSD_DECIMALS
} from "../constants.js";

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24,int16,int16,int16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const DECIMALS = new Map([
  [USDC_ADDRESS.toLowerCase(), USDC_DECIMALS],
  [VUSD_ADDRESS.toLowerCase(), VUSD_DECIMALS],
]);

// --- helper: kodowanie ścieżki V3: addr | fee(3B) | addr | fee(3B) | addr
function encodePath(tokens, fees) {
  if (tokens.length !== fees.length + 1) throw new Error("encodePath: tokens.length must be fees.length + 1");
  let hex = "0x";
  for (let i = 0; i < fees.length; i++) {
    hex += tokens[i].slice(2);
    hex += ethers.toBeHex(fees[i], 3).slice(2); // 3 bajty
  }
  hex += tokens[tokens.length - 1].slice(2);
  return hex;
}

export function buildV3(providerOrSigner) {
  const routerV3 = new ethers.Contract(V3_ROUTER_ADDRESS, V3_ROUTER_ABI, providerOrSigner);
  const provider = routerV3.runner;

  async function quoteFromPool({ poolAddress, tokenIn, tokenOut, amountInBn, fee }) {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const [slot0, t0, t1] = await Promise.all([pool.slot0(), pool.token0(), pool.token1()]);
    const sqrt = slot0.sqrtPriceX96 ?? slot0[0];
    const Q192 = 2n ** 192n;

    const token0 = t0.toLowerCase();
    const token1 = t1.toLowerCase();
    const inIs0  = tokenIn.toLowerCase() === token0;
    const outIs1 = tokenOut.toLowerCase() === token1;
    if (!(inIs0 ? outIs1 : tokenOut.toLowerCase() === token0)) throw new Error("pool/token mismatch");

    const dec0 = DECIMALS.get(token0);
    const dec1 = DECIMALS.get(token1);
    if (dec0 == null || dec1 == null) throw new Error("missing token decimals");

    // price1per0 = (sqrt^2 / Q192) * (10^dec0 / 10^dec1)
    const sqrtN = BigInt(sqrt);
    const num   = sqrtN * sqrtN * (10n ** BigInt(dec0));
    const den   = Q192 * (10n ** BigInt(dec1));

    const amountAfterFee = amountInBn * BigInt(1_000_000 - fee) / 1_000_000n;
    let outWei;
    if (inIs0) outWei = (amountAfterFee * num) / den;
    else       outWei = (amountAfterFee * den) / num;
    return outWei;
  }

  // --- single-hop (jak wcześniej, z fallbackiem)
  async function quoteExact({ fee, tokenIn, tokenOut, amountInBn, outDecimals, recipient, poolAddress }) {
    try {
      const outBn = await routerV3.exactInputSingle.staticCall({
        tokenIn, tokenOut, fee, recipient,
        amountIn: amountInBn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n
      });
      return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
    } catch {
      if (!poolAddress) throw new Error("router revert & no poolAddress");
      const outBn = await quoteFromPool({ poolAddress, tokenIn, tokenOut, amountInBn, fee });
      return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
    }
  }

  // --- multi-hop (nowe)
  async function quoteExactPath({ path, amountInBn, outDecimals, recipient }) {
    const outBn = await routerV3.exactInput.staticCall({
      path, recipient, amountIn: amountInBn, amountOutMinimum: 0n
    });
    return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
  }

  async function swapExactPath({ path, amountInBn, minOutBn, recipient }) {
    // preflight
    await routerV3.exactInput.staticCall({
      path, recipient, amountIn: amountInBn, amountOutMinimum: minOutBn
    });
    const tx = await routerV3.exactInput({
      path, recipient, amountIn: amountInBn, amountOutMinimum: minOutBn
    });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("V3 path swap failed");
    return rc;
  }

  return { quoteExact, quoteExactPath, swapExactPath, encodePath, routerV3 };
}
