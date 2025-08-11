import 'dotenv/config';
import { ethers } from "ethers";
import { logger } from "./utils/logger.js";
import { selectRpc } from "./utils/autorpc.js";

import {
  USDC_ADDRESS, USDC_DECIMALS, VUSD_DECIMALS,
  V3_POOLS, V3_ROUTER_ADDRESS, V2_ROUTER_ADDRESS, ERC20_ABI
} from "./utils/constants.js";

import { buildV3 } from "./utils/swappers/v3.js";
import { buildV2 } from "./utils/swappers/v2.js";

const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || '20000', 10);
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || '1000');
const PROFIT_THRESHOLD = Number(process.env.PROFIT_THRESHOLD_VUSD || '3');
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '150', 10);
const DEADLINE_SEC = parseInt(process.env.DEADLINE_SEC || '60', 10);
const DEBUG = (process.env.DEBUG || '0') === '1';

const RPC = await selectRpc();
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
const v3 = buildV3(wallet);
const v2 = buildV2(wallet);

const bn = (v, dec) => ethers.parseUnits(String(v), dec);
const fmt = (v, dec) => Number(ethers.formatUnits(v, dec));
const withSlippageOutMin = (outBn, bps) => (outBn * BigInt(10_000 - bps)) / BigInt(10_000);

async function approveIfNeeded(spender, amountBn) {
  const allowance = await usdc.allowance(wallet.address, spender);
  if (allowance < amountBn) {
    logger.info(`🪙 Brak wyst. allowance USDC → approve(${spender}) ...`);
    const tx = await usdc.approve(spender, ethers.MaxUint256);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error('Approve failed');
    logger.ok(`Approve OK`);
  } else if (DEBUG) {
    logger.info(`Allowance OK`);
  }
}

let isRunning = false;

async function mainOnce() {
  if (isRunning) { if (DEBUG) logger.info("Poprzedni cykl trwa — pomijam"); return; }
  isRunning = true;
  const t0 = Date.now();
  try {
    logger.line(`\n🤖 Start skanu pul (USDC→vUSD)`);

    const amountInBn = bn(TRADE_AMOUNT_USDC, USDC_DECIMALS);

    const bal = await usdc.balanceOf(wallet.address);
    if (bal < amountInBn) {
      logger.warn(`Za mało USDC. Balans: ${fmt(bal, USDC_DECIMALS).toFixed(2)} < ${TRADE_AMOUNT_USDC}`);
      return;
    }

    const jobs = [
      v3.quote(V3_POOLS[0], amountInBn, wallet.address),
      v3.quote(V3_POOLS[1], amountInBn, wallet.address),
      v2.quote(amountInBn),
    ].map(p => p.then(v => ({ ok:true, v })).catch(e => ({ ok:false, e })));

    const results = await Promise.all(jobs);
    const quotes = results.filter(r=>r.ok).map(r=>r.v);

    if (!quotes.length) {
      logger.err("Brak poprawnych quote’ów (błędy RPC/pule)");
      return;
    }

    for (const q of quotes) {
      const profit = q.out - TRADE_AMOUNT_USDC;
      logger.quote(q.name, q.out, profit);
    }

    const best = quotes.reduce((a, b) => (a.out > b.out ? a : b));
    const bestProfit = best.out - TRADE_AMOUNT_USDC;

    if (bestProfit < PROFIT_THRESHOLD) {
      logger.warn(`Brak opłacalnego swapa. Najlepsze: ${best.name} (zysk ${bestProfit.toFixed(6)} vUSD)`);
      return;
    }

    const minOut = withSlippageOutMin(best.outBn, SLIPPAGE_BPS);

    if (best.route === 'V3') {
      await approveIfNeeded(V3_ROUTER_ADDRESS, amountInBn);
      const rc = await v3.swap(best, amountInBn, minOut, wallet.address);
      logger.swap(best.name, bestProfit);
      logger.ok(`Tx: ${rc.transactionHash}`);
    } else {
      await approveIfNeeded(V2_ROUTER_ADDRESS, amountInBn);
      const rc = await v2.swap(amountInBn, minOut, wallet.address, DEADLINE_SEC);
      logger.swap(best.name, bestProfit);
      logger.ok(`Tx: ${rc.transactionHash}`);
    }
  } catch (e) {
    logger.err(`Błąd cyklu: ${e?.message || e}`);
    if (DEBUG && e?.stack) console.error(e.stack);
  } finally {
    const ms = Date.now() - t0;
    logger.info(`⏱️ Koniec cyklu (${ms} ms)`);
    isRunning = false;
  }
}

mainOnce();
setInterval(mainOnce, CHECK_INTERVAL);

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('SIGINT', () => { console.log('\n👋 Exit'); process.exit(0); });
