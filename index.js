// index.js
import 'dotenv/config';
import { ethers } from "ethers";
import { logger } from "./utils/logger.js";
import { selectRpc } from "./utils/autorpc.js";
import {
  USDC_ADDRESS, VUSD_ADDRESS,
  USDC_DECIMALS, VUSD_DECIMALS,
  V3_POOLS, V3_ROUTER_ADDRESS, V2_ROUTER_ADDRESS,
  ERC20_ABI
} from "./utils/constants.js";
import { buildV3 } from "./utils/swappers/v3.js";
import { buildV2 } from "./utils/swappers/v2.js";

// ===== ENV =====
const CHECK_INTERVAL        = parseInt(process.env.CHECK_INTERVAL_MS || '20000', 10);
const TRADE_AMOUNT_USDC     = Number(process.env.TRADE_AMOUNT_USDC || '1000');
const TRADE_AMOUNT_VUSD     = Number(process.env.TRADE_AMOUNT_VUSD || '1000');
const PROFIT_THRESHOLD_VUSD = Number(process.env.PROFIT_THRESHOLD_VUSD || '3');
const PROFIT_THRESHOLD_USDC = Number(process.env.PROFIT_THRESHOLD_USDC || '3');
const SLIPPAGE_BPS          = parseInt(process.env.SLIPPAGE_BPS || '150', 10); // 1.5%
const DEADLINE_SEC          = parseInt(process.env.DEADLINE_SEC || '60', 10);
const DEBUG                 = (process.env.DEBUG || '0') === '1';

// ===== RPC / Wallet =====
if (!process.env.PRIVATE_KEY) {
  throw new Error("Brak PRIVATE_KEY w env");
}
const RPC = await selectRpc();
const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const erc = (addr) => new ethers.Contract(addr, ERC20_ABI, wallet);
const DEC_USDC = Number(await erc(USDC_ADDRESS).decimals());
const DEC_VUSD = Number(await erc(VUSD_ADDRESS).decimals());

// ===== Kontrakty i swaper’y =====
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
const vusd = new ethers.Contract(VUSD_ADDRESS, ERC20_ABI, wallet);

const v3 = buildV3(wallet); // ma: quoteExact, quoteExactPath, swapExactPath, encodePath, routerV3
const v2 = buildV2(wallet);

// ===== WETH9 (dla multi-hop) =====
let WETH9 = null;
try {
  WETH9 = await v3.routerV3.WETH9();
  logger.ok(`WETH9: ${WETH9}`);
} catch {
  if (process.env.WETH9) {
    WETH9 = process.env.WETH9;
    logger.warn(`WETH9() niedostępne – używam z ENV: ${WETH9}`);
  } else {
    logger.warn("Brak WETH9 – multi-hop V3 będzie pominięty");
  }
}

// ===== Utils =====
const bn  = (v, dec) => ethers.parseUnits(String(v), dec);
const fmt = (v, dec) => Number(ethers.formatUnits(v, dec));

const withSlippageOutMin = (outBn, bps) =>
  (outBn * BigInt(10_000 - bps)) / BigInt(10_000);

async function approveIfNeeded(tokenContract, spender, amountBn) {
  const allowance = await tokenContract.allowance(wallet.address, spender);
  if (allowance < amountBn) {
    logger.info(`🪙 Approve ${await tokenContract.getAddress?.() ?? 'token'} -> ${spender} ...`);
    const tx = await tokenContract.approve(spender, ethers.MaxUint256);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error('Approve failed');
    logger.ok('Approve OK');
  } else if (DEBUG) {
    logger.info('Allowance OK (>= amountIn)');
  }
}

let isRunning = false;

