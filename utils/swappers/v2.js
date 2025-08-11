import { ethers } from "ethers";
import {
  V2_ROUTER_ADDRESS, V2_ROUTER_ABI,
  USDC_ADDRESS, VUSD_ADDRESS, VUSD_DECIMALS
} from "../constants.js";


export function buildV2(providerOrSigner) {
  const routerV2 = new ethers.Contract(V2_ROUTER_ADDRESS, V2_ROUTER_ABI, providerOrSigner);

  async function quote(amountInBn) {
    const amounts = await routerV2.getAmountsOut(amountInBn, [USDC_ADDRESS, VUSD_ADDRESS]);
    const outBn = amounts[1];
    return { name: "V2", route: 'V2', outBn, out: Number(ethers.formatUnits(outBn, VUSD_DECIMALS)) };
  }

  async function swap(amountInBn, minOutBn, to, deadlineSec) {
    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const tx = await routerV2.swapExactTokensForTokens(
      amountInBn, minOutBn, [USDC_ADDRESS, VUSD_ADDRESS], to, deadline
    );
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error('V2 swap failed');
    return rc;
  }

  return { quote, swap };
}
