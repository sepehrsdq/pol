/**
 * Pol CLI — send and receive files straight between a terminal and a browser.
 *
 * Speaks the same signaling protocol and the same transfer wire format as the
 * web client (meta → ready → bytes → end → done), and runs the same SPAKE2
 * handshake, so a browser tab and this process interoperate unchanged.
 *
 *   node cli/pol.mjs send <file>          — print a room code, wait, stream
 *   node cli/pol.mjs receive <four words> — join and download to POL_OUT/cwd
 *
 * Env: POL_SIGNAL_URL (default wss://qqsp.ir/signal), POL_OUT (receive dir).
 */
import { createWriteStream, statSync } from 'node:fs';
import { open, close } from 'node:fs/promises';
import { basename, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import nodeDatachannel from 'node-datachannel';
import WebSocket from 'ws';
import { Sha256 } from '../src/lib/sha256';
import {
  proverStart,
  proverFinish,
  verifierStart,
  verifierFinish,
} from '../src/lib/spake2';
import { fingerprintWords, fingerprintsFromSdp } from '../src/lib/fingerprint';
import { formatCode, makeCode, parseCode } from '../src/lib/words';
import { normalizeIceServers, DEFAULT_STUN } from '../src/net/ice';

const { PeerConnection } = nodeDatachannel;

const HIGH_WATER = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const READ_SIZE = 1024 * 1024;
const SIGNAL_TIMEOUT_MS = 30_000;
const DONE_TIMEOUT_MS = 120_000;

/* ------------------------- formatting ------------------------- */

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** process.exit can drop pending async stdout; write synchronously instead. */
function flushLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

function die(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/* ------------------------- signaling ------------------------- */

type Message = { t: string; data?: unknown; message?: string };

/** The exact JSON protocol of server/signal.mjs over `ws`. */
class Signal {
  private readonly socket: WebSocket;
  private readonly queue: unknown[] = [];
  private closedByUs = false;

  constructor(
    url: string,
    room: string,
    role: 'sender' | 'receiver',
    onMessage: (message: Message) => void,
    onClose: () => void,
  ) {
    this.socket = new WebSocket(url);
    this.socket.on('open', () => {
      this.socket.send(
        JSON.stringify({ t: 'join', room, role, client: `cli-${randomUUID().slice(0, 13)}` }),
      );
      for (const payload of this.queue) this.socket.send(JSON.stringify(payload));
      this.queue.length = 0;
    });
    this.socket.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Message;
        if (message.t === 'replaced') this.closedByUs = true;
        onMessage(message);
      } catch {
        /* server only sends well-formed JSON */
      }
    });
    this.socket.on('close', () => {
      if (!this.closedByUs) onClose();
    });
    this.socket.on('error', () => undefined);
  }

  send(payload: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return;
    }
    if (this.socket.readyState === WebSocket.CONNECTING) this.queue.push(payload);
  }

  relay(data: unknown): void {
    this.send({ t: 's', data });
  }

  close(): void {
    this.closedByUs = true;
    this.socket.close();
  }
}

/* ------------------------- ICE ------------------------- */

async function loadIceServers(signalUrl: string): Promise<string[]> {
  try {
    const base = new URL(signalUrl);
    const url = `${base.protocol === 'wss:' ? 'https' : 'http'}://${base.host}/ice`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { iceServers?: unknown };
    const servers = normalizeIceServers(body.iceServers) as Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
    if (servers.length > 0) return stringifyIce(servers);
  } catch {
    /* fall through to public STUN */
  }
  return stringifyIce(DEFAULT_STUN as Array<{ urls: string | string[] }>);
}

function stringifyIce(
  servers: Array<{ urls: string | string[]; username?: string; credential?: string }>,
): string[] {
  const out: string[] = [];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      const parts = [url];
      if (server.username) parts.push(server.username);
      if (server.credential) parts.push(server.credential);
      out.push(parts.join(':'));
    }
  }
  return out;
}

/* ------------------------- peer ------------------------- */

type ControlHandler = (message: Record<string, unknown>) => void;

class Peer {
  private readonly pc: InstanceType<typeof PeerConnection>;
  channel: InstanceType<typeof PeerConnection> extends never ? never : NonNullable<ReturnType<InstanceType<typeof PeerConnection>['createDataChannel']>> | null = null;
  private readonly pendingIce: Array<{ candidate: string; mid: string }> = [];
  private remoteSdp: string | null = null;
  private remoteSet = false;
  private password = '';
  private spake: ReturnType<typeof proverStart> | null = null;
  private verifier: ReturnType<typeof verifierStart> | null = null;
  private handshakeDone = false;
  private controlHandler: ControlHandler | null = null;

