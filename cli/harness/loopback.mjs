// CLI ↔ CLI loopback test: two processes, one sends a 3 MB random file,
// the other receives it and the hashes must match. Uses the local signaling
// server started by the caller.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNAL = process.env.POL_SIGNAL_URL ?? 'ws://localhost:8899/signal';
const OUT = mkdtempSync(join(tmpdir(), 'pol-cli-test-'));
const SRC = mkdtempSync(join(tmpdir(), 'pol-cli-test-src-'));
const FILE = join(SRC, 'cli-test.bin');
const SIZE = 3 * 1024 * 1024;

const payload = randomBytes(SIZE);
writeFileSync(FILE, payload);
const sha = createHash('sha256').update(payload).digest('hex');
console.log('payload:', SIZE, 'bytes, sha', sha.slice(0, 16) + '…');

const sender = spawn(
  process.execPath,
  [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'cli/pol.ts', 'send', FILE],
  { cwd: process.cwd(), env: { ...process.env, POL_SIGNAL_URL: SIGNAL } },
);

let code = '';
let senderOut = '';
sender.stdout.on('data', (chunk) => {
  senderOut += String(chunk);
  const match = /کد: (\S+ \S+ \S+ \S+)/.exec(senderOut);
  if (match && !code) {
    code = match[1];
    console.log('code from sender:', code);
    const rx = spawn(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'cli/pol.ts', 'receive', ...code.split(' ')],
      { cwd: process.cwd(), env: { ...process.env, POL_SIGNAL_URL: SIGNAL, POL_OUT: OUT } },
    );
    let rxOut = '';
    rx.stdout.on('data', (c) => {
      rxOut += String(c);
    });
    rx.stderr.on('data', (c) => {
      process.stderr.write(`[rx] ${String(c)}`);
    });
    rx.on('exit', (exitCode) => {
      console.log('receiver exit:', exitCode);
      console.log(rxOut.trim().split('\n').slice(-3).join('\n'));
      try {
        const got = readFileSync(join(OUT, 'cli-test.bin'));
        const gotSha = createHash('sha256').update(got).digest('hex');
        console.log('received sha:', gotSha.slice(0, 16) + '…');
        console.log(gotSha === sha ? 'CLI ↔ CLI PASS' : 'CLI ↔ CLI FAIL: hash mismatch');
      } catch (error) {
        console.log('CLI ↔ CLI FAIL: file missing', error);
      }
      sender.kill();
      rmSync(OUT, { recursive: true, force: true });
      process.exit(exitCode === 0 ? 0 : 1);
    });
  }
});
sender.stderr.on('data', (c) => {
  process.stderr.write(`[tx] ${String(c)}`);
});

setTimeout(() => {
  console.log('TIMEOUT — sender output:\n', senderOut);
  sender.kill();
  process.exit(1);
}, 60_000);
