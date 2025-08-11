import { ethers } from "ethers";
import { V2_ROUTER_ADDRESS, V2_ROUTER_ABI } from "../constants.js";

export function buildV2(providerOrSigner) {
  const routerV2 = new ethers.Contract(V2_ROUTER_ADDRESS, V2_ROUTER_ABI, providerOrSigner);

  async function quoteExact({ path, amountInBn, outDecimals }) {
    const amounts = await routerV2.getAmountsOut(amountInBn, path);
    const outBn = amounts[amounts.length - 1];
    return { outBn, out: Number(ethers.formatUnits(outBn, outDecimals)) };
  }

  async function swapExact({ path, amountInBn, minOutBn, to, deadlineSec }) {
    const dl = Math.floor(Date.now() / 1000) + deadlineSec;
    const tx = await routerV2.swapExactTokensForTokens(amountInBn, minOutBn, path, to, dl);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("V2 swap failed");
    return rc;
  }

  return { quoteExact, swapExact };
}
