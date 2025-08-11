const ts = () => new Date().toISOString().replace('T',' ').replace('Z','');
const asLine = (msg) => `${ts()} ${msg}`;

let useStatus = (process.env.STATUS_LINE || '0') === '1';
let lastLen = 0;

function printLine(s) {
  if (!useStatus) return console.log(asLine(s));
  const str = asLine(s);
  process.stdout.write('\r' + str.padEnd(Math.max(lastLen, str.length), ' '));
  lastLen = str.length;
}

export const logger = {
  info: (m) => printLine(`ℹ️  ${m}`),
  ok:   (m) => { if (useStatus) process.stdout.write('\n'); console.log(asLine(`✅ ${m}`)); },
  warn: (m) => { if (useStatus) process.stdout.write('\n'); console.log(asLine(`⚠️  ${m}`)); },
  err:  (m) => { if (useStatus) process.stdout.write('\n'); console.log(asLine(`🛑 ${m}`)); },
  line: (m) => { if (useStatus) process.stdout.write('\n'); console.log(asLine(m)); },
  swap: (name, profit) => { if (useStatus) process.stdout.write('\n'); console.log(asLine(`🚀 Swap przez ${name} | zysk≈ ${profit.toFixed(6)} vUSD`)); },
  quote:(name, out, profit) => console.log(asLine(`🔎 ${name}: ${out.toFixed(6)} vUSD (zysk: ${profit.toFixed(6)})`)),
  enableStatusLine: (on=true) => { useStatus = !!on; }
};
