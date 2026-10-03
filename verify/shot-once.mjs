// shot-once.mjs — connect to a running r2modman and take a single screenshot.
// Usage: node verify/shot-once.mjs <outFile> [port]

import fs from 'node:fs';
import path from 'node:path';

const outFile = path.resolve(process.argv[2] ?? 'work/shot.png');
const port = Number(process.argv[3] ?? 9222);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
for (let i = 0; i < 60 && !page; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  } catch { /* not up yet */ }
  if (!page) await sleep(500);
}
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value;

await send('Page.enable');
for (let i = 0; i < 60; i++) {
  if ((await evaluate('document.body.innerText.trim().length')) > 20) break;
  await sleep(500);
}
await sleep(2500);

const info = {
  locale: await evaluate(`(() => { const b = [...document.querySelectorAll('.activity-bar__action')].pop(); return b && b.getAttribute('aria-label'); })()`),
  text: await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,12)`),
};
const r = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(outFile, Buffer.from(r.data, 'base64'));
console.log(`locale : ${info.locale}`);
console.log(`text   : ${JSON.stringify(info.text)}`);
console.log(`saved  : ${outFile}`);
ws.close();
