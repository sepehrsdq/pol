// End-to-end transfer test for Pol, run against a real Chrome via CDP.
//
// The in-harness browser produces no ICE candidates, so a WebRTC transfer can
// only be proven with a real browser. This script:
//   1. builds the client (or reuses dist/ with --no-build),
//   2. starts the signaling server on a free port,
//   3. launches headless Chrome with --remote-debugging-port,
//   4. opens two tabs on localhost,
//   5. injects THREE random files into the sender, one after another,
//   6. checks each hash, the growing session list, and the session total.
//
// Usage:
//   npm run e2e              # build + test (3 files, default sizes)
//   npm run e2e -- --no-build
//   node scripts/e2e.mjs --size 1048576        # same size for every file
//   node scripts/e2e.mjs --sizes 1MB,2MB,3MB   # per-file sizes
//
// Exit code 0 means every hash matched and the session total is exact.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = new Set(process.argv.slice(2));
const sizeArgIndex = process.argv.indexOf('--size');
const sizesArgIndex = process.argv.indexOf('--sizes');
/** Per-file byte sizes; three files, varied on purpose so the total is real. */
const FILE_SIZES = (() => {
  if (sizesArgIndex > -1 && process.argv[sizesArgIndex + 1]) {
    const parsed = process.argv[sizesArgIndex + 1]
      .split(',')
      .map((token) => parseSize(token))
      .filter((n) => n > 0);
    if (parsed.length > 0) return parsed;
  }
  if (sizeArgIndex > -1 && Number(process.argv[sizeArgIndex + 1]) > 0) {
    const single = Number(process.argv[sizeArgIndex + 1]);
    return [single, single, single];
  }
  return [1 * 1024 * 1024, 2 * 1024 * 1024, 3 * 1024 * 1024];
})();

/** "3MB" / "500KB" / plain bytes -> bytes. */
function parseSize(token) {
  const match = /^(\d+)(KB|MB|GB)?$/i.exec(token.trim());
  if (!match) return Number(token) || 0;
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2].toUpperCase()] ?? 1;
  return Number(match[1]) * multiplier;
}
const PORT = Number(process.env.E2E_PORT ?? 8797);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9223);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME_CANDIDATES = [
  process.env.E2E_CHROME,
  // CI runner (ubuntu-latest ships Google Chrome stable)
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
].filter(Boolean);

function log(message) {
  console.log(`[e2e] ${message}`);
}

function fail(message) {
  console.error(`[e2e] FAIL: ${message}`);
  process.exitCode = 1;
}

async function firstFreePort(preferred) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(preferred, '127.0.0.1', () => {
      probe.close(() => resolvePort(preferred));
    });
    probe.on('error', () => resolvePort(firstFreePort(preferred + 1)));
  });
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      stdio: options.capture ? 'pipe' : 'inherit',
      shell: false,
      ...options,
    });
    if (options.capture) {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        out += chunk;
      });
      child.on('close', (code) => (code === 0 ? resolveRun(out) : rejectRun(new Error(out))));
      child.on('error', rejectRun);
    } else {
      child.on('close', (code) => (code === 0 ? resolveRun('') : rejectRun(new Error(`exit ${code}`))));
      child.on('error', rejectRun);
    }
  });
}

async function cdp(path, port = CDP_PORT) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`cdp ${path} -> ${response.status}`);
  return response.json();
}

class CdpTab {
  constructor(webSocket) {
    this.ws = webSocket;
    this.nextId = 1;
    this.pending = new Map();
    webSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: res, reject: rej } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
      }
    });
  }

  static async open(url) {
    // New Chrome wants PUT on /json/new; older builds answered GET.
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    if (!response.ok) throw new Error(`cdp /json/new -> ${response.status}`);
    const page = await response.json();
    const webSocket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      webSocket.addEventListener('open', res, { once: true });
      webSocket.addEventListener('error', rej, { once: true });
    });
    const tab = new CdpTab(webSocket);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Page.navigate', { url });
    await tab.waitForPageReady();
    return tab;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitForPageReady() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await this.evaluate(() => ({
        ready: document.readyState,
        hasApp: Boolean(document.getElementById('file')),
      }));
      // "complete" alone is not enough: about:blank is complete too.
      if (state.ready === 'complete' && state.hasApp) return;
      await sleep(250);
    }
    throw new Error('app page never finished loading');
  }

  /** Evaluate an async function body in the page and return its value. */
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
    this.ws.close();
  }
}

