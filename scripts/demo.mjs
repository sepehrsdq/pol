/**
 * Record the README demo: one real transfer, both sides, in one frame.
 *
 *   npm run build && npm run demo
 *
 * Starts a private signaling server and opens one page with two iframes —
 * 127.0.0.1 and localhost are different origins, so each side gets its own
 * storage while the server still shares one room namespace. One video, both
 * peers, no post-composite alignment to get wrong.
 *
 * Needs a normal ffmpeg with GIF support (palettegen/hstack):
 *   FFMPEG=/path/to/ffmpeg npm run demo
 *   winget install Gyan.FFmpeg | brew install ffmpeg | apt install ffmpeg
 *
 * The file is generated in the page, so the demo needs no fixture and no
 * network beyond the local server.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.POL_DEMO_PORT ?? 8910);
const HARNESS_PORT = PORT + 1;
const APP_A = `http://127.0.0.1:${PORT}/?debug=1`;
const APP_B = `http://localhost:${PORT}/?debug=1`;
const WIDTH = 1280;
const HEIGHT = 800;
const FILE_NAME = 'گزارش-سالانه.pdf';
const FILE_SIZE = 12 * 1024 * 1024;
const OUT_GIF = join('docs', 'demo.gif');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ffmpeg() {
  // Playwright's bundled ffmpeg is a cut-down build without palettegen, so the
  // demo needs a normal one: FFMPEG=/path/to/ffmpeg or ffmpeg on PATH.
  return process.env.FFMPEG || 'ffmpeg';
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${exe} exited ${code}\n${err.slice(-1600)}`));
    });
  });
}

async function waitFor(frame, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await frame.evaluate(predicate)) return;
    } catch {
      /* frame may be navigating */
    }
    await sleep(120);
  }
  const state = await frame
    .evaluate(() => ({
      url: location.href,
      ready: document.readyState,
      hasFile: Boolean(document.getElementById('file')),
      hasInput: Boolean(document.getElementById('code-input')),
      body: document.body?.textContent?.trim().slice(0, 120) ?? '',
    }))
    .catch((error) => ({ evalError: String(error).slice(0, 120) }));
  throw new Error(`${label} never happened — ${JSON.stringify(state)}`);
}

async function waitForCode(frame) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const code = await frame.evaluate(() => {
      const words = [...document.querySelectorAll('#code span')].map((span) => span.textContent);
      return words.length === 4 ? words.join(' ') : '';
    });
    if (code) return code;
    await sleep(120);
  }
  throw new Error('room code never appeared');
}