  constructor(
    private readonly role: 'sender' | 'receiver',
    iceServers: string[],
    private readonly relay: (payload: Record<string, unknown>) => void,
    handlers: {
      onOpen: () => void;
      onClosed: () => void;
      onFingerprint: (words: string[]) => void;
      onHandshakeFailed: () => void;
    },
  ) {
    this.pc = new PeerConnection(`pol-cli-${randomUUID().slice(0, 8)}`, { iceServers });

    this.pc.onLocalDescription((sdp: string, type: string) => {
      this.relay({ kind: type === 'offer' ? 'offer' : 'answer', sdp });
    });
    this.pc.onLocalCandidate((candidate: string, mid: string) => {
      this.relay({ kind: 'ice', candidate: { candidate, sdpMid: mid } });
    });
    this.pc.onStateChange((state: string) => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        handlers.onClosed();
      }
    });

    if (role === 'sender') {
      this.attach(this.pc.createDataChannel('pol', { ordered: true }), handlers);
    } else {
      this.pc.onDataChannel((channel: unknown) => {
        this.attach(
          channel as Parameters<Peer['attach']>[0],
          handlers,
        );
      });
    }
  }

  armSpake(password: string): void {
    this.password = password;
    if (this.role === 'sender') this.spake = proverStart(password);
  }

  setControlHandler(handler: ControlHandler): void {
    this.controlHandler = handler;
  }

  private attach(
    channel: {
      onOpen(cb: () => void): void;
      onClosed(cb: () => void): void;
      onError(cb: (message: string) => void): void;
      onMessage(cb: (message: string | ArrayBuffer) => void): void;
      sendMessage(text: string): boolean;
    },
    handlers: { onOpen: () => void; onClosed: () => void },
  ): void {
    this.channel = channel;
    channel.onOpen(() => {
      // Sender opens the handshake; the receiver just waits.
      if (this.role === 'sender' && this.spake) {
        this.sendControl({ kind: 'spake', step: 'share', share: bytesToHex(this.spake.shareP) });
      }
      handlers.onOpen();
    });
    channel.onClosed(() => handlers.onClosed());
    channel.onError(() => handlers.onClosed());
    channel.onMessage((raw) => {
      if (typeof raw === 'string') {
        this.handleText(raw, handlers);
        return;
      }
      this.onBinary?.(new Uint8Array(raw));
    });
  }

  traceBinary = false;
  traceCount = 0;

  /** Binary payloads flow to the transfer logic (send pump / receive writer). */
  onBinary: ((bytes: Uint8Array) => void) | null = null;

  private handleText(text: string, handlers: { onClosed: () => void }): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const step = message.step;
    try {
      if (step === 'share' && this.role === 'receiver') {
        this.verifier = verifierStart(this.password, hexToBytes(String(message.share ?? '')));
        this.sendControl({
          kind: 'spake',
          step: 'confirm',
          share: bytesToHex(this.verifier.shareV),
          confirm: bytesToHex(this.verifier.confirmV),
        });
        return;
      }
      if (step === 'confirm' && this.spake) {
        const finished = proverFinish(
          this.spake.state,
          hexToBytes(String(message.share ?? '')),
          hexToBytes(String(message.confirm ?? '')),
        );
        this.sendControl({ kind: 'spake', step: 'finish', confirm: bytesToHex(finished.confirmP) });
        this.handshakeDone = true;
        this.emitFingerprint(finished.kMain);
        return;
      }
      if (step === 'finish' && this.verifier) {
        const finished = verifierFinish(this.verifier.state, hexToBytes(String(message.confirm ?? '')));
        this.handshakeDone = true;
        this.emitFingerprint(finished.kMain);
        return;
      }
    } catch {
      if (!this.handshakeDone) handlers.onClosed();
      return;
    }
    this.controlHandler?.(message);
  }

  private emitFingerprint(kMain: Uint8Array): void {
    const local = this.pc.localDescription();
    const remote = this.remoteSdp;
    const localSdp = local?.sdp ?? null;
    if (!localSdp || !remote) {
      this.onFingerprintEmpty();
      return;
    }
    const [localFp] = fingerprintsFromSdp(localSdp);
    const [remoteFp] = fingerprintsFromSdp(remote);
    if (!localFp || !remoteFp) {
      this.onFingerprintEmpty();
      return;
    }
    const senderFp = this.role === 'sender' ? localFp : remoteFp;
    const receiverFp = this.role === 'sender' ? remoteFp : localFp;
    this.fingerprintHandler(fingerprintWords(kMain, senderFp, receiverFp, this.password));
  }

  fingerprintHandler: ((words: string[]) => void) | null = null;
  onFingerprintEmpty: (() => void) | null = null;

  private sendControl(payload: Record<string, unknown>): void {
    this.channel?.sendMessage(JSON.stringify(payload));
  }

  async handleSignal(payload: Record<string, unknown>): Promise<void> {
    if (payload.kind === 'ice') {
      const candidate = (payload.candidate as { candidate?: string } | undefined)?.candidate ?? '';
      const mid = (payload.candidate as { sdpMid?: string } | undefined)?.sdpMid ?? '0';
      if (this.remoteSet) this.pc.addRemoteCandidate(candidate, mid);
      else this.pendingIce.push({ candidate, mid });
      return;
    }
    if ((payload.kind === 'offer' || payload.kind === 'answer') && typeof payload.sdp === 'string') {
      this.remoteSdp = payload.sdp;
      this.pc.setRemoteDescription(payload.sdp, String(payload.kind));
      this.remoteSet = true;
      for (const { candidate, mid } of this.pendingIce.splice(0)) {
        this.pc.addRemoteCandidate(candidate, mid);
      }
    }
  }

  bufferedAmount(): number {
    return this.channel ? this.channel.bufferedAmount() : Number.MAX_SAFE_INTEGER;
  }

  sendBinary(bytes: Uint8Array): void {
    this.channel?.sendMessageBinary(bytes);
  }

  sendJson(payload: Record<string, unknown>): void {
    this.channel?.sendMessage(JSON.stringify(payload));
  }

  offer(): void {
    this.pc.setLocalDescription('offer');
  }

  close(): void {
    this.channel?.close();
    this.pc.close();
  }
}

