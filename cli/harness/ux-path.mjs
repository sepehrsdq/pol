// End-to-end user-path test: exactly what the user typed, from a neutral cwd.
// Terminal A: npm run cli send <file>  (with POL_SIGNAL_URL pointed at the test server)
// Terminal B: npm run cli receive <code>
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNAL = process.env.POL_SIGNAL_URL ?? 'ws://localhost:8787/signal';
const SRC = mkdtempSync(join(tmpdir(), 'pol-ux-src-'));
const OUT = mkdtempSync(join(tmpdir(), 'pol-ux-out-'));
const FILE = join(SRC, 'report.pdf');
const SIZE = 1024 * 1024;

const payload = randomBytes(SIZE);
writeFileSync(FILE, payload);
const sha = createHash('sha256').update(payload).digest('hex');
console.log('test file:', SIZE, 'bytes, sha', sha.slice(0, 16) + '…');
console.log('signal:', SIGNAL);

const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sender = spawn(process.execPath, [tsx, 'cli/pol.ts', 'send', FILE], {
  cwd: process.cwd(),
  env: { ...process.env, POL_SIGNAL_URL: SIGNAL },
});
let senderOut = '';
let spawned = false;
let rx = null;

sender.stdout.on('data', (c) => {
  senderOut += String(c);
  process.stdout.write(`[A-send] ${c}`);
  const match = /کد: (\S+ \S+ \S+ \S+)/.exec(senderOut);
  if (match && !spawned) {
    spawned = true;
    const code = match[1];
    rx = spawn(process.execPath, [tsx, 'cli/pol.ts', 'receive', ...code.split(' ')], {
      cwd: process.cwd(),
      env: { ...process.env, POL_SIGNAL_URL: SIGNAL, POL_OUT: OUT },
    });
    rx.stdout.on('data', (c) => process.stdout.write(`[B-recv] ${c}`));
    rx.stderr.on('data', (c) => process.stderr.write(`[B-err] ${c}`));
    rx.on('exit', (exitCode) => {
      console.log(`[B-recv] exit: ${exitCode}`);
      try {
        const got = readFileSync(join(OUT, 'report.pdf'));
        const gotSha = createHash('sha256').update(got).digest('hex');
        const ok = gotSha === sha && got.length === SIZE;
        console.log(`received: ${got.length} bytes, sha ${gotSha.slice(0, 16)}… → ${ok ? 'OK' : 'MISMATCH'}`);
      } catch (error) {
        console.log('received file missing:', String(error).slice(0, 80));
      }
      sender.kill();
      try {
        rmSync(SRC, { recursive: true, force: true });
        rmSync(OUT, { recursive: true, force: true });
      } catch {
        /* locked */
      }
      process.exit(exitCode === 0 ? 0 : 1);
    });
  }
});
sender.stderr.on('data', (c) => process.stderr.write(`[A-err] ${c}`));
setTimeout(() => {
  console.log('TIMEOUT');
  sender.kill();
  rx?.kill();
  process.exit(1);
}, 90_000);
