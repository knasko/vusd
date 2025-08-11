import { ethers } from "ethers";
import { V3_ROUTER_ADDRESS, V3_ROUTER_ABI, USDC_ADDRESS, VUSD_ADDRESS, VUSD_DECIMALS } from "../constants.js";

export function buildV3(providerOrSigner) {
  const routerV3 = new ethers.Contract(V3_ROUTER_ADDRESS, V3_ROUTER_ABI, providerOrSigner);

  async function quote(pool, amountInBn, walletAddress) {
    const outBn = await routerV3.exactInputSingle.staticCall({
      tokenIn: USDC_ADDRESS,
      tokenOut: VUSD_ADDRESS,
      fee: pool.fee,
      recipient: walletAddress,
      amountIn: amountInBn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });
    return { name: pool.name, route: 'V3', fee: pool.fee, outBn, out: Number(ethers.formatUnits(outBn, VUSD_DECIMALS)) };
  }

  async function swap(best, amountInBn, minOutBn, walletAddress) {
    await routerV3.exactInputSingle.staticCall({
      tokenIn: USDC_ADDRESS,
      tokenOut: VUSD_ADDRESS,
      fee: best.fee,
      recipient: walletAddress,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn,
      sqrtPriceLimitX96: 0n,
    });

    const tx = await routerV3.exactInputSingle({
      tokenIn: USDC_ADDRESS,
      tokenOut: VUSD_ADDRESS,
      fee: best.fee,
      recipient: walletAddress,
      amountIn: amountInBn,
      amountOutMinimum: minOutBn,
      sqrtPriceLimitX96: 0n,
    });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error('V3 swap failed');
    return rc;
  }

  return { quote, swap };
}
