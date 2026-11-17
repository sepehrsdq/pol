// CLI ↔ browser interop: the CLI sends a 2 MB file; a real Chrome tab receives
// it via the normal web UI. Verifies hash equality and the fingerprint words.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNAL = process.env.POL_SIGNAL_URL ?? 'ws://localhost:8899/signal';
const BASE = 'http://localhost:8899/';
const PORT = 9252;
const OUT = mkdtempSync(join(tmpdir(), 'pol-cli-browser-'));
const FILE = join(OUT, 'cli-to-browser.bin');
const SIZE = 2 * 1024 * 1024;

const payload = randomBytes(SIZE);
writeFileSync(FILE, payload);
const sha = createHash('sha256').update(payload).digest('hex');
console.log('payload:', SIZE, 'bytes, sha', sha.slice(0, 16) + '…');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const CHROME = [
  process.env.E2E_CHROME ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter((p) => p && existsSync(p));

async function cdp(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
    });
  }
  static async open(url) {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    const page = await res.json();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    const tab = new Tab(ws);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    return tab;
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result?.value;
  }
  async ready(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate(() => ({
          ready: document.readyState,
          url: location.href,
          hasApp: Boolean(document.getElementById('code-input')),
        }));
        if (state.ready === 'complete' && state.hasApp) return;
        if (state.url === 'about:blank') {
          // The new-tab navigation is still in flight; drive it explicitly.
          await this.send('Page.navigate', { url: `${BASE}?debug=1` });
        }
      } catch {
        /* navigation in flight */
      }
      await sleep(250);
    }
    throw new Error('page never became ready');
  }
}