/* ------------------------- send ------------------------- */

async function cmdSend(filePath: string): Promise<never> {
  const absolute = resolve(filePath);
  let size = 0;
  try {
    size = statSync(absolute).size;
  } catch {
    die(`فایل پیدا نشد: ${absolute}`);
  }

  const room = formatCode(makeCode());
  log(`کد: ${room}`);
  log('این کد را در qqsp.ir (تب گرفتن) بزن. منتظر وصل‌شدن…');

  const signalUrl = process.env.POL_SIGNAL_URL ?? 'wss://qqsp.ir/signal';
  const iceServers = await loadIceServers(signalUrl);

  let peer: Peer | null = null;
  let closed = false;
  let pumpDone = false;

  const signal = new Signal(signalUrl, room, 'sender', (message) => {
    if (message.t === 'ready') {
      peer = new Peer('sender', iceServers, (payload) => signal.relay(payload), {
        onOpen: () => {
          if (!pumpDone) void pump(peer as Peer, absolute, size);
        },
        onClosed: () => {
          if (!pumpDone) die('کانال وسط انتقال بسته شد.', 4);
        },
        onFingerprint: (words) => {
          log(`کد امنیتی نشست: ${words.join(' ')}`);
          log('این شش کلمه باید روی صفحهٔ مرورگر طرف مقابل همین باشد.');
        },
        onHandshakeFailed: () => die('کد دو طرف هم‌خوانی نیست — handshake رد شد.', 3),
      });
      (peer as Peer).fingerprintHandler = (words) => {
        log(`کد امنیتی نشست: ${words.join(' ')}`);
        log('این شش کلمه باید روی صفحهٔ مرورگر طرف مقابل همین باشد.');
      };
      (peer as Peer).armSpake(room);
      (peer as Peer).offer();
      return;
    }
    if (message.t === 's' && peer) {
      void peer.handleSignal((message.data ?? {}) as Record<string, unknown>);
      return;
    }
    if (message.t === 'full') die('این کد همین حالا در حال استفاده است.');
    if (message.t === 'peer-left') die('طرف مقابل قطع شد.');
    if (message.t === 'error') {
      die(`سرور سیگنالینگ درخواست را نپذیرفت: ${message.message ?? 'unknown'}`);
    }
  }, () => {
    if (!closed) {
      closed = true;
      die('ارتباط با سرور سیگنالینگ قطع شد.', 2);
    }
  });

  let acked = false;
  let ackHash = '';

  async function pump(active: Peer, path: string, total: number): Promise<void> {
    pumpDone = false;
    let receiverReady = false;
    let readyResolve: (() => void) | null = null;
    const readyPromise = new Promise<void>((done) => {
      readyResolve = done;
    });
    active.setControlHandler((message) => {
      if (message.kind === 'ready') {
        // The receiver answers with its resume offset; the CLI always sends
        // fresh (no resume support), but the protocol handshake is mandatory.
        receiverReady = true;
        readyResolve?.();
        return;
      }
      if (message.kind === 'done') {
        acked = true;
        ackHash = typeof message.hash === 'string' ? message.hash : '';
        if (message.ok !== true) die('گیرنده هش را رد کرد — فایل ناقص رسیده.');
      }
    });
    active.onBinary = null;

    // Web client flow: meta first, then wait for the receiver's ready.
    active.sendJson({
      kind: 'meta',
      name: basename(path),
      size: total,
      mime: 'application/octet-stream',
      hash: null,
      modified: statSync(path).mtimeMs,
    });
    const readyTimeout = setTimeout(() => {
      if (!receiverReady) die('گیرنده آماده نشد (no ready).', 4);
    }, SIGNAL_TIMEOUT_MS);
    await readyPromise;
    clearTimeout(readyTimeout);

    const hash = new Sha256();
    const fh = await open(path, 'r');
    let budget = HIGH_WATER;
    const refill = setInterval(() => {
      budget = HIGH_WATER;
    }, 40);
    let offset = 0;
    let painted = 0;
    try {
      while (offset < total) {
        const length = Math.min(READ_SIZE, total - offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buffer, 0, length, offset);
        if (bytesRead === 0) die('خواندن فایل ناتمام ماند (EOF زودهنگام).', 4);
        const block = new Uint8Array(buffer.subarray(0, bytesRead));
        hash.update(block);
        for (let inner = 0; inner < block.byteLength; inner += CHUNK) {
          const end = Math.min(inner + CHUNK, block.byteLength);
          if (budget <= 0) {
            await sleep(5);
            continue;
          }
          budget -= end - inner;
          active.sendBinary(new Uint8Array(block.subarray(inner, end)));
          offset += end - inner;
        }
        if (Date.now() - painted > 400) {
          painted = Date.now();
          process.stdout.write(`\r${formatBytes(offset)} از ${formatBytes(total)}`);
        }
      }
      clearInterval(refill);
      process.stdout.write(`\r${formatBytes(total)} از ${formatBytes(total)} — منتظر تأیید…\n`);
      active.sendJson({ kind: 'end', hash: hash.digestHex() });

      const deadline = Date.now() + DONE_TIMEOUT_MS;
      while (Date.now() < deadline && !acked) await sleep(100);
      if (!acked) die('گیرنده در زمان مقرر تأیید نکرد.', 4);
      log(`تمام شد. هش تأیید شد: ${ackHash.slice(0, 16)}…`);
      pumpDone = true;
      peer?.close();
      signal.close();
      process.exit(0);
    } finally {
      clearInterval(refill);
      await fh.close();
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  // Keep the process alive while the socket works; exit paths are explicit.
  setInterval(() => undefined, 60_000).unref?.();
}

/* ------------------------- receive ------------------------- */

async function cmdReceive(codeInput: string, outDir: string): Promise<never> {
  const words = parseCode(codeInput);
  if (!words) {
    die('کد باید چهار کلمه از فهرست پل باشد. مثال: آب باد ماه گل');
  }
  const room = formatCode(words);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  log(`در حال وصل‌شدن با کد: ${room}`);

  const signalUrl = process.env.POL_SIGNAL_URL ?? 'wss://qqsp.ir/signal';
  const iceServers = await loadIceServers(signalUrl);

  let peer: Peer | null = null;
  let closed = false;
  let metaSeen = false;
  let finished = false;

  let stream: ReturnType<typeof createWriteStream> | null = null;
  let hash: Sha256 | null = null;
  let received = 0;
  let expected = 0;
  let name = 'file';
  let painted = 0;

  const signal = new Signal(signalUrl, room, 'receiver', (message) => {
    if (message.t === 'ready') {
      peer = new Peer('receiver', iceServers, (payload) => signal.relay(payload), {
        onOpen: () => log('وصل شد. منتظر فایل…'),
        onClosed: () => {
          if (metaSeen && !finished) die('کانال وسط انتقال بسته شد.', 4);
        },
        onFingerprint: (wordsOut) => {
          log(`کد امنیتی نشست: ${wordsOut.join(' ')}`);
          log('این شش کلمه باید روی ترمینال فرستنده همین باشد — مقایسه کن.');
        },
        onHandshakeFailed: () => die('کد دو طرف هم‌خوانی نیست — handshake رد شد.', 3),
      });
      (peer as Peer).fingerprintHandler = (wordsOut) => {
        log(`کد امنیتی نشست: ${wordsOut.join(' ')}`);
        log('این شش کلمه باید روی ترمینال فرستنده همین باشد — مقایسه کن.');
      };
      (peer as Peer).armSpake(room);
      (peer as Peer).traceBinary = Boolean(process.env.POL_TRACE);
      (peer as Peer).onBinary = (bytes) => {
        received += bytes.byteLength;
        // The binary callback can fire before the meta control message is
        // processed (both arrive in the same ordered stream but different
        // callbacks); a lazy hash keeps the digest correct either way.
        if (!hash) hash = new Sha256();
        if (received === bytes.byteLength) {
        }
        hash.update(bytes);
        stream?.write(Buffer.from(bytes));
        if (Date.now() - painted > 400) {
          painted = Date.now();
          process.stdout.write(`\r${formatBytes(received)} از ${formatBytes(expected)}`);
        }
      };
      (peer as Peer).setControlHandler((control) => {
        if (control.kind === 'meta') {
          expected = Number(control.size) || 0;
          name = String(control.name ?? 'file');
          stream = createWriteStream(resolve(outDir, basename(name)), { flags: 'w' });
          // hash may already hold early bytes (see onBinary); keep it.
          if (!hash) hash = new Sha256();
          received = 0;
          metaSeen = true;
          peer?.sendJson({ kind: 'ready', offset: 0 });
          process.stdout.write(`فایل: ${name} (${formatBytes(expected)})\n`);
          return;
        }
        if (control.kind === 'end') {
          void finish(String(control.hash ?? ''));
        }
      });
      return;
    }
    if (message.t === 's' && peer) {
      void peer.handleSignal((message.data ?? {}) as Record<string, unknown>);
      return;
    }
    if (message.t === 'error') {
      die(`سرور سیگنالینگ درخواست را نپذیرفت: ${message.message ?? 'unknown'}`);
    }
  }, () => {
    if (!closed) {
      closed = true;
      die('ارتباط با سرور سیگنالینگ قطع شد.', 2);
    }
  });

  async function finish(declared: string): Promise<void> {
    finished = true;
    await new Promise<void>((done) => {
      if (!stream) return done();
      stream.end(() => done());
    });
    const receivedHash = hash?.digestHex() ?? '';
    const ok = receivedHash === declared && received === expected;
    if (ok) {
      log(`\nتمام شد: ${name} — هش تأیید شد (${receivedHash.slice(0, 16)}…).`);
    } else {
      log(`\nهش نمی‌خواند: انتظار ${declared.slice(0, 16)}…، دریافتی ${receivedHash.slice(0, 16)}…`);
    }
    peer?.close();
    signal.close();
    process.exit(ok ? 0 : 4);
  }

  setInterval(() => undefined, 60_000).unref?.();
}

/* ------------------------- argument parsing ------------------------- */

const sleepFor = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
void sleepFor;

const args = process.argv.slice(2);
const command = args[0];

if (command === 'send') {
  const value = args[1];
  if (!value) die('استفاده: node cli/pol.mjs send <file>');
  void cmdSend(value);
} else if (command === 'receive') {
  const code = args.slice(1).join(' ');
  if (!code) die('استفاده: node cli/pol.mjs receive <چهار کلمه>');
  const out = process.env.POL_OUT ?? process.cwd();
  void cmdReceive(code, out);
} else {
  log('پل — انتقال مستقیم فایل بین ترمینال و مرورگر.');
  log('');
  log('  node cli/pol.ts send <file>          کد می‌گیری و فایل می‌فرستی');
  log('  node cli/pol.ts receive <چهار کلمه>  می‌پیوندی و فایل می‌گیری');
  log('');
  log('POL_SIGNAL_URL  آدرس سرور سیگنالینگ (پیش‌فرض wss://qqsp.ir/signal)');
  log('POL_OUT         پوشهٔ خروجی برای receive (پیش‌فرض پوشهٔ جاری)');
  if (command && command !== 'help' && command !== '--help') process.exit(1);
}
