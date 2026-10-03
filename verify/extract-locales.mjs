// extract-locales.mjs — pull r2modman's own en-US / fr-FR message catalogues out of an
// app.asar and write them as JSON, so the verifier has a baseline to compare against.
//
// The repo deliberately does NOT ship these files: they are r2modman's own content
// (MIT, (c) ebkr) and are regenerated from the user's own installation instead.
//
// The i18n instance is created inside one of the assets chunks; that chunk imports
// vue-i18n. We locate it by signature, rewrite it into a CommonJS module with the
// import stubbed out, and require it to read the real message objects — no guessing
// at minified variable names.
//
// Usage: node verify/extract-locales.mjs <app.asar> [outDir=work]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const asarPath = process.argv[2];
const outDir = path.resolve(process.argv[3] ?? 'work');
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error(`usage: node verify/extract-locales.mjs <app.asar> [outDir]`);
  console.error(`app.asar not found: ${asarPath}`);
  process.exit(2);
}

// ---------------------------------------------------------------- minimal asar reader
const fd = fs.openSync(asarPath, 'r');
const prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, 16, 0);
const headerSize = prefix.readUInt32LE(4);
const jsonSize = prefix.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 8 + headerSize;

const entries = [];
(function walk(node, p) {
  for (const [name, val] of Object.entries(node.files)) {
    const full = `${p}/${name}`;
    if (val.files) walk(val, full);
    else entries.push({ path: full, ...val });
  }
})(header, '');

const readEntry = (e) => {
  const buf = Buffer.alloc(e.size);
  if (e.size > 0) fs.readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset));
  return buf;
};

// ------------------------------------------------------- locate the i18n chunk
const candidates = entries.filter((e) => /^\/assets\/.*\.js$/.test(e.path));
let chunk = null;
let source = null;
for (const e of candidates) {
  const text = readEntry(e).toString('utf8');
  if (text.includes(',locale:"en-US"},translations:{') &&
      text.includes('globalInjection:!0') &&
      text.includes('allowComposition:!0')) {
    chunk = e;
    source = text;
    break;
  }
}
fs.closeSync(fd);

if (!chunk) {
  console.error('could not locate the i18n chunk in this app.asar (unsupported version?)');
  process.exit(3);
}
console.log(`i18n chunk : ${chunk.path} (${chunk.size} bytes)`);

// ------------------------------------------------- rewrite to CommonJS and require
// The chunk has exactly one import (vue-i18n) and one export (the i18n instance).
// A stub that implements just enough of the composer that the chunk — and, when run
// against an already-patched archive, the injected setLocaleMessage call — both work.
// setLocaleMessage writes into the same messages object, so the injected zh catalogue
// shows up in the dump exactly as it would at runtime.
const STUB = `
var o = (options) => {
  var messages = options.messages || (options.messages = {});
  var datetimeFormats = options.datetimeFormats || (options.datetimeFormats = {});
  return Object.assign({}, options, {
    global: {
      messages: messages,
      datetimeFormats: datetimeFormats,
      setLocaleMessage: (locale, message) => { messages[locale] = message; },
      getLocaleMessage: (locale) => messages[locale],
      setDateTimeFormat: (locale, formats) => { datetimeFormats[locale] = formats; },
      getDateTimeFormat: (locale) => datetimeFormats[locale],
    },
  });
};
`;
const importRe = /^import\s*\{[^}]*\}\s*from\s*"[^"]*";\n?/;
// The chunk is minified onto one line, so the stub must end with a newline — otherwise
// the trailing line comment would comment out everything that follows it.
let cjs = source.replace(importRe, STUB.trimStart() + '\n');
const exportRe = /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+t\s*\}\s*;?\s*$/;
const m = cjs.match(exportRe);
if (!m) {
  console.error('unexpected chunk tail: no `export{X as t}` found');
  process.exit(3);
}
cjs = cjs.replace(exportRe, `module.exports = { instance: ${m[1]} };`);

fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, '.i18n-chunk.cjs');
fs.writeFileSync(tmp, cjs, 'utf8');

const require_ = createRequire(import.meta.url);
const mod = require_(tmp);
fs.unlinkSync(tmp);

// ------------------------------------------------------------------- dump
// `messages` is keyed by short code (en, fr, zh, ...) and each value carries
// { metadata: { name, locale, wip? }, translations: {...} }.
const messages = mod.instance?.global?.messages ?? mod.instance?.messages ?? {};
const written = [];
for (const [key, value] of Object.entries(messages)) {
  if (!value?.translations) continue;
  const file = path.join(outDir, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(value.translations, null, 2), 'utf8');
  written.push({ key, file, locale: value.metadata?.locale, name: value.metadata?.name });
  const count = (function n(o) {
    let total = 0;
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) total += n(v);
      else if (Array.isArray(v)) total += v.length;
      else total += 1;
    }
    return total;
  })(value.translations);
  console.log(`  ${String(key).padEnd(4)} ${String(value.metadata?.name).padEnd(12)} ${String(value.metadata?.locale).padEnd(6)} ${String(count).padStart(4)} strings -> ${file}`);
}
if (!written.length) {
  console.error('no message catalogues found in the chunk');
  process.exit(3);
}
console.log(`\nwrote ${written.length} catalogue(s) to ${outDir}`);
console.log(`baseline for verify.mjs: ${path.join(outDir, 'en.json')}`);
