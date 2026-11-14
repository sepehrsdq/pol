import { buildZip } from '../src/lib/zip';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const outDir = 'C:/Users/Sepehr/AppData/Local/Temp/opencode/zip-real-test';
mkdirSync(outDir, { recursive: true });

async function materialize(entries) {
  const parts = [];
  const pending = [];
  for await (const chunk of buildZip(entries)) {
    if (chunk.kind === 'bytes') parts.push(chunk.data);
    else pending.push(chunk);
  }
  for (const patch of pending) {
    let acc = 0;
    for (const part of parts) {
      if (patch.offset < acc + part.length) {
        const dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
        dv.setUint32(patch.offset - acc, patch.value >>> 0, true);
        break;
      }
      acc += part.length;
    }
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buffer = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    buffer.set(part, cursor);
    cursor += part.length;
  }
  return buffer;
}

// Three files, varied sizes, binary content — like a real folder.
const entries = [];
const expectedHashes = new Map();
for (const [name, size] of [['a.txt', 11], ['sub/binary.bin', 300_000], ['sub/deep/last.log', 700]]) {
  const bytes = size === 11 ? new TextEncoder().encode('hello world') : randomBytes(size);
  const chunks = [];
  for (let i = 0; i < size; i += 64_000) chunks.push(bytes.subarray(i, i + 64_000));
  entries.push({
    name,
    size,
    modified: new Date(2026, 10, 14, 12, 30),
    read: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  });
  expectedHashes.set(name, createHash('sha256').update(bytes).digest('hex'));
}

const zip = await materialize(entries);
const zipPath = `${outDir}/pol-test.zip`;
writeFileSync(zipPath, zip);
console.log('zip written:', zip.length, 'bytes');

// Expand with the OS tool — the same way a user would open it.
execSync(`Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}/out' -Force`, { shell: 'powershell.exe' });

let allOk = true;
for (const [name, hash] of expectedHashes) {
  const path = `${outDir}/out/${name.replace(/\//g, '\\')}`;
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  const ok = actual === hash;
  if (!ok) allOk = false;
  console.log(ok ? 'PASS' : 'FAIL', name, statSync(path).size, 'bytes');
}
console.log(allOk ? 'REAL-UNZIP PASS' : 'REAL-UNZIP FAIL');
process.exit(allOk ? 0 : 1);
