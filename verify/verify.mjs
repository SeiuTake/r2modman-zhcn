// verify.mjs — structural verification of pack/locale/zh-CN.json against the en-US baseline.
//
// Checks performed:
//   1. Key-tree parity: every leaf path in en exists in zh and vice versa.
//   2. Value-kind parity (string vs array).
//   3. Array length parity (searchTerms).
//   4. Placeholder parity: identical multiset of {...} tokens per message.
//   5. Plural parity: same number of top-level `|` variants per message.
//   6. Linked-message parity: identical set of @: / @.modifier: references.
//   7. Coverage: every `translations.*` key literal used by the app bundles resolves in zh.
//
// Usage: node verify/verify.mjs [--baseline work/en.json] [--lang pack/locale/zh-CN.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const baselinePath = path.resolve(ROOT, arg('--baseline', 'work/en.json'));
const langPath = path.resolve(ROOT, arg('--lang', 'pack/locale/zh-CN.json'));
const assetsDir = path.resolve(ROOT, arg('--assets', 'work/dist/assets'));

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const langFile = JSON.parse(fs.readFileSync(langPath, 'utf8'));
const lang = langFile.translations;

const problems = [];
const notes = [];

// ---------------------------------------------------------------- key walking
function leaves(obj, prefix = '') {
  const out = new Map();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
    } else {
      out.set(key, v);
    }
  }
  return out;
}

const enLeaves = leaves(baseline);
const zhLeaves = leaves(lang);

for (const k of enLeaves.keys()) if (!zhLeaves.has(k)) problems.push(`MISSING key   : ${k}`);
for (const k of zhLeaves.keys()) if (!enLeaves.has(k)) problems.push(`EXTRA key     : ${k}`);

// ------------------------------------------------------- per-message analysis
// vue-i18n tokens we must preserve byte-for-byte:
//   {...}  interpolation / literal placeholder (including the `{''}` literal form)
//   @:key  and  @.modifier:key   linked messages
const tokenRe = /\{[^{}]*\}|@[.:][A-Za-z0-9_.]+/g;

function tokens(s) {
  return (s.match(tokenRe) ?? []).sort();
}

// Split on top-level `|` (vue-i18n plural separator). Escaped pipes (\|) are rare
// but handled; braces are balanced inside placeholders so they cannot contain a pipe.
function pluralVariants(s) {
  return s.split(/(?<!\\)\|/);
}

let checkedMessages = 0;
let totalChars = 0;

for (const [k, enVal] of enLeaves) {
  const zhVal = zhLeaves.get(k);
  if (zhVal === undefined) continue;

  if (Array.isArray(enVal)) {
    if (!Array.isArray(zhVal)) {
      problems.push(`KIND mismatch : ${k} (en array, zh ${typeof zhVal})`);
      continue;
    }
    if (enVal.length !== zhVal.length) {
      problems.push(`ARRAY length  : ${k} (en ${enVal.length}, zh ${zhVal.length})`);
    }
    enVal.forEach((v, i) => {
      const t = zhVal[i];
      if (typeof t !== 'string') { problems.push(`ARRAY kind    : ${k}[${i}]`); return; }
      const a = JSON.stringify(tokens(v)), b = JSON.stringify(tokens(t));
      if (a !== b) problems.push(`ARRAY tokens  : ${k}[${i}]\n    en=${a}\n    zh=${b}`);
    });
    continue;
  }

  if (typeof enVal === 'string') {
    if (typeof zhVal !== 'string') { problems.push(`KIND mismatch : ${k}`); continue; }
    checkedMessages++;
    totalChars += zhVal.length;

    const a = JSON.stringify(tokens(enVal)), b = JSON.stringify(tokens(zhVal));
    if (a !== b) problems.push(`TOKENS differ : ${k}\n    en=${a}\n    zh=${b}`);

    const pvEn = pluralVariants(enVal).length, pvZh = pluralVariants(zhVal).length;
    if (pvEn !== pvZh) {
      problems.push(`PLURAL count  : ${k} (en ${pvEn} variants, zh ${pvZh})`);
    }
    if (zhVal.trim() === '') problems.push(`EMPTY value   : ${k}`);
    if (zhVal !== zhVal.trim()) problems.push(`UNTRIMMED     : ${k} (${JSON.stringify(zhVal.slice(0, 20))}...)`);
    if (/\\n|\n/.test(zhVal)) problems.push(`NEWLINE in zh : ${k}`);
  }
}

// ------------------------------------------------- key usage coverage in bundles
function resolve(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const usedKeys = new Set();
let scannedFiles = 0;
if (fs.existsSync(assetsDir)) {
  // `translations.` and `metadata.` string literals are how the bundled app refers
  // to message keys (including the dynamically-indexed searchTerms arrays).
  const keyLitRe = /"((?:translations|metadata)\.[A-Za-z0-9_.]+)"/g;
  for (const f of fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(assetsDir, f), 'utf8');
    scannedFiles++;
    let m;
    while ((m = keyLitRe.exec(src)) !== null) usedKeys.add(m[1]);
  }
}

const missingInZh = [];
for (const k of [...usedKeys].sort()) {
  if (k === 'metadata.name' || k === 'metadata.wip') continue;
  if (!k.startsWith('translations.')) continue;
  const dotted = k.slice('translations.'.length);
  if (resolve(lang, dotted) === undefined) missingInZh.push(k);
}

// Also confirm the same keys resolve in the baseline, so a "missing in zh" hit is
// genuinely a translation gap rather than a stale key in the bundle.
const missingInEnToo = missingInZh.filter((k) => resolve(baseline, k.slice('translations.'.length)) === undefined);

for (const k of missingInZh) {
  if (resolve(baseline, k.slice('translations.'.length)) !== undefined) problems.push(`COVERAGE gap  : ${k}`);
}

// ---------------------------------------------------------------------- report
console.log(`baseline : ${path.relative(ROOT, baselinePath)}  (${enLeaves.size} leaves)`);
console.log(`language : ${path.relative(ROOT, langPath)}  (${zhLeaves.size} leaves)  name="${langFile.metadata?.name}" locale="${langFile.metadata?.locale}"`);
console.log(`bundles  : ${scannedFiles} files scanned, ${usedKeys.size} distinct key literals, ${missingInZh.length} unresolved in zh`);
console.log(`messages : ${checkedMessages} strings, ${totalChars} chars`);
if (missingInEnToo.size) notes.push(`${missingInEnToo.size} bundle key(s) absent from the en baseline too (keys built at runtime) — not counted as gaps`);

if (notes.length) console.log('\nnotes:\n  ' + notes.join('\n  '));

if (problems.length) {
  console.log(`\nFAIL — ${problems.length} problem(s):\n`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nPASS — key tree, placeholders, plurals, linked messages and bundle coverage all consistent.');