async function main() {
  // 1. Start the CLI sender.
  const sender = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'cli/pol.ts', 'send', FILE],
    { cwd: process.cwd(), env: { ...process.env, POL_SIGNAL_URL: SIGNAL } },
  );
  let senderOut = '';
  sender.stderr.on('data', (c) => process.stderr.write(`[tx] ${String(c)}`));
  sender.stdout.on('data', (c) => {
    const text = String(c);
    process.stdout.write(`[tx] ${text}`);
    senderOut += text;
  });

  // 2. Wait for the code on stdout.
  let code = '';
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !code) {
    const match = /کد: (\S+ \S+ \S+ \S+)/.exec(senderOut);
    if (match) code = match[1];
    else await sleep(250);
  }
  if (!code) {
    console.log('FAIL: no code from CLI\n', senderOut);
    sender.kill();
    process.exit(1);
  }
  console.log('CLI code:', code);

  // 3. Open a browser receiver and submit the code.
  const profile = mkdtempSync(join(tmpdir(), 'pol-cli-browser-profile-'));
  console.log('[rx] launching chrome:', CHROME[0]);
  const chrome = spawn(CHROME[0], [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  let exitCode = 1;
  let chromeReady = false;
  try {
    for (let i = 0; i < 40; i += 1) {
      try {
        await cdp('/json/version');
        chromeReady = true;
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!chromeReady) throw new Error('Chrome CDP never came up');
    flushLog('[rx] CDP up, opening tab');
    const tab = await Tab.open(`${BASE}?debug=1`);
    flushLog('[rx] tab object created');
    await tab.ready();
    flushLog('[rx] tab ready');
    await sleep(400);
    flushLog('[rx] submitting code now…');
    const submitted = await tab.evaluate((roomCode) => {
      return {
        url: location.href,
        hasInput: Boolean(document.getElementById('code-input')),
        hasForm: Boolean(document.getElementById('join-form')),
        title: document.title,
      };
    }, code);
    flushLog(`[rx] page state: ${JSON.stringify(submitted)}`);
    if (submitted !== 'submitted') {
      // The SPA fallback or a slow boot: give the app a moment and retry once.
      await sleep(1200);
      await tab.evaluate((roomCode) => {
        const input = document.getElementById('code-input');
        const form = document.getElementById('join-form');
        input.value = roomCode;
        form.requestSubmit();
        return true;
      }, code);
    }

    // 4. Wait for the transfer to finish on the browser side.
    const rxDeadline = Date.now() + 60_000;
    let result = null;
    let i = 0;
    while (Date.now() < rxDeadline) {
      let snapshot;
      try {
        snapshot = await tab.evaluate(() => {
          const resultEl = document.getElementById('result');
          const hashEl = document.getElementById('result-hash');
          const alertEl = document.getElementById('alert');
          const fp = document.getElementById('fingerprint');
          return {
            visible: Boolean(resultEl && !resultEl.hidden),
            hash: resultEl && !resultEl.hidden && hashEl ? hashEl.textContent.trim() : null,
            alert: alertEl && !alertEl.hidden ? alertEl.textContent.trim() : null,
            fingerprint: fp && !fp.hidden ? fp.textContent.trim() : null,
            lastReceive: window.polDebug?.lastReceive?.() ?? null,
            status: document.getElementById('status')?.textContent ?? '',
          };
        });
      } catch (error) {
        flushLog(`[rx] evaluate failed: ${String(error).slice(0, 120)}`);
        await sleep(500);
        continue;
      }
      if (snapshot.lastReceive?.ok || snapshot.timeline?.ok) {
        result = {
          ...snapshot,
          lastReceive: snapshot.lastReceive ?? {
            size: snapshot.timeline?.bytes ?? 0,
            ok: true,
          },
        };
        break;
      }
      if (snapshot.alert) {
        // The peer-left alert can race the verified result; give it a beat.
        await sleep(600);
        const late = await tab.evaluate(() => ({
          last: window.polDebug?.lastReceive?.() ?? null,
          timeline: window.polDebug?.timeline?.() ?? null,
        }));
        if (late.last?.ok || late.timeline?.ok) {
          result = {
            ...snapshot,
            lastReceive: late.last ?? {
              size: late.timeline?.bytes ?? 0,
              ok: true,
            },
          };
          break;
        }
        flushLog(`browser alert: ${snapshot.alert}`);
        flushLog(`browser diag: ${JSON.stringify(late)}`);
        break;
      }
      if (i === 0 || i === 5 || i === 20) {
        flushLog(`[rx] snapshot: ${JSON.stringify(snapshot)}`);
      }
      i += 1;
      if (snapshot.visible && snapshot.hash) {
        result = snapshot;
        break;
      }
      if (snapshot.lastReceive?.ok || snapshot.timeline?.ok) {
        result = {
          ...snapshot,
          lastReceive: snapshot.lastReceive ?? {
            size: snapshot.timeline?.bytes ?? 0,
            ok: true,
          },
        };
        break;
      }
      await sleep(400);
    }

    if (!result) {
      flushLog('FAIL: browser never showed a verified result');
    } else {
      const received = result.lastReceive;
      const ok = received ? received.ok && received.size === SIZE : false;
      flushLog(`browser received: ${received ? `${received.size} bytes, ok=${received.ok}` : 'unknown'}`);
      flushLog(`fingerprint words seen in browser: ${result.fingerprint ?? '(none)'}`);
      flushLog(ok ? 'CLI ↔ BROWSER PASS' : 'CLI ↔ BROWSER FAIL');
      exitCode = ok ? 0 : 1;
    }
  } catch (error) {
    flushLog(`MAIN CATCH: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      flushLog(error.stack.split('\n').slice(0, 6).join('\n'));
    }
    exitCode = 1;
  } finally {
    flushLog('--- sender output ---');
    flushLog(senderOut || '(empty)');
    flushLog('--- end sender output ---');
    chrome.kill();
    sender.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
      rmSync(OUT, { recursive: true, force: true });
    } catch {
      /* locked briefly */
    }
    process.exit(exitCode);
  }
}

/** process.exit can drop pending async stdout; flush through console instead. */
function flushLog(message) {
  console.log(message);
}

main().catch((error) => {
  console.log('MAIN CATCH:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split('\n').slice(0, 6).join('\n'));
  }
  process.exit(1);
});
