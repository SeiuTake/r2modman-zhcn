// cdp-eval.mjs — evaluate an expression in the running r2modman renderer and print the result.
// Usage: node verify/cdp-eval.mjs <file-with-expression> [port]

import fs from 'node:fs';

const exprFile = process.argv[2];
const port = Number(process.argv[3] ?? 9222);
const expression = fs.readFileSync(exprFile, 'utf8');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

const result = await new Promise((resolve, reject) => {
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== 1) return;
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else if (msg.result.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text));
    else resolve(msg.result.result.value);
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }));
  setTimeout(() => reject(new Error('timeout')), 20000);
});

console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
ws.close();
