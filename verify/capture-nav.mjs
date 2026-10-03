// capture-nav.mjs — on the manager screen, click the left navigation items and capture
// the Online Mod list, Settings and Help pages in Chinese.
// Usage: node verify/capture-nav.mjs <outDir> [port]

import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? 'work/ui-nav');
const port = Number(process.argv[3] ?? 9222);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (n) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, n), Buffer.from(r.data, 'base64'));
  console.log(`  shot: ${path.join(outDir, n)}`);
};
const click = async (x, y) => {
  for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons });
    await sleep(80);
  }
};

const navTo = async (labels) => {
  const b = await evaluate(`(() => {
    const labels = ${JSON.stringify(labels)};
    const els = [...document.querySelectorAll('.menu-list a, .menu-list li, nav a, nav button, aside a')];
    for (const e of els) {
      if (!labels.includes((e.innerText || '').trim())) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: e.innerText.trim() };
    }
    return null;
  })()`);
  if (!b) { console.log(`  nav ${JSON.stringify(labels)} not found`); return false; }
  await click(b.x, b.y);
  await sleep(3500);
  return true;
};

console.log('left nav labels: ' + JSON.stringify(await evaluate(`[...document.querySelectorAll('.menu-list a, .menu-list li')].map(e => (e.innerText||'').trim()).filter(Boolean)`)));

console.log('1) Online mod list');
if (await navTo(['在线', 'Online'])) {
  const t = await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,18)`);
  console.log('   ' + JSON.stringify(t));
  await shot('30-online-mod-list-zh.png');
}

console.log('2) Settings');
if (await navTo(['设置', 'Settings'])) {
  const t = await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,22)`);
  console.log('   ' + JSON.stringify(t));
  await shot('31-settings-zh.png');
}

console.log('3) Help');
if (await navTo(['帮助', 'Help'])) {
  const t = await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,22)`);
  console.log('   ' + JSON.stringify(t));
  await shot('32-help-zh.png');
}

ws.close();
console.log('done');
