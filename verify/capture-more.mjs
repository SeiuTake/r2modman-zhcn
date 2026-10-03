// capture-more.mjs — produce a small gallery proving the localization end to end:
// language menu contents, switching to English and back, and the settings screen.
//
// Usage: node verify/capture-more.mjs <outDir> [port]

import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? 'work/ui-more');
const port = Number(process.argv[3] ?? 9222);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(outDir, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(`  shot: ${f}`);
  return f;
};
const move = (x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons });
const click = async (x, y) => {
  for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons });
    await sleep(70);
  }
};

const langButtonBox = () => evaluate(`(() => {
  const b = [...document.querySelectorAll('.activity-bar__action')].pop();
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.getAttribute('aria-label') };
})()`);

async function openMenu() {
  const box = await langButtonBox();
  await move(5, 5);
  await sleep(300);
  await move(box.x, box.y);
  for (let i = 0; i < 15; i++) {
    const n = await evaluate(`[...document.querySelectorAll('.locale-list__item')].filter(e => e.getBoundingClientRect().width > 0).length`);
    if (n > 0) return box;
    await sleep(300);
  }
  return box;
}

const menuItems = () => evaluate(`[...document.querySelectorAll('.locale-list__item')]
  .filter(e => e.getBoundingClientRect().width > 0)
  .map(e => { const r = e.getBoundingClientRect(); return { text: e.innerText.replace(/\\s+/g,' ').trim(), x: r.x + r.width/2, y: r.y + r.height/2 }; })`);

console.log('1) language menu contents');
await openMenu();
await sleep(600);
const items = await menuItems();
console.log('   items: ' + JSON.stringify(items.map((i) => i.text)));
await shot('10-language-menu.png');

console.log('2) switch to English');
const en = items.find((i) => i.text.includes('English'));
await click(en.x, en.y);
await sleep(1500);
console.log('   current locale label: ' + (await langButtonBox()).label);
await shot('11-english.png');

console.log('3) switch back to 简体中文');
const items2 = await (async () => { await openMenu(); await sleep(600); return menuItems(); })();
const zh = items2.find((i) => i.text.includes('简体中文'));
await click(zh.x, zh.y);
await sleep(1500);
console.log('   current locale label: ' + (await langButtonBox()).label);

console.log('4) open the Settings screen');
const settingsLink = await evaluate(`(() => {
  const els = [...document.querySelectorAll('a, button')];
  const t = els.find(e => ['设置','Settings'].includes((e.innerText || '').trim()));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2, text: t.innerText.trim() };
})()`);
if (settingsLink) {
  await click(settingsLink.x, settingsLink.y);
  await sleep(3000);
  const head = await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0, 25)`);
  console.log('   settings text: ' + JSON.stringify(head));
  await shot('12-settings-zh.png');
} else {
  console.log('   settings link not found on this screen');
}

console.log('5) dependency/troubleshooting dense screen: mod list');
const navBack = await evaluate(`(() => {
  const els = [...document.querySelectorAll('a, button')];
  const t = els.find(e => ['返回选择游戏','Back to game selection'].includes((e.innerText || '').trim()));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2 };
})()`);
if (navBack) { await click(navBack.x, navBack.y); await sleep(2000); }

ws.close();
console.log('done');