async function mainOnce() {
  if (isRunning) { if (DEBUG) logger.info("Poprzedni cykl trwa — pomijam"); return; }
  isRunning = true;
  const t0 = Date.now();

  try {
    logger.line(`\n🤖 Start skanu pul (oba kierunki USDC↔vUSD)`);

const amountUsdcBn = bn(TRADE_AMOUNT_USDC, DEC_USDC);
const amountVusdBn = bn(TRADE_AMOUNT_VUSD, DEC_VUSD);

    // Balansy równolegle
    const [balUsdc, balVusd] = await Promise.all([
      usdc.balanceOf(wallet.address),
      vusd.balanceOf(wallet.address),
    ]);

    // ------- QUOTES: USDC -> vUSD -------
    const qFwdJobs = [
      // V3 single-hop
      v3.quoteExact({
        fee: V3_POOLS[0].fee,
        tokenIn: USDC_ADDRESS, tokenOut: VUSD_ADDRESS,
        amountInBn: amountUsdcBn, outDecimals: VUSD_DECIMALS,
        recipient: wallet.address, poolAddress: V3_POOLS[0].address
      }).then(r => ({ ok:true, name: V3_POOLS[0].name, route:'V3', fee: V3_POOLS[0].fee, ...r }))
        .catch(e => ({ ok:false, e })),

      v3.quoteExact({
        fee: V3_POOLS[1].fee,
        tokenIn: USDC_ADDRESS, tokenOut: VUSD_ADDRESS,
        amountInBn: amountUsdcBn, outDecimals: VUSD_DECIMALS,
        recipient: wallet.address, poolAddress: V3_POOLS[1].address
      }).then(r => ({ ok:true, name: V3_POOLS[1].name, route:'V3', fee: V3_POOLS[1].fee, ...r }))
        .catch(e => ({ ok:false, e })),

      // V2 single-hop
      v2.quoteExact({
        path: [USDC_ADDRESS, VUSD_ADDRESS],
        amountInBn: amountUsdcBn,
        outDecimals: VUSD_DECIMALS
      }).then(r => ({ ok:true, name:"V2", route:'V2', ...r }))
        .catch(e => ({ ok:false, e })),
    ];

    // V3 multi-hop przez WETH9 (jeśli dostępny)
    if (WETH9) {
      const feeCombos = [
        [500, 500],
        [500, 3000],
        [3000, 500],
        [3000, 3000],
      ];
      for (const [f1, f2] of feeCombos) {
        const path = v3.encodePath([USDC_ADDRESS, WETH9, VUSD_ADDRESS], [f1, f2]);
        qFwdJobs.push(
          v3.quoteExactPath({
            path, amountInBn: amountUsdcBn, outDecimals: VUSD_DECIMALS, recipient: wallet.address
          }).then(r => ({ ok:true, name:`V3 path ${f1/100}%+${f2/100}%`, route:'V3PATH', fees:[f1,f2], ...r }))
            .catch(e => ({ ok:false, e }))
        );
      }
    }

    // ------- QUOTES: vUSD -> USDC -------
    const qRevJobs = [
      // V3 single-hop
      v3.quoteExact({
        fee: V3_POOLS[0].fee,
        tokenIn: VUSD_ADDRESS, tokenOut: USDC_ADDRESS,
        amountInBn: amountVusdBn, outDecimals: USDC_DECIMALS,
        recipient: wallet.address, poolAddress: V3_POOLS[0].address
      }).then(r => ({ ok:true, name: V3_POOLS[0].name, route:'V3', fee: V3_POOLS[0].fee, ...r }))
        .catch(e => ({ ok:false, e })),

      v3.quoteExact({
        fee: V3_POOLS[1].fee,
        tokenIn: VUSD_ADDRESS, tokenOut: USDC_ADDRESS,
        amountInBn: amountVusdBn, outDecimals: USDC_DECIMALS,
        recipient: wallet.address, poolAddress: V3_POOLS[1].address
      }).then(r => ({ ok:true, name: V3_POOLS[1].name, route:'V3', fee: V3_POOLS[1].fee, ...r }))
        .catch(e => ({ ok:false, e })),

      // V2 single-hop
      v2.quoteExact({
        path: [VUSD_ADDRESS, USDC_ADDRESS],
        amountInBn: amountVusdBn,
        outDecimals: USDC_DECIMALS
      }).then(r => ({ ok:true, name:"V2", route:'V2', ...r }))
        .catch(e => ({ ok:false, e })),
    ];

    if (WETH9) {
      const feeCombos = [
        [500, 500],
        [500, 3000],
        [3000, 500],
        [3000, 3000],
      ];
      for (const [f1, f2] of feeCombos) {
        const path = v3.encodePath([VUSD_ADDRESS, WETH9, USDC_ADDRESS], [f1, f2]);
        qRevJobs.push(
          v3.quoteExactPath({
            path, amountInBn: amountVusdBn, outDecimals: USDC_DECIMALS, recipient: wallet.address
          }).then(r => ({ ok:true, name:`V3 path ${f1/100}%+${f2/100}%`, route:'V3PATH', fees:[f1,f2], ...r }))
            .catch(e => ({ ok:false, e }))
        );
      }
    }

    // Wykonaj quotes
    const [fwdResAll, revResAll] = await Promise.all([
      Promise.all(qFwdJobs),
      Promise.all(qRevJobs),
    ]);
    const fwdRes = fwdResAll.filter(r => r.ok);
    const revRes = revResAll.filter(r => r.ok);

    // Logi z właściwą jednostką
for (const q of fwdRes) logger.quote(`(USDC→vUSD) ${q.name}`, q.out, q.out - TRADE_AMOUNT_USDC, 'vUSD');
for (const q of revRes) logger.quote(`(vUSD→USDC) ${q.name}`, q.out, q.out - TRADE_AMOUNT_VUSD, 'USDC');


    // Wybór najlepszych
    const bestFwd = fwdRes.length ? fwdRes.reduce((a,b)=>a.out>b.out?a:b) : null; // max vUSD
    const bestRev = revRes.length ? revRes.reduce((a,b)=>a.out>b.out?a:b) : null; // max USDC

    const fwdProfit = bestFwd ? (bestFwd.out - TRADE_AMOUNT_USDC) : -Infinity; // w vUSD (≈USDC)
    const revProfit = bestRev ? (bestRev.out - TRADE_AMOUNT_VUSD) : -Infinity; // w USDC

    const fwdOk = bestFwd && fwdProfit >= PROFIT_THRESHOLD_VUSD && balUsdc >= amountUsdcBn;
    const revOk = bestRev && revProfit >= PROFIT_THRESHOLD_USDC && balVusd >= amountVusdBn;

    if (!fwdOk && !revOk) {
      if (bestFwd) logger.warn(`USDC→vUSD: ${(balUsdc<amountUsdcBn)?'za mało USDC':'zysk < próg'}`);
      if (bestRev) logger.warn(`vUSD→USDC: ${(balVusd<amountVusdBn)?'za mało vUSD':'zysk < próg'}`);
      if (!bestFwd && !bestRev) logger.err("Brak poprawnych quote’ów (oba kierunki).");
      return;
    }

    // Wybór kierunku (jeśli oba OK, porównujemy zyski ~1:1)
    const doFwd = fwdOk && (!revOk || fwdProfit >= revProfit);

    if (doFwd) {
      const minOut = withSlippageOutMin(bestFwd.outBn, SLIPPAGE_BPS);
      if (bestFwd.route === 'V3' || bestFwd.route === 'V3PATH') {
        await approveIfNeeded(usdc, V3_ROUTER_ADDRESS, amountUsdcBn);
      } else {
        await approveIfNeeded(usdc, V2_ROUTER_ADDRESS, amountUsdcBn);
      }

      const rc = bestFwd.route === 'V3'
        ? await v3.swapExact({
            fee: bestFwd.fee,
            tokenIn: USDC_ADDRESS, tokenOut: VUSD_ADDRESS,
            amountInBn: amountUsdcBn, minOutBn: minOut, recipient: wallet.address
          })
        : bestFwd.route === 'V3PATH'
        ? await v3.swapExactPath({
            path: v3.encodePath([USDC_ADDRESS, WETH9, VUSD_ADDRESS], bestFwd.fees),
            amountInBn: amountUsdcBn, minOutBn: minOut, recipient: wallet.address
          })
        : await v2.swapExact({
            path: [USDC_ADDRESS, VUSD_ADDRESS],
            amountInBn: amountUsdcBn, minOutBn: minOut, to: wallet.address, deadlineSec: DEADLINE_SEC
          });

      logger.swap(`USDC→vUSD ${bestFwd.name}`, fwdProfit, 'vUSD');
      logger.ok(`Tx: ${rc.transactionHash}`);

    } else {
      const minOut = withSlippageOutMin(bestRev.outBn, SLIPPAGE_BPS);
      if (bestRev.route === 'V3' || bestRev.route === 'V3PATH') {
        await approveIfNeeded(vusd, V3_ROUTER_ADDRESS, amountVusdBn);
      } else {
        await approveIfNeeded(vusd, V2_ROUTER_ADDRESS, amountVusdBn);
      }

      const rc = bestRev.route === 'V3'
        ? await v3.swapExact({
            fee: bestRev.fee,
            tokenIn: VUSD_ADDRESS, tokenOut: USDC_ADDRESS,
            amountInBn: amountVusdBn, minOutBn: minOut, recipient: wallet.address
          })
        : bestRev.route === 'V3PATH'
        ? await v3.swapExactPath({
            path: v3.encodePath([VUSD_ADDRESS, WETH9, USDC_ADDRESS], bestRev.fees),
            amountInBn: amountVusdBn, minOutBn: minOut, recipient: wallet.address
          })
        : await v2.swapExact({
            path: [VUSD_ADDRESS, USDC_ADDRESS],
            amountInBn: amountVusdBn, minOutBn: minOut, to: wallet.address, deadlineSec: DEADLINE_SEC
          });

      logger.swap(`vUSD→USDC ${bestRev.name}`, revProfit, 'USDC');
      logger.ok(`Tx: ${rc.transactionHash}`);
    }

  } catch (e) {
    logger.err(`Błąd cyklu: ${e?.message || e}`);
    if (DEBUG && e?.stack) console.error(e.stack);
  } finally {
    logger.info(`⏱️ Koniec cyklu (${Date.now() - t0} ms)`);
    isRunning = false;
  }
}

mainOnce();
setInterval(mainOnce, CHECK_INTERVAL);

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('SIGINT', () => { console.log('\n👋 Exit'); process.exit(0); });