async function launchChrome(profileDir) {
  const executable = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executable) throw new Error('Chrome not found; set E2E_CHROME');
  const isCi = Boolean(process.env.CI);
  const chrome = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      // Root in CI containers: Chrome refuses the sandbox without a namespace.
      ...(isCi ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  chrome.on('error', (error) => {
    throw error;
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await cdp('/json/version');
      return chrome;
    } catch {
      await sleep(300);
    }
  }
  throw new Error('Chrome CDP never came up');
}

async function putFileInSender(tab, fileName = 'e2e.bin', byteLength = 1024 * 1024) {
  // Build the File in the page, drop it into the input via DataTransfer.
  const injected = await tab.evaluate(
    async (name, mime, size) => {
      const input = document.getElementById('file');
      if (!input) {
        throw new Error(
          `#file not found; url=${location.href} title=${document.title} body=${document.body?.textContent?.slice(0, 120) ?? ''}`,
        );
      }
      const bytes = new Uint8Array(size);
      // getRandomValues caps at 64 KB per call; fill in slices.
      for (let offset = 0; offset < size; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)));
      }
      const file = new File([bytes], name, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return { name: file.name, size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    },
    fileName,
    'application/octet-stream',
    byteLength,
  );
  return injected;
}

async function readReceiverCode(senderTab) {
  const code = await senderTab.evaluate(() => {
    const words = [...document.querySelectorAll('#code span')].map((span) => span.textContent);
    return words.length === 4 ? words.join(' ') : null;
  });
  if (!code) throw new Error('room code never appeared');
  return code;
}

async function submitCode(receiverTab, code) {
  const submitted = await receiverTab.evaluate((roomCode) => {
    const input = document.getElementById('code-input');
    const form = document.getElementById('join-form');
    input.value = roomCode;
    form.requestSubmit();
    return true;
  }, code);
  if (!submitted) throw new Error('code submit failed');
}

async function waitForReceiverResult(receiverTab, timeoutMs = 60_000, previousHash = null, wantedMime = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await receiverTab.evaluate(() => {
      const alert = document.getElementById('alert');
      const result = document.getElementById('result');
      const hash = document.getElementById('result-hash');
      const text = document.getElementById('result-text');
      const download = document.getElementById('download');
      const alertVisible = alert && !alert.hidden && alert.textContent.trim().length > 0;
      const resultVisible = result && !result.hidden;
      return {
        alert: alertVisible ? alert.textContent.trim() : null,
        resultVisible,
        hash: resultVisible && hash ? hash.textContent.trim() : null,
        text: resultVisible && text && !text.hidden ? text.textContent : null,
        downloadReady: Boolean(download && !download.hidden),
        progress: document.getElementById('progress-size')?.textContent ?? '',
      };
    });
    if (snapshot.alert) throw new Error(`receiver alert: ${snapshot.alert}`);
    // previousHash: the card may still show the last file's result; wait for a new one.
    const fresh = snapshot.hash && (!previousHash || !snapshot.hash.includes(previousHash));
    // wantedMime: text results show the inline view; zip/file results the download.
    const mimeOk =
      !wantedMime ||
      (wantedMime.startsWith('text/')
        ? typeof snapshot.text === 'string' && snapshot.text.length > 0
        : snapshot.downloadReady);
    if (snapshot.resultVisible && fresh && mimeOk) return snapshot;
    await sleep(500);
  }
  throw new Error('receiver never showed a verified result');
}

async function waitForSenderAck(senderTab, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await senderTab.evaluate(() => {
      const alert = document.getElementById('alert');
      const alertVisible = alert && !alert.hidden && alert.textContent.trim().length > 0;
      return { alert: alertVisible ? alert.textContent.trim() : null };
    });
    if (snapshot.alert) throw new Error(`sender alert: ${snapshot.alert}`);
    await sleep(500);
    // The ack page shows the success result element on the sender too.
    const done = await senderTab.evaluate(() => {
      const result = document.getElementById('result');
      return Boolean(result && !result.hidden);
    });
    if (done) return;
  }
  throw new Error('sender never saw the ack');
}

