import 'dotenv/config';
import { ethers } from "ethers";
import { logger } from "./utils/logger.js";
import { selectRpc } from "./utils/autorpc.js";
import {
  USDC_ADDRESS, VUSD_ADDRESS,
  USDC_DECIMALS, VUSD_DECIMALS,
  V3_POOLS, V3_ROUTER_ADDRESS, V2_ROUTER_ADDRESS, ERC20_ABI
} from "./utils/constants.js";
import { buildV3 } from "./utils/swappers/v3.js";
import { buildV2 } from "./utils/swappers/v2.js";

// ENV
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || '20000', 10);
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || '1000');
const TRADE_AMOUNT_VUSD = Number(process.env.TRADE_AMOUNT_VUSD || '1000');         // ⬅️ NEW
const PROFIT_THRESHOLD_VUSD = Number(process.env.PROFIT_THRESHOLD_VUSD || '3');
const PROFIT_THRESHOLD_USDC = Number(process.env.PROFIT_THRESHOLD_USDC || '3');    // ⬅️ NEW
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '150', 10);
const DEADLINE_SEC = parseInt(process.env.DEADLINE_SEC || '60', 10);
const DEBUG = (process.env.DEBUG || '0') === '1';

// Ethers init
const RPC = await selectRpc();
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
const vusd = new ethers.Contract(VUSD_ADDRESS, ERC20_ABI, wallet);                 // ⬅️ NEW

const v3 = buildV3(wallet);
const v2 = buildV2(wallet);

// utils
const bn = (v, dec) => ethers.parseUnits(String(v), dec);
const fmt = (v, dec) => Number(ethers.formatUnits(v, dec));
const withSlippageOutMin = (outBn, bps) => (outBn * BigInt(10_000 - bps)) / BigInt(10_000);

async function approveIfNeeded(tokenContract, spender, amountBn) {                 // ⬅️ generic
  const allowance = await tokenContract.allowance(wallet.address, spender);
  if (allowance < amountBn) {
    logger.info(`🪙 Approve dla ${spender} ...`);
    const tx = await tokenContract.approve(spender, ethers.MaxUint256);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error('Approve failed');
    logger.ok(`Approve OK`);
  } else if (DEBUG) {
    logger.info(`Allowance OK (>= amountIn)`);
  }
}

let isRunning = false;