async function main() {
  if (!existsSync(join('dist', 'index.html'))) {
    throw new Error('dist/index.html is missing — run `npm run build` first');
  }
  mkdirSync('docs', { recursive: true });
  const videoDir = mkdtempSync(join(tmpdir(), 'pol-demo-'));
  const server = spawn(
    process.execPath,
    ['--env-file-if-exists=.env', 'server/signal.mjs'],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => (serverLog += chunk));
  server.stderr.on('data', (chunk) => (serverLog += chunk));

  const harness = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:#0b0c0e;overflow:hidden}
        body{display:flex;gap:1px}
        .pane{flex:1;min-width:0}
        iframe{width:100%;height:100%;border:0;display:block}
      </style></head><body>
        <div class="pane"><iframe src="${APP_A}" title="sender"></iframe></div>
        <div class="pane"><iframe src="${APP_B}" title="receiver"></iframe></div>
      </body></html>`);
  });
  await new Promise((resolve) => harness.listen(HARNESS_PORT, '127.0.0.1', resolve));

  const browser = await chromium.launch();
  let video;
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (response.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`signaling server never started\n${serverLog}`);
      await sleep(200);
    }

    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
      locale: 'fa-IR',
      colorScheme: 'light',
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    const born = Date.now();
    video = page.video();

    await page.goto(`http://127.0.0.1:${HARNESS_PORT}/`, { waitUntil: 'load' });

    const sender = page.frame({ url: new RegExp(`127\\.0\\.0\\.1:${PORT}/`) });
    const receiver = page.frame({ url: new RegExp(`localhost:${PORT}/`) });
    if (!sender || !receiver) throw new Error('demo iframes did not appear');

    for (const [label, frame] of [['sender', sender], ['receiver', receiver]]) {
      await waitFor(
        frame,
        () => Boolean(document.getElementById('file') && document.getElementById('code-input')),
        20_000,
        `${label} mount`,
      );
      await frame.evaluate(() => document.fonts.ready);
    }
    // The two panes show the two themes on purpose.
    await sender.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await receiver.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    // Jump, don't smooth-scroll: the page sets scroll-behavior: smooth, and a
    // smooth scroll gets interrupted by the panel changing height.
    const scrollTo = (frame, selector) =>
      frame.evaluate((sel) => {
        const target = document.querySelector(sel);
        if (!target) return;
        const top = target.getBoundingClientRect().top + window.scrollY - 88;
        window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      }, selector);

    const start = Date.now();
    await sleep(800);
    // Receiver: switch to the join tab before framing the panel.
    await receiver.evaluate(() => document.getElementById('tab-receive')?.click());
    await sleep(250);
    await scrollTo(sender, '#transfer');
    await sleep(300);
    await scrollTo(receiver, '#join-form');
    await sleep(550);

    // Sender: put a real file into the input (no native dialog in headless).
    await sender.evaluate(async ({ name, size }) => {
      const input = document.getElementById('file');
      const bytes = new Uint8Array(size);
      bytes.fill(0x50);
      crypto.getRandomValues(bytes.subarray(0, 65536));
      const file = new File([bytes], name, { type: 'application/pdf' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: FILE_NAME, size: FILE_SIZE });

    const code = await waitForCode(sender);
    await scrollTo(sender, '#code-card');
    await sleep(1400);

    // Receiver: type the code like a person, then submit.
    await receiver.locator('#code-input').pressSequentially(code, { delay: 40 });
    await sleep(200);
    await receiver.evaluate(() => document.getElementById('join-form')?.requestSubmit());

    // Both sides must show the six session words before any byte moves.
    await waitFor(
      sender,
      () => !document.getElementById('fingerprint')?.hidden,
      30_000,
      'sender fingerprint',
    );
    await waitFor(
      receiver,
      () => !document.getElementById('fingerprint')?.hidden,
      30_000,
      'receiver fingerprint',
    );
    await scrollTo(sender, '#fingerprint');
    await scrollTo(receiver, '#fingerprint');
    await sleep(1500);

    // Payoff: the verified result on the receiver, the ack on the sender.
    await waitFor(
      receiver,
      () => {
        const result = document.getElementById('result');
        const hash = document.getElementById('result-hash');
        return Boolean(
          result && !result.hidden && hash && /[0-9a-f]{64}/.test(hash.textContent ?? ''),
        );
      },
      90_000,
      'receiver result',
    );
    await waitFor(sender, () => !document.getElementById('result')?.hidden, 30_000, 'sender ack');
    await scrollTo(receiver, '#result');
    await scrollTo(sender, '#result');
    await sleep(1900);

    const end = Date.now();
    const trim = Math.max(0, (start - born) / 1000 - 0.15);
    const duration = (end - start) / 1000 + 0.15;

    await context.close();
    const path = await video.path();

    await run(ffmpeg(), [
      '-y',
      '-ss', trim.toFixed(2), '-t', duration.toFixed(2), '-i', path,
      '-vf',
      'fps=9,scale=1000:-2:flags=lanczos,split[s0][s1];' +
        '[s0]palettegen=max_colors=96:stats_mode=diff[p];' +
        '[s1][p]paletteuse=dither=bayer:bayer_scale=5',
      '-loop', '0',
      OUT_GIF,
    ]);

    const bytes = statSync(OUT_GIF).size;
    console.log(`demo: ${OUT_GIF} — ${(bytes / 1024 / 1024).toFixed(2)} MB, ${duration.toFixed(1)} s`);
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    harness.close();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(videoDir, { recursive: true, force: true });
        break;
      } catch {
        // Windows can hold the video handle for a moment after close.
        await sleep(300);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
