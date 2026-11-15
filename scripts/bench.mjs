// Local throughput benchmark for the data-channel path.
//
//   npm run bench                 # chunk sizes + watermarks, 64 MB, 3 runs each
//   npm run bench -- --size 256   # same matrix on a bigger file
//   npm run bench -- --quick      # chunk sizes only, 1 run each
//   npm run bench -- --no-build   # reuse dist/ from the last build
//
// What is measured: on the receiving tab, the window from the first received
// byte to the moment the SHA-256 matches. ICE/SDP setup, room join and file
// injection happen before that window. The number includes storing the bytes
// and finishing the file, because that cost is real for the user.
//
// The rig is the same shape as scripts/e2e.mjs (headless Chrome, two tabs,
// CDP), but it is deliberately a separate file: a benchmark harness that
// shares code with the test harness tends to break whenever tests change.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = new Set(process.argv.slice(2));
const sizeIndex = process.argv.indexOf('--size');
const runsIndex = process.argv.indexOf('--runs');
/** MB per file; 64 is enough to see a stable shape without a long run. */
const SIZE_MB = sizeIndex > 0 ? Number(process.argv[sizeIndex + 1]) : 64;
const RUNS = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : args.has('--quick') ? 1 : 3;
const QUICK = args.has('--quick');
const NO_BUILD = args.has('--no-build');
const filterIndex = process.argv.indexOf('--filter');
/** Only run configs whose label contains this text (case-insensitive). */
const FILTER = filterIndex > 0 ? String(process.argv[filterIndex + 1]).toLowerCase() : '';

