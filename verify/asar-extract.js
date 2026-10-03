const fs = require('fs');
const path = require('path');
const asarPath = process.argv[2];
const outDir = process.argv[3];
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null;
const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const jsonSize = sizeBuf.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 8 + headerSize;
const out = [];
(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files)) {
    const full = prefix + '/' + name;
    if (val.files) walk(val, full); else out.push({ path: full, size: val.size, offset: val.offset, unpacked: !!val.unpacked });
  }
})(header, '');
for (const f of out) {
  if (filter && !filter.test(f.path)) continue;
  const dest = path.join(outDir, f.path.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (f.unpacked) continue;
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, baseOffset + Number(f.offset));
  fs.writeFileSync(dest, buf);
}
fs.closeSync(fd);
console.log('extracted', out.filter(f => !filter || filter.test(f.path)).length, 'files to', outDir);
