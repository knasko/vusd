import { ethers } from "ethers";
import { V3_ROUTER_ADDRESS, V3_ROUTER_ABI } from "../constants.js";

export function buildV3(providerOrSigner) {
  const routerV3 = new ethers.Contract(V3_ROUTER_ADDRESS, V3_ROUTER_ABI, providerOrSigner);

  // Uniwersalny quote (dowolny tokenIn → tokenOut)
  async function quoteExact({ fee, tokenIn, tokenOut, amountInBn, outDecimals, recipient }) {
    const outBn = await routerV3.exactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      fee,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });
    return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
  }

  async function swapExact({ fee, tokenIn, tokenOut, amountInBn, minOutBn, recipient }) {
    // preflight
    await routerV3.exactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      fee,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn,
      sqrtPriceLimitX96: 0n,
    });

    const tx = await routerV3.exactInputSingle({
      tokenIn,
      tokenOut,
      fee,
      recipient,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn,
      sqrtPriceLimitX96: 0n,
    });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("V3 swap failed");
    return rc;
  }

  return { quoteExact, swapExact };
}
