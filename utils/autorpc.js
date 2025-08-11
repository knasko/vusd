import axios from "axios";
import { performance } from "perf_hooks";
import { logger } from "./logger.js";

function parseList(env) {
  return (env || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

async function testHttpRpc(url) {
  const start = performance.now();
  try {
    await axios.post(url, { jsonrpc:"2.0", id:1, method:"eth_blockNumber", params:[] }, { timeout: 4000 });
    const ms = Math.round(performance.now() - start);
    return { url, ok:true, ms };
  } catch {
    return { url, ok:false, ms:Infinity };
  }
}

export async function selectRpc() {
  const fallback = process.env.RPC_URL || "https://mainnet.zkevm.cronos.org";
  const useAuto = (process.env.AUTORPC || '0') === '1';
  const list = parseList(process.env.HTTP_RPC_LIST) || [];
  if (!useAuto || list.length === 0) {
    logger.info(`AUTORPC=0 → używam RPC_URL: ${fallback}`);
    return fallback;
  }

  logger.info("🔍 Testuję endpointy RPC...");
  const results = await Promise.all(list.map(testHttpRpc));
  const best = results.filter(r => r.ok).sort((a,b)=>a.ms-b.ms)[0];

  const chosen = best?.url || fallback;
  logger.line(`🏆 Wybrano RPC: ${chosen}`);
  return chosen;
}
