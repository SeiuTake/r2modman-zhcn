// capture-manager.mjs — drive into a game/profile so the Settings and Help screens
// can be captured in Chinese (they are the densest text surfaces in the app).
//
// Usage: node verify/capture-manager.mjs <outDir> [port] [gameName]

import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? 'work/ui-manager');
const port = Number(process.argv[3] ?? 9222);
const wantGame = process.argv[4] ?? 'R.E.P.O.';
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
};
const click = async (x, y) => {
  for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons });
    await sleep(70);
  }
};

// Find a clickable element whose visible text matches `text`, optionally inside a card
// whose text contains `near`.
const findClickable = (text, near) => evaluate(`(() => {
  const near = ${JSON.stringify(near ?? null)};
  const text = ${JSON.stringify(text)};
  const els = [...document.querySelectorAll('a, button, .card, [role="button"]')];
  for (const e of els) {
    const t = (e.innerText || '').trim();
    if (!t.includes(text)) continue;
    if (near) {
      const card = e.closest('.game-card, .card, li, .column');
      if (!card || !card.innerText.includes(near)) continue;
    }
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: e.tagName, text: t.slice(0, 60) };
  }
  return null;
})()`);

// The game title lives in .game-card-wrapper__footer, a sibling of .game-card, so the
// lookup has to go through the shared .game-card-wrapper ancestor. The action buttons
// are inside an overlay that only appears on hover.
const hoverCard = async (name) => {
  const b = await evaluate(`(() => {
    const p = [...document.querySelectorAll('.game-card-wrapper__footer p')]
      .find(e => (e.textContent || '').trim() === ${JSON.stringify(name)});
    const wrap = p && p.closest('.game-card-wrapper');
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!b) return null;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, buttons: 0 });
  await sleep(900);
  return b;
};

const cardButton = (name, label) => evaluate(`(() => {
  const p = [...document.querySelectorAll('.game-card-wrapper__footer p')]
    .find(e => (e.textContent || '').trim() === ${JSON.stringify(name)});
  const wrap = p && p.closest('.game-card-wrapper');
  if (!wrap) return null;
  const btn = [...wrap.querySelectorAll('button, a')]
    .find(e => (e.innerText || '').trim().includes(${JSON.stringify(label)}));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (btn.innerText || '').trim() };
})()`);

console.log('screen text now: ' + JSON.stringify((await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,8)`))));

console.log(`1) select game "${wantGame}"`);
await hoverCard(wantGame);
const sel = await cardButton(wantGame, '选择游戏');
console.log('   found: ' + JSON.stringify(sel));
if (!sel) { console.log('   aborting'); ws.close(); process.exit(1); }
await click(sel.x, sel.y);
await sleep(3000);
console.log('   now: ' + JSON.stringify((await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,10)`))));
await shot('20-profile-selection.png');

console.log('2) choose the first profile');
const prof = await findClickable('选择');
console.log('   found: ' + JSON.stringify(prof));
if (prof) { await click(prof.x, prof.y); await sleep(6000); }
console.log('   now: ' + JSON.stringify((await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,14)`))));
await shot('21-manager-zh.png');

console.log('3) Settings screen');
const settings = await evaluate(`(() => {
  const els = [...document.querySelectorAll('a, button, .menu-list li a, [role="button"]')];
  const t = els.find(e => ['设置','Settings'].includes((e.innerText || '').trim()));
  if (!t) return null; const r = t.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2 };
})()`);
if (settings) {
  await click(settings.x, settings.y);
  await sleep(3500);
  console.log('   settings: ' + JSON.stringify((await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,30)`))));
  await shot('22-settings-zh.png');
} else { console.log('   settings nav not found'); }

console.log('4) Help screen');
const help = await evaluate(`(() => {
  const els = [...document.querySelectorAll('a, button, [role="button"]')];
  const t = els.find(e => ['帮助','Help'].includes((e.innerText || '').trim()));
  if (!t) return null; const r = t.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2 };
})()`);
if (help) {
  await click(help.x, help.y);
  await sleep(2500);
  console.log('   help: ' + JSON.stringify((await evaluate(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,24)`))));
  await shot('23-help-zh.png');
} else { console.log('   help nav not found'); }

ws.close();
console.log('done');
