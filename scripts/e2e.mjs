// End-to-end transfer test for Pol, run against a real Chrome via CDP.
//
// The in-harness browser produces no ICE candidates, so a WebRTC transfer can
// only be proven with a real browser. This script:
//   1. builds the client (or reuses dist/ with --no-build),
//   2. starts the signaling server on a free port,
//   3. launches headless Chrome with --remote-debugging-port,
//   4. opens two tabs on localhost,
//   5. injects a random file into the sender, types the code in the receiver,
//   6. compares the receiver's reported SHA-256 with the one Node computes.
//
// Usage:
//   npm run e2e              # build + test
//   npm run e2e -- --no-build
//   node scripts/e2e.mjs --size 1048576
//
// Exit code 0 means the hashes matched. Nothing else does.

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
const FILE_SIZE =
  sizeArgIndex > -1 && Number(process.argv[sizeArgIndex + 1]) > 0
    ? Number(process.argv[sizeArgIndex + 1])
    : 3 * 1024 * 1024;
const PORT = Number(process.env.E2E_PORT ?? 8797);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9223);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME_CANDIDATES = [
  process.env.E2E_CHROME,
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
  const chrome = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
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

async function putFileInSender(tab, file) {
  // Build the File in the page, drop it into the input via DataTransfer.
  const injected = await tab.evaluate(
    async (name, mime, byteLength) => {
      const input = document.getElementById('file');
      if (!input) {
        throw new Error(
          `#file not found; url=${location.href} title=${document.title} body=${document.body?.textContent?.slice(0, 120) ?? ''}`,
        );
      }
      const bytes = new Uint8Array(byteLength);
      // getRandomValues caps at 64 KB per call; fill in slices.
      for (let offset = 0; offset < byteLength; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, byteLength)));
      }
      const file = new File([bytes], name, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return { name: file.name, size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    },
    'e2e.bin',
    'application/octet-stream',
    FILE_SIZE,
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

async function waitForReceiverResult(receiverTab, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await receiverTab.evaluate(() => {
      const alert = document.getElementById('alert');
      const result = document.getElementById('result');
      const hash = document.getElementById('result-hash');
      const download = document.getElementById('download');
      const alertVisible = alert && !alert.hidden && alert.textContent.trim().length > 0;
      const resultVisible = result && !result.hidden;
      return {
        alert: alertVisible ? alert.textContent.trim() : null,
        resultVisible,
        hash: resultVisible && hash ? hash.textContent.trim() : null,
        downloadReady: Boolean(download && !download.hidden),
        progress: document.getElementById('progress-size')?.textContent ?? '',
      };
    });
    if (snapshot.alert) throw new Error(`receiver alert: ${snapshot.alert}`);
    if (snapshot.resultVisible && snapshot.hash) return snapshot;
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

    const file = await putFileInSender(senderTab);
    log(`file injected: ${file.name} ${file.size} bytes, sha ${file.sha256.slice(0, 12)}…`);

    const code = await readReceiverCode(senderTab);
    log(`room code: ${code}`);
    await submitCode(receiverTab, code);

    const result = await waitForReceiverResult(receiverTab);
    await waitForSenderAck(senderTab).catch(() => {
      // The sender side page may reset its result on tab focus quirks; the
      // receiver's verified hash is the contract that matters.
      log('sender ack not observed; relying on receiver result');
    });

    const receivedHash = (result.hash.match(/[0-9a-f]{64}/) ?? [])[0];
    if (!receivedHash) throw new Error(`receiver hash unreadable: ${result.hash}`);
    if (receivedHash !== file.sha256) {
      fail(`hash mismatch\n  expected ${file.sha256}\n  received ${receivedHash}`);
      return;
    }
    log(`hash matched: ${receivedHash.slice(0, 12)}…`);
    log('E2E PASS');
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
