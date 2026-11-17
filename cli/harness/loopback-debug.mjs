// CLI↔CLI loopback fails: the receiver writes an empty file. The message flow
// shows 'هش نمی‌خواند ... دریافتی e3b0c442...' = SHA-256 of EMPTY input. So the
// receiver's binary handler never ran, or ran before meta. Debug with traces:
// print every control + first binaries from both processes.
const { spawn } = await import('node:child_process');
const { createHash, randomBytes } = await import('node:crypto');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const SIGNAL = 'ws://localhost:8899/signal';
const OUT = mkdtempSync(join(tmpdir(), 'pol-cli-lb2-'));
const SRC = mkdtempSync(join(tmpdir(), 'pol-cli-lb2-src-'));
const FILE = join(SRC, 'lb.bin');
const SIZE = 1024 * 1024;
const payload = randomBytes(SIZE);
writeFileSync(FILE, payload);
const sha = createHash('sha256').update(payload).digest('hex');
console.log('sha:', sha.slice(0, 16));

const sender = spawn(
  process.execPath,
  [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'cli/pol.ts', 'send', FILE],
  { cwd: process.cwd(), env: { ...process.env, POL_SIGNAL_URL: SIGNAL } },
);
let senderOut = '';
let spawned = false;
sender.stdout.on('data', (c) => {
  senderOut += String(c);
  process.stdout.write(`[tx] ${c}`);
  const match = /کد: (\S+ \S+ \S+ \S+)/.exec(senderOut);
  if (match && !spawned) {
    spawned = true;
    const code = match[1];
    const rx = spawn(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'cli/pol.ts', 'receive', ...code.split(' ')],
      { cwd: process.cwd(), env: { ...process.env, POL_SIGNAL_URL: SIGNAL, POL_OUT: OUT } },
    );
    rx.stdout.on('data', (c) => process.stdout.write(`[rx] ${c}`));
    rx.stderr.on('data', (c) => process.stderr.write(`[rx-err] ${c}`));
    rx.on('exit', (exitCode) => {
      console.log('[rx] exit', exitCode);
      try {
        const got = readFileSync(join(OUT, 'lb.bin'));
        console.log('file size on disk:', got.length, 'of', SIZE);
        const gotSha = createHash('sha256').update(got).digest('hex');
        console.log('disk sha:', gotSha.slice(0, 16), gotSha === sha ? 'MATCH' : 'DIFF');
      } catch (error) {
        console.log('no file:', String(error).slice(0, 80));
      }
      sender.kill();
      rmSync(OUT, { recursive: true, force: true });
      process.exit(0);
    });
  }
});
sender.stderr.on('data', (c) => process.stderr.write(`[tx-err] ${c}`));
setTimeout(() => {
  console.log('TIMEOUT');
  sender.kill();
  process.exit(1);
}, 60_000);
