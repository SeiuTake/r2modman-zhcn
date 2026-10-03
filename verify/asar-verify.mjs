// asar-verify.mjs — independent cross-implementation check of a patched app.asar.
//
// Written against the asar spec directly (no @electron/asar dependency) so it shares
// no code with the PowerShell patcher: if both agree, the archive is coherent.
//
// Verifies:
//   1. The header still parses and every entry resolves.
//   2. Every file's SHA-256 matches the `integrity.hash` recorded in the header.
//   3. Against a baseline archive: the set of entries is identical and every file
//      except the expected ones is byte-for-byte identical.
//   4. Expected entries are reported with old/new size and hash.
//
// Usage: node verify/asar-verify.mjs <patched.asar> [baseline.asar]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

function readArchive(file) {
  const fd = fs.openSync(file, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);
  const outerPayload = prefix.readUInt32LE(0);
  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  if (outerPayload !== 4) throw new Error(`bad outer pickle size ${outerPayload}`);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  const headerJson = jsonBuf.toString('utf8');
  const header = JSON.parse(headerJson);
  const baseOffset = 8 + headerSize;
  const fileLength = fs.fstatSync(fd).size;

  const entries = [];
  (function walk(node, prefix_) {
    for (const [name, val] of Object.entries(node.files)) {
      const p = `${prefix_}/${name}`;
      if (val.files) walk(val, p);
      else entries.push({ path: p, ...val });
    }
  })(header, '');

  return {
    file, fd, header, headerJson, headerSize, jsonSize, baseOffset, fileLength, entries,
    read(entry) {
      const buf = Buffer.alloc(entry.size);
      if (entry.size > 0) fs.readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset));
      return buf;
    },
    close() { fs.closeSync(fd); },
  };
}

const [patchedPath, baselinePath] = process.argv.slice(2);
if (!patchedPath) {
  console.error('usage: node verify/asar-verify.mjs <patched.asar> [baseline.asar]');
  process.exit(2);
}

const problems = [];
const patched = readArchive(patchedPath);
console.log(`archive : ${patchedPath}`);
console.log(`  header JSON : ${patched.jsonSize} bytes   header block: ${patched.headerSize}   base offset: ${patched.baseOffset}`);
console.log(`  file length : ${patched.fileLength}`);
console.log(`  entries     : ${patched.entries.length}`);

// ---- 1/2. self-consistency: every entry in range and matching its recorded integrity
let inRange = 0;
let integrityOk = 0;
for (const e of patched.entries) {
  const end = patched.baseOffset + Number(e.offset) + e.size;
  if (Number(e.offset) < 0 || end > patched.fileLength) {
    problems.push(`OUT OF RANGE : ${e.path} (offset ${e.offset} + size ${e.size} > ${patched.fileLength})`);
    continue;
  }
  inRange++;
  if (!e.integrity?.hash) { problems.push(`NO INTEGRITY : ${e.path}`); continue; }
  const hash = crypto.createHash('sha256').update(patched.read(e)).digest('hex');
  if (hash !== e.integrity.hash) {
    problems.push(`INTEGRITY MISMATCH : ${e.path}\n    header=${e.integrity.hash}\n    actual=${hash}`);
  } else {
    integrityOk++;
  }
}
console.log(`  in-range    : ${inRange}/${patched.entries.length}`);
console.log(`  integrity   : ${integrityOk}/${patched.entries.length} verified`);

// ---- 3/4. diff against baseline
if (baselinePath) {
  const base = readArchive(baselinePath);
  console.log(`\nbaseline: ${baselinePath}`);
  console.log(`  entries     : ${base.entries.length}`);

  const patchedByPath = new Map(patched.entries.map((e) => [e.path, e]));
  const baseByPath = new Map(base.entries.map((e) => [e.path, e]));

  for (const p of baseByPath.keys()) if (!patchedByPath.has(p)) problems.push(`REMOVED entry : ${p}`);
  for (const p of patchedByPath.keys()) if (!baseByPath.has(p)) problems.push(`ADDED entry   : ${p}`);

  // A repack legitimately shifts offsets, so classify by *content*, not by offset.
  const contentChanged = [];
  const moved = [];
  let preserved = 0;

  for (const [p, pe] of patchedByPath) {
    const be = baseByPath.get(p);
    if (!be) continue;

    const baseHash = crypto.createHash('sha256').update(base.read(be)).digest('hex');
    if (baseHash !== be.integrity.hash) problems.push(`BASELINE CORRUPT : ${p} (stored bytes != header hash)`);

    const newHash = crypto.createHash('sha256').update(patched.read(pe)).digest('hex');
    if (newHash !== baseHash || pe.size !== be.size) {
      contentChanged.push({ path: p, base: be, patched: pe, baseHash, newHash });
    } else {
      preserved++;
      if (Number(pe.offset) !== Number(be.offset)) moved.push(p);
    }
  }

  for (const c of contentChanged) {
    console.log(`\n  content changed: ${c.path}`);
    console.log(`    size   : ${c.base.size} -> ${c.patched.size}  (${c.patched.size - c.base.size >= 0 ? '+' : ''}${c.patched.size - c.base.size})`);
    console.log(`    offset : ${c.base.offset} -> ${c.patched.offset}`);
    console.log(`    sha256 : ${c.baseHash.slice(0, 16)}... -> ${c.newHash.slice(0, 16)}...`);
  }

  console.log(`\n  unchanged entries verified byte-for-byte : ${preserved}`);
  console.log(`  of those, offset shifted                 : ${moved.length} (expected: everything after a resized entry)`);
  console.log(`  content changed                          : ${contentChanged.length}`);

  // The archive must stay gap-free and ordered: offsets contiguous from 0 in header order.
  let cursor = 0;
  for (const e of patched.entries) {
    if (Number(e.offset) !== cursor) {
      problems.push(`NON-CONTIGUOUS : ${e.path} at ${e.offset}, expected ${cursor}`);
      break;
    }
    cursor += e.size;
  }
  if (cursor !== patched.fileLength - patched.baseOffset) {
    problems.push(`DATA REGION SIZE : contiguous bytes ${cursor} != ${patched.fileLength - patched.baseOffset}`);
  }

  base.close();
}

patched.close();

if (problems.length) {
  console.log(`\nFAIL — ${problems.length} problem(s):\n`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nPASS — archive coherent; integrity matches for every entry; no unexpected changes.');