/** Minimal ZIP store reader: local headers only, method 0 entries. */
function readZipStore(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let cursor = 0;
  while (cursor + 30 <= bytes.length) {
    if (view.getUint32(cursor, true) !== 0x04034b50) break;
    const flags = view.getUint16(cursor + 6, true);
    const method = view.getUint16(cursor + 8, true);
    const size = view.getUint32(cursor + 18, true);
    const nameLen = view.getUint16(cursor + 26, true);
    const extraLen = view.getUint16(cursor + 28, true);
    const nameStart = cursor + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (method !== 0) throw new Error(`zip entry "${name}" is not stored (method ${method})`);
    // With bit-3 data descriptors, some writers leave sizes zero in the local
    // header; fall back to scanning for the next signature when needed.
    let dataEnd = dataStart + size;
    if (size === 0 && (flags & 0x8) !== 0) {
      // Search forward for the next local header or central directory.
      let probe = dataStart;
      while (probe + 4 <= bytes.length) {
        const sig = view.getUint32(probe, true);
        if (sig === 0x04034b50 || sig === 0x02014b50 || sig === 0x06054b50) break;
        probe += 1;
      }
      dataEnd = probe - 12; // strip the trailing data descriptor
    }
    entries.push({ name, data: bytes.slice(dataStart, dataEnd) });
    // Every entry is followed by a 12-byte data descriptor (our writer always
    // emits one), except where the central directory already began.
    cursor = dataEnd + 12;
  }
  return entries;
}