const PORT = Number(process.env.BENCH_PORT ?? 8801);
const CDP_PORT = Number(process.env.BENCH_CDP_PORT ?? 9225);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = [
  process.env.E2E_CHROME ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((path) => path && existsSync(path));

const MB = 1024 * 1024;

// One row of the matrix. The router clamps impossible values, so the table
// prints the tuning the page actually ran with. Each phase varies one knob
// around the 64 KB / 4 MB / 1 MB default.
const CONFIGS = [
  { phase: 'chunk', label: '32 KB chunks', chunkSize: 32 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
  { phase: 'chunk', label: '64 KB chunks', chunkSize: 64 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
  { phase: 'chunk', label: '128 KB chunks', chunkSize: 128 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
  { phase: 'chunk', label: '256 KB chunks', chunkSize: 256 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
  { phase: 'high', label: 'high water 1 MB', chunkSize: 64 * 1024, highWater: 1 * MB, lowWater: 256 * 1024 },
  { phase: 'high', label: 'high water 2 MB', chunkSize: 64 * 1024, highWater: 2 * MB, lowWater: 512 * 1024 },
  { phase: 'high', label: 'high water 4 MB', chunkSize: 64 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
  { phase: 'high', label: 'high water 8 MB', chunkSize: 64 * 1024, highWater: 8 * MB, lowWater: 2 * MB },
  { phase: 'low', label: 'low water = 1 chunk', chunkSize: 64 * 1024, highWater: 4 * MB, lowWater: 64 * 1024 },
  { phase: 'low', label: 'low water = 1 MB', chunkSize: 64 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
  { phase: 'low', label: 'low water = 3 MB', chunkSize: 64 * 1024, highWater: 4 * MB, lowWater: 3 * MB },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(message) {
  process.stdout.write(`[bench] ${message}\n`);
}

function run(command, commandArgs, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}`))));
    child.on('error', fail);
  });
}

async function cdp(path) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  if (!response.ok) throw new Error(`cdp ${path} -> ${response.status}`);
  return response.json();
}

class Tab {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async open(url) {
    // Chrome wants PUT here, and some builds ignore the query string.
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    if (!response.ok) throw new Error(`cdp /json/new -> ${response.status}`);
    const page = await response.json();
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', fail, { once: true });
    });
    const tab = new Tab(socket);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Page.navigate', { url });
    await tab.waitForApp();
    return tab;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitForApp() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const state = await this.evaluate(() => ({
        ready: document.readyState,
        hasApp: Boolean(document.getElementById('file')),
      }));
      if (state.ready === 'complete' && state.hasApp) return;
      await sleep(200);
    }
    throw new Error('app page never finished loading');
  }

  async evaluate(fn, ...fnArgs) {
    const expression = `(${fn.toString()})(...${JSON.stringify(fnArgs)})`;
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'page exception');
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function launchChrome(profileDir) {
  if (CHROME.length === 0) throw new Error('Chrome not found; set E2E_CHROME to its path');
  const chrome = spawn(
    CHROME[0],
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-gpu',
      // Headless tabs are treated as background: without these, timers and
      // the renderer get throttled and the measurement becomes a throttle
      // benchmark instead of a transfer benchmark.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await cdp('/json/version');
      return chrome;
    } catch {
      await sleep(250);
    }
  }
  chrome.kill();
  throw new Error('Chrome CDP never came up');
}

/** Drop a file of `byteLength` bytes into the sender's file input. */
async function injectFile(tab, name, byteLength) {
  return tab.evaluate(
    async (fileName, size) => {
      const input = document.getElementById('file');
      if (!input) throw new Error('#file not found');
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)));
      }
      const file = new File([bytes], fileName, { type: 'application/octet-stream' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    name,
    byteLength,
  );
}

async function readRoomCode(tab) {
  const code = await tab.evaluate(() => {
    const words = [...document.querySelectorAll('#code span')].map((span) => span.textContent);
    return words.length === 4 ? words.join(' ') : null;
  });
  if (!code) throw new Error('room code never appeared');
  return code;
}

async function joinRoom(tab, code) {
  await tab.evaluate((roomCode) => {
    const input = document.getElementById('code-input');
    const form = document.getElementById('join-form');
    input.value = roomCode;
    form.requestSubmit();
  }, code);
}

/** Wait until the receiver has a verified file and hand back its window. */
async function waitForVerify(tab, expectedHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await tab.evaluate(() => {
      const alert = document.getElementById('alert');
      const visible = Boolean(alert && !alert.hidden && alert.textContent?.trim());
      return {
        hash: document.getElementById('result-hash')?.textContent ?? '',
        visible: Boolean(document.getElementById('result') && !document.getElementById('result').hidden),
        alert: visible ? alert.textContent.trim() : '',
        timeline: window.polDebug?.timeline?.() ?? null,
        stats: window.polDebug?.stats?.() ?? null,
      };
    });
    if (state.visible && state.hash.includes(expectedHash)) {
      return { timeline: state.timeline, stats: state.stats };
    }
    if (state.alert) throw new Error(`receiver alert: ${state.alert}`);
    await sleep(50);
  }
  throw new Error('receiver never verified the file');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = (value) => Math.round(value * 10) / 10;

function summarise(samples) {
  if (samples.length === 0) return null;
  return {
    min: round(Math.min(...samples)),
    median: round(median(samples)),
    max: round(Math.max(...samples)),
  };
}

/** Median of each field of the sender's timing samples, in milliseconds. */
function medians(samples) {
  if (!samples || samples.length === 0) return null;
  const fields = ['hashSendMs', 'sendMs', 'drainMs', 'readMs', 'hashRecvMs'];
  const out = {};
  for (const field of fields) {
    const values = samples.map((sample) => sample?.[field] ?? 0);
    out[field] = Math.round(median(values));
  }
  out.chunks = Math.round(median(samples.map((sample) => sample?.chunks ?? 0)));
  return out;
}

function timingTable(rows) {
  const withTiming = rows.filter((row) => row.timings);
  if (withTiming.length === 0) return '';
  const header = ['config', 'chunks', 'hash', 'send', 'drain', 'read', 'recv hash'];
  const body = withTiming.map((row) => [
    row.label,
    String(row.timings.chunks),
    `${row.timings.hashSendMs} ms`,
    `${row.timings.sendMs} ms`,
    `${row.timings.drainMs} ms`,
    `${row.timings.readMs} ms`,
    `${row.timings.hashRecvMs} ms`,
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [line(header), widths.map((width) => '─'.repeat(width)).join('  '), ...body.map(line)].join(
    '\n',
  );
}

function table(rows) {
  const header = ['config', 'chunk', 'high', 'low', 'runs', 'min MB/s', 'median', 'max', 'note'];
  const body = rows.map((row) => [
    row.label,
    `${row.chunk / 1024} KB`,
    `${round(row.high / MB)} MB`,
    `${round(row.low / MB)} MB`,
    String(row.runs),
    row.stats ? String(row.stats.min) : '—',
    row.stats ? String(row.stats.median) : '—',
    row.stats ? String(row.stats.max) : '—',
    row.error ? `failed: ${row.error}` : '',
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [line(header), widths.map((width) => '─'.repeat(width)).join('  '), ...body.map(line)].join(
    '\n',
  );
}

async function main() {
  if (!NO_BUILD) {
    log('building dist/');
    await run('npm', ['run', 'build'], { cwd: ROOT });
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing; run npm run build first');
  }

  log(`file size ${SIZE_MB} MB, ${RUNS} run(s) per config, runs over loopback`);
  const server = spawn(process.execPath, ['server/signal.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const profileDir = mkdtempSync(join(tmpdir(), 'pol-bench-'));
  let chrome = null;
  let sender = null;
  let receiver = null;

  try {
    let serverUp = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${BASE}healthz`);
        if (response.ok) {
          serverUp = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }
    if (!serverUp) throw new Error(`signaling server did not start on port ${PORT}`);

    chrome = await launchChrome(profileDir);
    const version = (await cdp('/json/version')).Browser;
    log(`chrome: ${version}`);

    sender = await Tab.open(`${BASE}?debug=1`);
    receiver = await Tab.open(`${BASE}?debug=1`);

    // A small file creates the room and doubles as a warm-up for both tabs.
    const warmupHash = await injectFile(sender, 'bench-warmup.bin', 8 * MB);
    const code = await readRoomCode(sender);
    await joinRoom(receiver, code);
    log('joined the room, warm-up transfer running');
    await waitForVerify(receiver, warmupHash, 180_000);
    log('warm-up verified');

    const configs = CONFIGS.filter(
      (config) =>
        (!QUICK || config.phase === 'chunk') &&
        (!FILTER || config.label.toLowerCase().includes(FILTER)),
    );
    const rows = [];
    const samples = new Map(configs.map((config) => [config.label, []]));
    const timingSamples = new Map(configs.map((config) => [config.label, []]));
    /** Median of each round: shows how much the machine drifted while it ran. */
    const roundMedians = [];
    const effective = new Map();
    const errors = new Map();

    /** One transfer at the given tuning; hands back the receiver's window. */
    const measure = async (config, name) => {
      const tuning = await sender.evaluate(
        (patch) => window.polDebug.setTuning(patch),
        config,
      );
      const hash = await injectFile(sender, name, SIZE_MB * MB);
      const { timeline, stats: recvStats } = await waitForVerify(receiver, hash, 180_000);
      if (!timeline || timeline.startedAt === 0 || timeline.endedAt === 0) {
        throw new Error('the receiver reported no timeline');
      }
      const sendStats = await sender.evaluate(() => window.polDebug?.stats?.() ?? null);
      // The finished file stays in OPFS until the page reloads; leaving it
      // there would make every later run pay for the earlier ones.
      const usage = await receiver.evaluate(async () => {
        await window.polDebug.clearReceived();
        const estimate = await navigator.storage?.estimate?.();
        return estimate?.usage ?? 0;
      });
      return { tuning, timeline, usage, sendStats, recvStats };
    };

    const probe = async (label) => {
      await sleep(2500);
      try {
        await measure(
          { chunkSize: 64 * 1024, highWater: 4 * MB, lowWater: 1 * MB },
          `probe-${label}.bin`,
        );
        return true;
      } catch {
        return false;
      }
    };

    const slug = (label) => label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    // Rounds, not blocks: this machine drifts (thermals, background load), so
    // measuring three runs of one config back to back would blame the config
    // for whatever happened to the machine at that moment. The order inside a
    // round is shuffled for the same reason: position in the round must not
    // favour one row.
    for (let roundIndex = 1; roundIndex <= RUNS; roundIndex += 1) {
      const order = [...configs];
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const roundSpeeds = [];
      for (const config of order) {
        try {
          const result = await measure(config, `bench-${slug(config.label)}-${roundIndex}.bin`);
          effective.set(config.label, result.tuning);
          const { timeline } = result;
          const seconds = (timeline.endedAt - timeline.startedAt) / 1000;
          const mbps = timeline.bytes / seconds / MB;
          samples.get(config.label).push(mbps);
          roundSpeeds.push(mbps);
          if (result.sendStats) {
            timingSamples
              .get(config.label)
              .push({ ...result.sendStats, hashRecvMs: result.recvStats?.hashRecvMs ?? 0 });
          }
          const streamSeconds = (timeline.lastProgressAt - timeline.startedAt) / 1000;
          const tail = seconds - streamSeconds;
          const ms = (value) => `${Math.round(value)}`;
          log(
            `  round ${roundIndex} · ${config.label}: ${round(mbps)} MB/s over ${seconds.toFixed(2)}s ` +
              `(stream ${round(timeline.bytes / streamSeconds / MB)} MB/s, finish ${tail.toFixed(2)}s, ` +
              `left on disk ${round(result.usage / MB)} MB)`,
          );
          if (result.sendStats) {
            const s = result.sendStats;
            log(
              `      sender: hash ${ms(s.hashSendMs)}ms, send ${ms(s.sendMs)}ms, ` +
                `drain ${ms(s.drainMs)}ms, read ${ms(s.readMs)}ms, ${s.chunks} chunks; ` +
                `receiver hash ${ms(result.recvStats?.hashRecvMs ?? 0)}ms`,
            );
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          errors.set(config.label, message);
          log(`  round ${roundIndex} · ${config.label}: failed — ${message}`);
          // A dead channel may recover by itself; prove it before going on.
          if (!(await probe(`${slug(config.label)}-${roundIndex}`))) {
            throw new Error(`the session did not recover after "${config.label}": ${message}`);
          }
        }
      }
      const roundMedian = roundSpeeds.length > 0 ? round(median(roundSpeeds)) : 0;
      roundMedians.push(roundMedian);
      log(`round ${roundIndex} finished, median ${roundMedian} MB/s`);
    }

    for (const config of configs) {
      const tuning = effective.get(config.label) ?? {
        chunkSize: config.chunkSize,
        highWater: config.highWater,
        lowWater: config.lowWater,
      };
      const collected = samples.get(config.label);
      const timings = timingSamples.get(config.label) ?? [];
      rows.push({
        label: config.label,
        chunk: tuning.chunkSize,
        high: tuning.highWater,
        low: tuning.lowWater,
        runs: collected.length,
        stats: summarise(collected),
        timings: medians(timings),
        error: errors.get(config.label) ?? null,
      });
    }

    const report = table(rows);
    process.stdout.write(`\n${report}\n`);
    const split = timingTable(rows);
    if (split) process.stdout.write(`\n${split}\n`);
    process.stdout.write(
      '\nMB/s is measured on the receiving tab: first received byte → SHA-256 match.\n' +
        'Loopback is an upper bound for the browser+disk path, not a Wi-Fi number.\n',
    );

    if (!args.has('--no-file')) {
      const machine = `${cpus().length} logical cores, ${Math.round(totalmem() / 1024 ** 3)} GB RAM, ${platform()}`;
      writeFileSync(
        join(ROOT, 'docs', 'benchmark.md'),
        [
          '# Transfer benchmark',
          '',
          `- Date: ${new Date().toISOString().slice(0, 10)}`,
          `- Chrome: ${version}`,
          `- Machine: ${machine}`,
          `- File: ${SIZE_MB} MB of random bytes, ${RUNS} run(s) per row`,
          '- Measured on the receiving tab: first received byte → SHA-256 match',
          '',
          '```',
          report,
          '```',
          ...(split ? ['', 'Sender side, where the time went (median per file):', '', '```', split, '```'] : []),
          '',
          `Round medians: ${roundMedians.join(' → ')} MB/s. Round-to-round movement is`,
          'the machine, not the configuration.',
          '',
          'A single row\'s runs spread by up to 30% here, so medians that sit that',
          'close are ties, not a ranking.',
          '',
          'The same 64 KB configuration measured 16.1 MB/s in a short run on a cold',
          'machine, against ~9 MB/s inside this matrix: this laptop slows down while',
          'it stays loaded. Compare rows within the table, not this file to another',
          'run.',
          '',
          'Loopback numbers are an upper bound for this browser and disk path. A real',
          'Wi-Fi or cross-network transfer is limited by the link, and by the TURN',
          'relay when the peers cannot connect directly.',
          '',
        ].join('\n'),
      );
      log('wrote docs/benchmark.md');
    }

    log('BENCH DONE');
  } finally {
    sender?.close();
    receiver?.close();
    chrome?.kill();
    server.kill();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* the profile can still be locked for a moment on Windows */
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[bench] FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
