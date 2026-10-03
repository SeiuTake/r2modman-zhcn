// capture-ui.mjs — drive the *running* r2modman through the Chrome DevTools Protocol
// to prove on screen that the injected locale works, and save screenshots.
//
// Usage: node verify/capture-ui.mjs <outDir> [port]
//
// Requires r2modman to be running with --remote-debugging-port=<port>.

import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? 'work/ui');
const port = Number(process.argv[3] ?? 9222);
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`no DevTools page target on port ${port}`);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    });
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = cdp.pending.get(msg.id);
      if (p) { cdp.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async click(x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(60);
    }
  }
  async hover(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(500);
  }
}

const page = await findPage();
console.log(`target  : ${page.title}  ${page.url}`);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

// wait for the renderer to paint visible content
let booted = false;
for (let i = 0; i < 60; i++) {
  const body = await cdp.eval(`document.body.innerText.trim().length`);
  if (body > 20) { booted = true; break; }
  await sleep(500);
}
console.log(`booted  : ${booted}`);
await sleep(2500);

const report = {};

report.localeButtons = await cdp.eval(`(() => {
  const btns = [...document.querySelectorAll('button.activity-bar__action, .activity-bar__action')];
  return btns.map(b => ({ label: b.getAttribute('aria-label'), title: b.title, text: (b.innerText||'').trim() }));
})()`);

report.visibleText = await cdp.eval(`document.body.innerText.split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 30)`);
report.htmlLang = await cdp.eval(`document.documentElement.lang`);

// ---- screenshot 1: whatever the app opened with
const shot1 = await cdp.shot(path.join(outDir, '01-initial.png'));
console.log(`\nshot 1  : ${shot1}`);
console.log(`html lang: ${report.htmlLang}`);
console.log('activity bar buttons: ' + JSON.stringify(report.localeButtons));
console.log('visible text:\n  ' + report.visibleText.join('\n  '));

// ---- switch to Chinese through the real activity-bar language menu
async function pickLocale(wantName) {
  // The language menu lives on the last activity-bar action button (hover-triggered).
  const box = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('.activity-bar__action')];
    const b = btns[btns.length - 1];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.getAttribute('aria-label') };
  })()`);
  if (!box) return { ok: false, why: 'no activity-bar action button' };

  // floating-vue opens the popper on hover; nudge the pointer away first so the
  // enter transition always fires, then wait for the items to become visible.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });
  await sleep(300);
  await cdp.hover(box.x, box.y);

  let items = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    items = await cdp.eval(`(() => {
      const list = [...document.querySelectorAll('.locale-list__item')];
      return list.map(li => {
        const r = li.getBoundingClientRect();
        return { text: li.innerText.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }).filter(i => i.w > 0 && i.h > 0);
    })()`);
    if (items.length) break;
    await sleep(400);
  }
  const item = items.find((i) => i.text.includes(wantName));
  if (!item) return { ok: false, why: `menu items: ${JSON.stringify(items.map(i => i.text))}`, hoverLabel: box.label };

  await cdp.click(item.x, item.y);
  await sleep(1200);
  return { ok: true, clicked: item.text, hoverLabel: box.label, items: items.map((i) => i.text) };
}

const before = await cdp.eval(`(() => {
  const btns = [...document.querySelectorAll('.activity-bar__action')];
  return btns.map(b => b.getAttribute('aria-label'));
})()`);

const pick = await pickLocale('简体中文');
report.pickZh = pick;
console.log(`\npick 简体中文: ` + JSON.stringify(pick));

await sleep(1500);
const after = await cdp.eval(`(() => {
  const btns = [...document.querySelectorAll('.activity-bar__action')];
  return btns.map(b => b.getAttribute('aria-label'));
})()`);
report.localeBefore = before;
report.localeAfter = after;
console.log(`aria-labels before: ${JSON.stringify(before)}`);
console.log(`aria-labels after : ${JSON.stringify(after)}`);

report.zhVisibleText = await cdp.eval(`document.body.innerText.split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 40)`);
const shot2 = await cdp.shot(path.join(outDir, '02-chinese.png'));
console.log(`\nshot 2  : ${shot2}`);
console.log('visible text after switching:\n  ' + report.zhVisibleText.join('\n  '));

// Also capture the language list itself open.
if (pick.ok) {
  const box = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('.activity-bar__action')];
    const b = btns[btns.length - 1];
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await cdp.hover(box.x, box.y);
  await sleep(800);
  const shot3 = await cdp.shot(path.join(outDir, '03-language-menu.png'));
  console.log(`shot 3  : ${shot3}  (language menu open)`);
  report.menuItems = await cdp.eval(`[...document.querySelectorAll('.locale-list__item')].map(li => li.innerText.trim())`);
  console.log('menu items: ' + JSON.stringify(report.menuItems));
}

// Navigate to Settings to capture a dense Chinese screen too.
const nav = await cdp.eval(`(() => {
  const links = [...document.querySelectorAll('a, button')];
  const t = links.find(e => (e.innerText||'').trim() === '设置' || (e.getAttribute('title')||'') === '设置');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2, text: t.innerText.trim() };
})()`);
if (nav) {
  await cdp.click(nav.x, nav.y);
  await sleep(2500);
  const shot4 = await cdp.shot(path.join(outDir, '04-settings-zh.png'));
  console.log(`shot 4  : ${shot4}  (settings page)`);
  report.settingsText = await cdp.eval(`document.body.innerText.split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 60)`);
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\nreport  : ${path.join(outDir, 'report.json')}`);
cdp.ws.close();
