// utils/logger.js
// Prosty logger z opcjonalnym "status-line" (jedna nadpisywana linia).
// Włącz przez ENV: STATUS_LINE=1

const ts = () =>
  new Date().toISOString().replace('T', ' ').replace('Z', '');

const asLine = (msg) => `${ts()} ${msg}`;

let useStatus = (process.env.STATUS_LINE || '0') === '1';
let lastLen = 0; // długość ostatniej status-linii

function writeStatus(msg) {
  if (!useStatus) {
    console.log(asLine(msg));
    return;
  }
  const str = asLine(msg);
  const padLen = Math.max(lastLen - str.length, 0);
  process.stdout.write('\r' + str + ' '.repeat(padLen));
  lastLen = Math.max(lastLen, str.length);
}

function clearStatus() {
  if (!useStatus || lastLen === 0) return;
  process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
  lastLen = 0;
}

function to6(v) {
  if (typeof v === 'bigint') return v.toString();
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(6) : String(v);
}

export const logger = {
  // lekkie info – w trybie STATUS_LINE nadpisuje jedną linię
  info: (m) => writeStatus(`ℹ️  ${m}`),

  // twarde linie – zawsze w nowej linii
  line: (m) => { clearStatus(); console.log(asLine(m)); },
  ok:   (m) => { clearStatus(); console.log(asLine(`✅ ${m}`)); },
  warn: (m) => { clearStatus(); console.log(asLine(`⚠️  ${m}`)); },
  err:  (m) => { clearStatus(); console.log(asLine(`🛑 ${m}`)); },

  // log porównania ofert – podaj jednostkę (domyślnie 'vUSD')
  quote: (name, out, profit, unit = 'vUSD') => {
    clearStatus();
    console.log(asLine(`🔎 ${name}: ${to6(out)} ${unit} (zysk: ${to6(profit)} ${unit})`));
  },

  // log wykonania swapa – podaj jednostkę (domyślnie 'vUSD')
  swap: (name, profit, unit = 'vUSD') => {
    clearStatus();
    console.log(asLine(`🚀 Swap przez ${name} | zysk≈ ${to6(profit)} ${unit}`));
  },

  // włącz/wyłącz status-line w runtime (np. z kodu)
  enableStatusLine: (on = true) => { useStatus = !!on; }
};