async function mainOnce() {
  if (isRunning) { if (DEBUG) logger.info("Poprzedni cykl trwa — pomijam"); return; }
  isRunning = true;
  const t0 = Date.now();

  try {
    logger.line(`\n🤖 Start skanu pul (oba kierunki USDC↔vUSD)`);

    const amountUsdcBn = bn(TRADE_AMOUNT_USDC, USDC_DECIMALS);
    const amountVusdBn = bn(TRADE_AMOUNT_VUSD, VUSD_DECIMALS);

    const [balUsdc, balVusd] = await Promise.all([
      usdc.balanceOf(wallet.address),
      vusd.balanceOf(wallet.address)
    ]);

    // --- QUOTES: USDC -> vUSD ---
    const qFwdJobs = [
      v3.quoteExact({ fee: V3_POOLS[0].fee, tokenIn: USDC_ADDRESS, tokenOut: VUSD_ADDRESS, amountInBn: amountUsdcBn, outDecimals: VUSD_DECIMALS, recipient: wallet.address })
        .then(r => ({ ok: true, name: V3_POOLS[0].name, route: 'V3', fee: V3_POOLS[0].fee, ...r }))
        .catch(e => ({ ok:false, e })),
      v3.quoteExact({ fee: V3_POOLS[1].fee, tokenIn: USDC_ADDRESS, tokenOut: VUSD_ADDRESS, amountInBn: amountUsdcBn, outDecimals: VUSD_DECIMALS, recipient: wallet.address })
        .then(r => ({ ok: true, name: V3_POOLS[1].name, route: 'V3', fee: V3_POOLS[1].fee, ...r }))
        .catch(e => ({ ok:false, e })),
      v2.quoteExact({ path: [USDC_ADDRESS, VUSD_ADDRESS], amountInBn: amountUsdcBn, outDecimals: VUSD_DECIMALS })
        .then(r => ({ ok: true, name: "V2", route: 'V2', ...r }))
        .catch(e => ({ ok:false, e })),
    ];
    const fwdRes = (await Promise.all(qFwdJobs)).filter(r=>r.ok);

    // --- QUOTES: vUSD -> USDC ---
    const qRevJobs = [
      v3.quoteExact({ fee: V3_POOLS[0].fee, tokenIn: VUSD_ADDRESS, tokenOut: USDC_ADDRESS, amountInBn: amountVusdBn, outDecimals: USDC_DECIMALS, recipient: wallet.address })
        .then(r => ({ ok: true, name: V3_POOLS[0].name, route: 'V3', fee: V3_POOLS[0].fee, ...r }))
        .catch(e => ({ ok:false, e })),
      v3.quoteExact({ fee: V3_POOLS[1].fee, tokenIn: VUSD_ADDRESS, tokenOut: USDC_ADDRESS, amountInBn: amountVusdBn, outDecimals: USDC_DECIMALS, recipient: wallet.address })
        .then(r => ({ ok: true, name: V3_POOLS[1].name, route: 'V3', fee: V3_POOLS[1].fee, ...r }))
        .catch(e => ({ ok:false, e })),
      v2.quoteExact({ path: [VUSD_ADDRESS, USDC_ADDRESS], amountInBn: amountVusdBn, outDecimals: USDC_DECIMALS })
        .then(r => ({ ok: true, name: "V2", route: 'V2', ...r }))
        .catch(e => ({ ok:false, e })),
    ];
    const revRes = (await Promise.all(qRevJobs)).filter(r=>r.ok);

    // Logi porównawcze
for (const q of fwdRes) logger.quote(`(USDC→vUSD) ${q.name}`, q.out, q.out - TRADE_AMOUNT_USDC, 'vUSD');
for (const q of revRes) logger.quote(`(vUSD→USDC) ${q.name}`, q.out, q.out - TRADE_AMOUNT_VUSD, 'USDC');

    // Wybór najlepszych kierunków
    const bestFwd = fwdRes.length ? fwdRes.reduce((a,b)=>a.out>b.out?a:b) : null;  // max vUSD
    const bestRev = revRes.length ? revRes.reduce((a,b)=>a.out>b.out?a:b) : null;  // max USDC

    const fwdProfit = bestFwd ? (bestFwd.out - TRADE_AMOUNT_USDC) : -Infinity;     // jednostki vUSD (zakładamy 1≈1)
    const revProfit = bestRev ? (bestRev.out - TRADE_AMOUNT_VUSD) : -Infinity;     // jednostki USDC

    const fwdOk = bestFwd && fwdProfit >= PROFIT_THRESHOLD_VUSD && balUsdc >= amountUsdcBn;
    const revOk = bestRev && revProfit >= PROFIT_THRESHOLD_USDC && balVusd >= amountVusdBn;

    if (!fwdOk && !revOk) {
      if (bestFwd) logger.warn(`USDC→vUSD: ${(balUsdc<amountUsdcBn)?'za mało USDC':'zysk < próg'}`);
      if (bestRev) logger.warn(`vUSD→USDC: ${(balVusd<amountVusdBn)?'za mało vUSD':'zysk < próg'}`);
      if (!bestFwd && !bestRev) logger.err("Brak poprawnych quote’ów w obu kierunkach.");
      return;
    }

    // Wybor – jeśli oba możliwe, preferuj większy zysk (przyjmujemy 1 vUSD ≈ 1 USDC)
    const doFwd = fwdOk && (!revOk || fwdProfit >= revProfit);

    if (doFwd) {
      const minOut = withSlippageOutMin(bestFwd.outBn, SLIPPAGE_BPS);
      await approveIfNeeded(usdc, V3_ROUTER_ADDRESS, amountUsdcBn);  // approve dla obu routerów i tak shared allowance
      await approveIfNeeded(usdc, V2_ROUTER_ADDRESS, amountUsdcBn);
      const rc = bestFwd.route === 'V3'
        ? await v3.swapExact({ fee: bestFwd.fee, tokenIn: USDC_ADDRESS, tokenOut: VUSD_ADDRESS, amountInBn: amountUsdcBn, minOutBn: minOut, recipient: wallet.address })
        : await v2.swapExact({ path: [USDC_ADDRESS, VUSD_ADDRESS], amountInBn: amountUsdcBn, minOutBn: minOut, to: wallet.address, deadlineSec: DEADLINE_SEC });
      logger.swap(`USDC→vUSD ${bestFwd.name}`, fwdProfit, 'vUSD');
      logger.ok(`Tx: ${rc.transactionHash}`);
    } else {
      const minOut = withSlippageOutMin(bestRev.outBn, SLIPPAGE_BPS);
      await approveIfNeeded(vusd, V3_ROUTER_ADDRESS, amountVusdBn);
      await approveIfNeeded(vusd, V2_ROUTER_ADDRESS, amountVusdBn);
      const rc = bestRev.route === 'V3'
        ? await v3.swapExact({ fee: bestRev.fee, tokenIn: VUSD_ADDRESS, tokenOut: USDC_ADDRESS, amountInBn: amountVusdBn, minOutBn: minOut, recipient: wallet.address })
        : await v2.swapExact({ path: [VUSD_ADDRESS, USDC_ADDRESS], amountInBn: amountVusdBn, minOutBn: minOut, to: wallet.address, deadlineSec: DEADLINE_SEC });
      logger.swap(`vUSD→USDC ${bestRev.name}`, revProfit, 'USDC');
      logger.ok(`Tx: ${rc.transactionHash}`);
    }

  } catch (e) {
    logger.err(`Błąd cyklu: ${e?.message || e}`);
    if (DEBUG && e?.stack) console.error(e.stack);
  } finally {
    logger.info(`⏱️ Koniec cyklu (${Date.now()-t0} ms)`);
    isRunning = false;
  }
}

mainOnce();
setInterval(mainOnce, CHECK_INTERVAL);

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('SIGINT', () => { console.log('\n👋 Exit'); process.exit(0); });
