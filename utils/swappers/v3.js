// utils/swappers/v3.js
import { ethers } from "ethers";
import { V3_ROUTER_ADDRESS, V3_ROUTER_ABI, ERC20_ABI } from "../constants.js";

// Minimalne ABI puli V3 do fallbacku (slot0 + tokeny)
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24,int16,int16,int16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

// --- cache na decimals() (on-chain) ---
const decCache = new Map();
async function decimalsOf(addr, runner) {
  const key = addr.toLowerCase();
  if (decCache.has(key)) return decCache.get(key);
  const erc = new ethers.Contract(addr, ERC20_ABI, runner);
  const d = Number(await erc.decimals());
  decCache.set(key, d);
  return d;
}

// --- helper: kodowanie ścieżki Uniswap V3: addr | fee(3B) | addr | fee(3B) | addr ---
function encodePath(tokens, fees) {
  if (tokens.length !== fees.length + 1)
    throw new Error("encodePath: tokens.length must be fees.length + 1");
  let hex = "0x";
  for (let i = 0; i < fees.length; i++) {
    hex += tokens[i].slice(2);
    const feeHex = Number(fees[i]).toString(16).padStart(6, "0"); // 3 bajty
    hex += feeHex;
  }
  hex += tokens[tokens.length - 1].slice(2);
  return hex;
}

export function buildV3(providerOrSigner) {
  // router V3 (H2/Uniswap-style)
  const routerV3 = new ethers.Contract(V3_ROUTER_ADDRESS, V3_ROUTER_ABI, providerOrSigner);
  const runner = routerV3.runner; // signer lub provider

  // --- FALLBACK: wycena z puli via slot0() + poprawne decimale ---
  async function fallbackFromPool({ poolAddress, tokenIn, tokenOut, amountInBn, fee }) {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, runner);
    const [slot0, a0, a1] = await Promise.all([pool.slot0(), pool.token0(), pool.token1()]);

    const token0 = a0.toLowerCase();
    const token1 = a1.toLowerCase();
    const inIs0  = tokenIn.toLowerCase()  === token0;
    const outIs1 = tokenOut.toLowerCase() === token1;

    // Dopuszczamy tylko parę tokenów z tej puli (0<->1)
    if (!(inIs0 ? outIs1 : tokenOut.toLowerCase() === token0)) {
      throw new Error("fallbackFromPool: pool/token mismatch");
    }

    const [dec0, dec1] = await Promise.all([
      decimalsOf(token0, runner),
      decimalsOf(token1, runner)
    ]);

    // price1per0 = (sqrt^2 / Q192) * (10^dec0 / 10^dec1)
    const sqrt = slot0.sqrtPriceX96 ?? slot0[0];
    const Q192 = 2n ** 192n;
    const sqrtN = BigInt(sqrt);
    const num   = sqrtN * sqrtN * (10n ** BigInt(dec0)); // sqrt^2 * 10^dec0
    const den   = Q192 * (10n ** BigInt(dec1));          // Q192   * 10^dec1

    // zdejmujemy fee (ppm, np. 500 / 3000)
    const amountAfterFee = amountInBn * BigInt(1_000_000 - fee) / 1_000_000n;

    // token0->token1 : out = amount * price ; token1->token0 : out = amount / price
    return inIs0
      ? (amountAfterFee * num) / den
      : (amountAfterFee * den) / num;
  }

  // === SINGLE-HOP QUOTE ===
  // Najpierw próbujemy przez router (idealnie), a gdy RPC/pula rewertuje – liczymy z slot0()
  async function quoteExact({ fee, tokenIn, tokenOut, amountInBn, outDecimals, recipient, poolAddress }) {
    try {
      const outBn = await routerV3.exactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        fee,
        recipient,
        amountIn: amountInBn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n
      });
      return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
    } catch {
      if (!poolAddress) throw new Error("router revert & no poolAddress for fallback");
      const outBn = await fallbackFromPool({ poolAddress, tokenIn, tokenOut, amountInBn, fee });
      return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
    }
  }

  // === MULTI-HOP QUOTE (path) ===
  async function quoteExactPath({ path, amountInBn, outDecimals, recipient }) {
    const outBn = await routerV3.exactInput.staticCall({
      path,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: 0n
    });
    return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
  }

  // === SINGLE-HOP SWAP ===
  async function swapExact({ fee, tokenIn, tokenOut, amountInBn, minOutBn, recipient }) {
    // preflight (bez gazu)
    await routerV3.exactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      fee,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn,
      sqrtPriceLimitX96: 0n
    });

    const tx = await routerV3.exactInputSingle({
      tokenIn,
      tokenOut,
      fee,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn,
      sqrtPriceLimitX96: 0n
    });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("V3 swap failed");
    return rc;
  }

  // === MULTI-HOP SWAP (path) ===
  async function swapExactPath({ path, amountInBn, minOutBn, recipient }) {
    // preflight
    await routerV3.exactInput.staticCall({
      path,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn
    });

    const tx = await routerV3.exactInput({
      path,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn
    });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("V3 path swap failed");
    return rc;
  }

  return {
    // quotes
    quoteExact,        // single-hop
    quoteExactPath,    // multi-hop
    // swaps
    swapExact,
    swapExactPath,
    // helpers
    encodePath,
    routerV3
  };
}