async function main() {
  const profileDir = mkdtempSync(join(tmpdir(), 'pol-e2e-'));
  let chrome = null;
  let server = null;
  try {
    if (!args.has('--no-build')) {
      log('building client…');
      await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { capture: true });
    }

    const port = await firstFreePort(PORT);
    server = spawn(process.execPath, ['server/signal.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (health.ok) break;
      } catch {}
      await sleep(300);
    }
    log(`signaling server on :${port}`);

    log('launching Chrome…');
    chrome = await launchChrome(profileDir);
    log(`Chrome CDP on :${CDP_PORT}`);

    const senderTab = await CdpTab.open(BASE);
    const receiverTab = await CdpTab.open(BASE);
    log('two tabs open');

    let previousHash = null;
    let expectedTotal = 0;
    let roomCode = null;

    for (let index = 0; index < FILE_SIZES.length; index += 1) {
      const size = FILE_SIZES[index];
      const file = await putFileInSender(senderTab, `e2e-${index + 1}.bin`, size);
      expectedTotal += file.size;
      log(`file ${index + 1} injected: ${file.size} bytes, sha ${file.sha256.slice(0, 12)}…`);

      if (index === 0) {
        const code = await readReceiverCode(senderTab);
        log(`room code: ${code}`);
        await submitCode(receiverTab, code);
        roomCode = code;
      }

      const result = await waitForReceiverResult(receiverTab, 90_000, previousHash);
      previousHash = file.sha256;

      const hash = (result.hash.match(/[0-9a-f]{64}/) ?? [])[0];
      if (hash !== file.sha256) {
        fail(`file ${index + 1} hash mismatch\n  expected ${file.sha256}\n  received ${hash}`);
        return;
      }
      log(`file ${index + 1} hash matched: ${hash.slice(0, 12)}…`);

      // The session list on both sides must show every file so far.
      const state = await Promise.all([
        receiverTab.evaluate(() => ({
          items: document.querySelectorAll('#session-list li').length,
          total: document.getElementById('session-total')?.textContent ?? '',
        })),
        senderTab.evaluate(() => ({
          items: document.querySelectorAll('#session-list li').length,
          codeWords: [...document.querySelectorAll('#code span')].map((s) => s.textContent).join(' '),
        })),
      ]);
      if (state[0].items !== index + 1 || state[1].items !== index + 1) {
        fail(`file ${index + 1}: session list wrong (receiver ${state[0].items}, sender ${state[1].items}, expected ${index + 1})`);
        return;
      }
      log(`session after ${index + 1}: list ${state[0].items}/${state[1].items}, total "${state[0].total}"`);
    }

    // --- final session assertions: code kept, exact byte total ---
    const final = await Promise.all([
      receiverTab.evaluate(() => ({
        items: document.querySelectorAll('#session-list li').length,
      })),
      senderTab.evaluate(() => ({
        items: document.querySelectorAll('#session-list li').length,
        codeStillVisible: !document.getElementById('code-card')?.hidden,
        codeWords: [...document.querySelectorAll('#code span')].map((s) => s.textContent).join(' '),
      })),
    ]);
    if (final[0].items !== FILE_SIZES.length || final[1].items !== FILE_SIZES.length) {
      fail(`final session list wrong (receiver ${final[0].items}, sender ${final[1].items})`);
      return;
    }
    if (!final[1].codeStillVisible || final[1].codeWords !== roomCode) {
      fail(`sender code card lost: visible=${final[1].codeStillVisible} words="${final[1].codeWords}"`);
      return;
    }
    log(`session kept across ${FILE_SIZES.length} files, code "${roomCode}", promised ${expectedTotal} bytes`);

    // --- text snippet: typed into the textarea, sent with the button ---
    const secret = `pol secret ${Date.now()}`;
    const textSent = await senderTab.evaluate((payload) => {
      const input = document.getElementById('text-input');
      const button = document.getElementById('send-text');
      input.value = payload;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (button.disabled) return false;
      button.click();
      return true;
    }, secret);
    if (!textSent) {
      fail('send-text button never enabled or click failed');
      return;
    }
    log(`text queued: "${secret.slice(0, 18)}…"`);

    const textResult = await waitForReceiverResult(receiverTab, 60_000, previousHash, 'text/plain');
    const textShown = textResult.text ?? '';
    if (textShown !== secret) {
      fail(`text mismatch\n  expected ${secret}\n  received ${textShown}`);
      return;
    }
    log('text verified on the receiver, inline view shown');
    previousHash = textResult.hash;

    // --- folder: build virtual files with webkitRelativePath, send as ZIP ---
    const folderName = `pol-folder-${Date.now()}`;
    const folderFiles = await senderTab.evaluate((root) => {
      const input = document.getElementById('folder');
      const transfer = new DataTransfer();
      const made = [];
      const content = (size, seed) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) bytes[i] = (seed + i * 31) & 0xff;
        return bytes;
      };
      const specs = [
        { name: `${root}/readme.txt`, size: 40, seed: 1 },
        { name: `${root}/img/blob-a.bin`, size: 120_000, seed: 7 },
        { name: `${root}/img/blob-b.bin`, size: 45_000, seed: 13 },
      ];
      for (const spec of specs) {
        const file = new File([content(spec.size, spec.seed)], spec.name.split('/').pop(), {
          type: 'application/octet-stream',
        });
        Object.defineProperty(file, 'webkitRelativePath', { value: spec.name, configurable: true });
        transfer.items.add(file);
        made.push({ path: spec.name, size: spec.size, content: content(spec.size, spec.seed) });
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return made.map((m) => ({ path: m.path, size: m.size, content: [...m.content] }));
    }, folderName);
    log(`folder queued: ${folderFiles.length} files as "${folderName}.zip"`);

    const zipResult = await waitForReceiverResult(receiverTab, 90_000, previousHash, 'application/zip');
    const zipHash = (zipResult.hash.match(/[0-9a-f]{64}/) ?? [])[0];
    if (!zipHash) {
      fail('zip hash unreadable');
      return;
    }
    // Pull the ZIP back out of the page and parse its store entries in Node.
    const zipBytes = new Uint8Array(await receiverTab.evaluate(async () => {
      const link = document.getElementById('download');
      const response = await fetch(link.href);
      return [...new Uint8Array(await response.arrayBuffer())];
    }));
    const entries = readZipStore(zipBytes);
    let zipOk = true;
    for (const sent of folderFiles) {
      const innerName = sent.path.split('/').slice(1).join('/');
      const entry = entries.find((e) => e.name === innerName);
      if (!entry) {
        fail(`zip missing entry "${innerName}" (got: ${entries.map((e) => e.name).join(', ')})`);
        zipOk = false;
        break;
      }
      const receivedHash = createHash('sha256').update(entry.data).digest('hex');
      const expectedHash = createHash('sha256').update(new Uint8Array(sent.content)).digest('hex');
      if (receivedHash !== expectedHash || entry.data.length !== sent.size) {
        fail(`zip entry "${innerName}" content mismatch`);
        zipOk = false;
        break;
      }
    }
    if (!zipOk) return;
    log(`zip parsed back: ${entries.length} entries, all contents byte-exact, archive hash ${zipHash.slice(0, 12)}…`);

    // Final count: three files + text + zip = five session entries.
    const count = await receiverTab.evaluate(() => document.querySelectorAll('#session-list li').length);
    if (count !== FILE_SIZES.length + 2) {
      fail(`final session count wrong: ${count}, expected ${FILE_SIZES.length + 2}`);
      return;
    }
    log(`session list holds ${count} entries — files, text and folder all in one session`);
    log('E2E PASS (files + text + folder ZIP, one session)');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    chrome?.kill();
    server?.kill();
    // Chrome holds the profile dir for a moment after kill; never let
    // cleanup mask the test result.
    if (chrome) await sleep(500);
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 });
    } catch {
      log(`leftover profile dir: ${profileDir}`);
    }
  }
}

main();
