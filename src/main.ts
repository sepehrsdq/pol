import './styles.css';
import {
  formatBytes,
  formatDuration,
  formatInt,
  formatPercent,
  formatSpeed,
  shortenName,
} from './lib/format';
import { setupReveal } from './lib/reveal';
import { APP_VERSION } from './lib/version';
import { cleanupStaleFiles, hasOpfs } from './lib/receive-store';
import { encodeQr, type QrMatrix } from './lib/qr';
import { trace } from './lib/trace';
import { formatCode, makeCode, parseCode } from './lib/words';
import { loadIceServers } from './net/ice';
import { defaultSignalUrl, SignalClient, type ServerMessage } from './net/signal';
import {
  getTransferTuning,
  setTransferTuning,
  Transfer,
  type FolderEntry,
  type FileMeta,
  type SignalPayload,
  type TransferDiagnostics,
  type TransferRole,
} from './net/transfer';

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}

const debug = (...args: unknown[]): void => {
  trace(...args);
};

const bridge = el<HTMLDivElement>('bridge');
const tabs = {
  send: el<HTMLButtonElement>('tab-send'),
  receive: el<HTMLButtonElement>('tab-receive'),
};
const views = {
  send: el<HTMLDivElement>('send-view'),
  receive: el<HTMLDivElement>('receive-view'),
};
const drop = el<HTMLLabelElement>('drop');
const fileInput = el<HTMLInputElement>('file');
const folderInput = el<HTMLInputElement>('folder');
const textInput = el<HTMLTextAreaElement>('text-input');
const sendTextButton = el<HTMLButtonElement>('send-text');
const pasteTextButton = el<HTMLButtonElement>('paste-text');
const codeCard = el<HTMLDivElement>('code-card');
const codeBox = el<HTMLDivElement>('code');
const picked = el<HTMLParagraphElement>('picked');
const copyButton = el<HTMLButtonElement>('copy-code');
const cancelButton = el<HTMLButtonElement>('cancel');
const copyLinkButton = el<HTMLButtonElement>('copy-link');
const qrBox = el<HTMLDivElement>('qr');
const joinForm = el<HTMLFormElement>('join-form');
const codeInput = el<HTMLInputElement>('code-input');
const alertBox = el<HTMLParagraphElement>('alert');
const statusLine = el<HTMLParagraphElement>('status');
const fingerprintCard = el<HTMLDivElement>('fingerprint');
const fingerprintWords = el<HTMLDivElement>('fingerprint-words');
const progressCard = el<HTMLDivElement>('progress-card');
const progressName = el<HTMLSpanElement>('progress-name');
const progressPct = el<HTMLSpanElement>('progress-pct');
const bar = el<HTMLDivElement>('bar');
const barFill = el<HTMLDivElement>('bar-fill');
const progressSize = el<HTMLSpanElement>('progress-size');
const progressSpeed = el<HTMLSpanElement>('progress-speed');
const sessionMeta = el<HTMLDivElement>('session-meta');
const sessionCount = el<HTMLSpanElement>('session-count');
const sessionTotal = el<HTMLSpanElement>('session-total');
const sessionEta = el<HTMLSpanElement>('session-eta');
const sessionBarWrap = el<HTMLDivElement>('session-bar-wrap');
const sessionBar = el<HTMLDivElement>('session-bar');
const sessionBarFill = el<HTMLDivElement>('session-bar-fill');
const sessionFiles = el<HTMLDivElement>('session-files');
const sessionList = el<HTMLUListElement>('session-list');
const result = el<HTMLDivElement>('result');
const resultTitle = el<HTMLParagraphElement>('result-title');
const resultHash = el<HTMLParagraphElement>('result-hash');
const resultMark = el<SVGGraphicsElement>('result-mark');
const resultSession = el<HTMLParagraphElement>('result-session');
const sessionClose = el<HTMLButtonElement>('session-close');
const download = el<HTMLAnchorElement>('download');
const resultText = el<HTMLPreElement>('result-text');
const copyTextButton = el<HTMLButtonElement>('copy-text');
const themeToggle = el<HTMLButtonElement>('theme-toggle');

/** Version shown beside the maker's name; mirrors package.json. */
const versionBadge = document.getElementById('app-version');
if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;

const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One scroll listener drives both the reading hairline and the header: while
 * the cover is under it the bar is transparent with light text, and it turns
 * into the paper bar the moment the page moves. Everything is a class and a
 * single rAF paint.
 */
function setupChrome(): void {
  const line = document.getElementById('topline');
  const header = document.getElementById('top');
  let queued = false;

  const paint = (): void => {
    queued = false;
    const room = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = room > 0 ? Math.min(1, Math.max(0, window.scrollY / room)) : 0;
    line?.style.setProperty('--progress', ratio.toFixed(4));
    header?.classList.toggle('is-scrolled', window.scrollY > 24);
  };

  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  paint();
}

/**
 * A soft light that follows the pointer across the headline. Fine pointers
 * only, off for reduced motion, and it never touches layout.
 */
function setupHeroSpotlight(): void {
  const copy = document.querySelector<HTMLElement>('.hero-copy');
  if (!copy) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (reducedMotion()) return;

  let queued = false;
  let x = 50;
  let y = 40;
  const paint = (): void => {
    queued = false;
    copy.style.setProperty('--spot-x', `${x.toFixed(1)}%`);
    copy.style.setProperty('--spot-y', `${y.toFixed(1)}%`);
  };
  copy.addEventListener('pointermove', (event) => {
    const rect = copy.getBoundingClientRect();
    x = ((event.clientX - rect.left) / rect.width) * 100;
    y = ((event.clientY - rect.top) / rect.height) * 100;
    copy.classList.add('is-spot');
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  });
  copy.addEventListener('pointerleave', () => copy.classList.remove('is-spot'));
}

/**
 * The diagram leans a few degrees towards the pointer. Small on purpose: the
 * numbers inside have to stay readable. Touch and reduced motion get nothing.
 */
function setupArtTilt(): void {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (reducedMotion()) return;

  const limit = 5.5;
  let frame = 0;
  let tiltX = 0;
  let tiltY = 0;

  const paint = (): void => {
    frame = 0;
    bridge.style.transform = `perspective(1200px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`;
  };

  bridge.addEventListener('pointermove', (event) => {
    const rect = bridge.getBoundingClientRect();
    const dx = (event.clientX - rect.left) / rect.width - 0.5;
    const dy = (event.clientY - rect.top) / rect.height - 0.5;
    tiltX = -dy * limit;
    tiltY = dx * limit * 1.6;
    bridge.classList.add('is-tilting');
    if (frame) return;
    frame = requestAnimationFrame(paint);
  });

  bridge.addEventListener('pointerleave', () => {
    bridge.classList.remove('is-tilting');
    bridge.style.transform = '';
  });
}

/** "Send a file" is the picker, not a scroll: one click, one dialog. */
function setupStartButton(): void {
  const start = document.getElementById('start');
  const section = document.getElementById('transfer');
  if (!start || !section) return;

  start.addEventListener('click', () => {
    if (mode !== 'send') setMode('send');
    section.scrollIntoView({ block: 'center' });
    if (!busy) fileInput.click();
  });
}

/**
 * SMIL keeps its own clock, so reduced motion has to stop it explicitly. The
 * packets are hidden by CSS; this stops the timeline from running for nothing.
 */
function setupStillArt(): void {
  if (!reducedMotion()) return;
  for (const svg of document.querySelectorAll('svg')) {
    const timeline = svg as SVGSVGElement;
    if (typeof timeline.pauseAnimations === 'function') timeline.pauseAnimations();
  }
}

setupChrome();
setupHeroSpotlight();
setupArtTilt();
setupStartButton();
setupStillArt();


interface SessionFile {
  name: string;
  size: number;
  ok: boolean;
}

/** One shared session: a room stays open for several files in a row. */
const session = {
  active: false,
  role: 'sender' as TransferRole,
  files: [] as SessionFile[],
  bytes: 0,
};

let mode: 'send' | 'receive' = 'send';
let signal: SignalClient | null = null;
let transfer: Transfer | null = null;
let activeWords: string[] | null = null;
let receivedName = 'file';
let downloadUrl: string | null = null;
let busy = false;
let lastAttempt: { role: TransferRole; room: string } | null = null;
let sampleTime = 0;
let sampleBytes = 0;
let speed = 0;
let lastPaint = 0;
/** Done-bytes of the file in flight, so the session total reflects it live. */
let currentFileDone = 0;
/** Bytes the sender promised so far, receiver-side (sums of meta.size). */
let sessionBytesTotal = 0;
/** Size and name of the file currently in flight, for the session list. */
let lastFileSize = 0;
let lastSentName = 'file';
let lastFileMime = 'application/octet-stream';
/** File already counted into the session total, so a retry does not double it. */
let countedSendKey: string | null = null;
let countedReceiveKey: string | null = null;
/** What the last finished receive actually produced (debug/test hook). */
let lastVerified: { size: number; expected: number; ok: boolean } | null = null;
/** Receiver-side window: first byte in → file verified (debug/test hook). */
let receiveStartedAt = 0;
let receiveEndedAt = 0;
/** Last progress event: separates streaming from finishing the file. */
let receiveLastProgressAt = 0;
/** Automatic reconnects after a dropped channel, so a loop cannot spin. */
let reconnectAttempts = 0;
/** Comparable session words this side computed (debug/test hook). */
let lastFingerprintWords: string[] = [];
/** The e2e reload test turns this off to simulate a user who walks away. */
let autoRetry = true;

let connectAttempt = 0;

function setMode(next: 'send' | 'receive'): void {
  if (mode === next) return;
  if (busy) reset();
  mode = next;

  const isSend = next === 'send';
  tabs.send.classList.toggle('is-active', isSend);
  tabs.receive.classList.toggle('is-active', !isSend);
  tabs.send.setAttribute('aria-selected', String(isSend));
  tabs.receive.setAttribute('aria-selected', String(!isSend));
  views.send.hidden = !isSend;
  views.receive.hidden = isSend;

  hideAlert();
  hideResult();
  progressCard.hidden = true;
  sessionFiles.hidden = true;
  hideFingerprint();
  setStatus(null);
}

function setStatus(text: string | null, live = false): void {
  statusLine.hidden = text === null;
  statusLine.textContent = text ?? '';
  statusLine.classList.toggle('is-live', live);
}

function hideAlert(): void {
  alertBox.hidden = true;
  alertBox.textContent = '';
}

const ROUTE_LABELS: Record<string, string> = {
  host: 'محلی',
  srflx: 'عمومی',
  relay: 'رله',
};

function describeRoutes(detail: TransferDiagnostics): string {
  const labels = detail.candidates.map((type) => ROUTE_LABELS[type] ?? type);
  return `مسیرهای پیدا شده: ${labels.length > 0 ? labels.join('، ') : 'هیچ مسیری'}`;
}

function showAlert(message: string, retry?: () => void, detail?: TransferDiagnostics): void {
  alertBox.textContent = message;
  alertBox.hidden = false;

  if (detail) {
    const meta = document.createElement('p');
    meta.className = 'alert-meta';
    meta.textContent = describeRoutes(detail);
    alertBox.append(meta);
  }

  if (!retry) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost';
  button.textContent = 'تلاش دوباره';
  button.addEventListener('click', () => {
    hideAlert();
    retry();
  });
  alertBox.append(button);
}

/**
 * Rejoin the same room after a drop. Bounded, so a dead room cannot loop.
 * Returns false when there is nothing to rejoin or the budget is spent.
 */
function scheduleResume(delay = 900): boolean {
  const attempt = lastAttempt;
  if (!autoRetry || !attempt || reconnectAttempts >= 2) return false;
  reconnectAttempts += 1;
  setStatus('اتصال قطع شد؛ ادامهٔ همان فایل را وصل می‌کنم…', true);
  window.setTimeout(() => {
    hideAlert();
    void connect(attempt.role, attempt.room);
  }, delay);
  return true;
}

function hideResult(): void {
  result.hidden = true;
  result.classList.remove('is-ok', 'is-warn', 'is-animated');
  resultMark.classList.remove('is-drawn', 'is-fail');
  download.hidden = true;
  resultText.hidden = true;
  resultText.textContent = '';
  copyTextButton.hidden = true;
  sessionClose.hidden = true;
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
}

function setBar(ratio: number): void {
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  barFill.style.width = `${percent}%`;
  bar.setAttribute('aria-valuenow', String(percent));
  progressPct.textContent = formatPercent(percent / 100);
}

function resetProgress(): void {
  sampleTime = 0;
  sampleBytes = 0;
  speed = 0;
  lastPaint = 0;
  setBar(0);
  progressSize.textContent = '';
  progressSpeed.textContent = '';
}

/* ---------- session state (v0.3: several files per room) ---------- */

function sessionStart(role: TransferRole): void {
  session.active = true;
  session.role = role;
  session.files = [];
  session.bytes = 0;
  sessionBytesTotal = 0;
  currentFileDone = 0;
  countedSendKey = null;
  countedReceiveKey = null;
  sessionFiles.hidden = true;
  sessionList.replaceChildren();
}

function sessionEnd(): void {
  session.active = false;
  sessionBytesTotal = 0;
  currentFileDone = 0;
  sessionMeta.hidden = true;
  sessionBarWrap.hidden = true;
}

function renderSessionMeta(): void {
  const count = session.files.length;
  const total = session.bytes + currentFileDone;
  sessionMeta.hidden = count === 0 && total === 0;
  sessionCount.textContent = count > 0 ? `فایل ${formatInt(count)}` : '';
  sessionTotal.textContent = total > 0 ? `مجموع ${formatBytes(total)}` : '';
}

function renderSessionBar(): void {
  sessionBarWrap.hidden = sessionBytesTotal <= 0;
  if (sessionBytesTotal <= 0) return;
  const ratio = Math.min(1, (session.bytes + currentFileDone) / sessionBytesTotal);
  const percent = Math.round(ratio * 100);
  sessionBarFill.style.width = `${percent}%`;
  sessionBar.setAttribute('aria-valuenow', String(percent));
}

/** Remaining time for the whole session, from the live speed. */
function renderSessionEta(remainingBytes: number): void {
  if (!session.active || remainingBytes <= 0 || speed <= 0) {
    sessionEta.textContent = '';
    sessionEta.classList.remove('is-ticking');
    return;
  }
  const text = formatDuration(remainingBytes / speed);
  sessionEta.textContent = text ? `حدود ${text} مانده` : '';
  sessionEta.classList.toggle('is-ticking', Boolean(text));
}

function addSessionFile(entry: SessionFile): void {
  session.files.push(entry);
  session.bytes += entry.size;
  sessionFiles.hidden = false;

  const item = document.createElement('li');
  item.className = `session-item ${entry.ok ? 'is-ok' : 'is-warn'}`;

  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('aria-hidden', 'true');
  mark.classList.add('session-item-mark');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  mark.append(path);

  const name = document.createElement('bdi');
  name.dir = 'auto';
  name.textContent = shortenName(entry.name);

  const size = document.createElement('span');
  size.className = 'session-item-size';
  size.textContent = formatBytes(entry.size);

  item.append(mark, name, size);
  sessionList.append(item);
}

/** Pop the result card in: scale + settle. Re-triggerable per file. */
function playResultAnimation(ok: boolean): void {
  result.classList.remove('is-animated', 'is-ok', 'is-warn');
  // Force a reflow so the animation restarts for the next file.
  void result.offsetWidth;
  result.classList.add('is-animated');
  if (ok) {
    resultMark.classList.remove('is-fail');
    resultMark.classList.add('is-drawn');
  } else {
    resultMark.classList.add('is-fail');
    resultMark.classList.remove('is-drawn');
  }
}

function teardown(): void {
  transfer?.close();
  transfer = null;
  signal?.close();
  signal = null;
  busy = false;
  bridge.classList.remove('is-active');
}

/** ICE servers of the current session, reused when only the peer is rebuilt. */
let iceServers: RTCIceServer[] = [];

/**
 * Rebuild just the peer connection over the socket that already exists.
 *
 * A dropped data channel is not a dropped room: rejoining would close this
 * tab's socket, which the peer sees as "peer-left", and both sides would then
 * chase each other's reconnects. Keeping the seats and renegotiating in place
 * leaves the room untouched.
 */
function restartPeer(role: TransferRole, delay = 0, quiet = false): void {
  if (!signal) return;
  const attempt = ++connectAttempt;
  const build = (): void => {
    if (attempt !== connectAttempt || !signal) return;
    transfer?.close();
    transfer = buildTransfer(role, iceServers);
    if (activeWords) transfer.armHandshake(formatCode(activeWords), null);
    hideAlert();
    if (quiet) {
      if (role === 'sender') void transfer.startOffer();
      return;
    }
    busy = true;
    if (role === 'sender') {
      setStatus('اتصال را از نو می‌سازم؛ ادامهٔ همان فایل…', true);
      void transfer.startOffer();
    } else {
      setStatus('اتصال را از نو می‌سازم؛ منتظر ادامهٔ فایل…', true);
    }
  };
  if (delay > 0) window.setTimeout(build, delay);
  else build();
}

function reset(): void {
  teardown();
  sessionEnd();
  setStatus(null);
  progressCard.hidden = true;
  hideResult();
  hideAlert();
  hideFingerprint();
  codeCard.hidden = true;
}

function trackProgress(done: number, total: number): boolean {
  const now = performance.now();
  if (sampleTime === 0) {
    sampleTime = now;
    sampleBytes = done;
  } else if (now - sampleTime >= 300) {
    speed = ((done - sampleBytes) * 1000) / (now - sampleTime);
    sampleTime = now;
    sampleBytes = done;
  }

  // Chunks arrive many times per frame; repaint at most ~10 times a second.
  const complete = total > 0 && done >= total;
  if (!complete && now - lastPaint < 90) return false;
  lastPaint = now;

  const ratio = total > 0 ? done / total : 0;
  setBar(ratio);
  progressSize.textContent = total > 0 ? `${formatBytes(done)} از ${formatBytes(total)}` : formatBytes(done);
  progressSpeed.textContent = speed > 0 ? formatSpeed(speed) : '';
  return true;
}

function describeError(code: string, detail?: TransferDiagnostics): string {
  switch (code) {
    case 'connection-failed': {
      const routes = detail?.candidates ?? [];
      if (routes.length === 0) {
        return 'مرورگر هیچ مسیری برای اتصال پیدا نکرد. اگر فایروال یا آنتی‌ویروس جلوی مرورگر را گرفته، اجازه‌اش بده و دوباره تلاش کن.';
      }
      if (!routes.includes('srflx') && !routes.includes('relay')) {
        return 'دو دستگاه روی یک شبکه دیده شدند، ولی به هم نرسیدند. فایروال ویندوز یا جداسازی کلاینت در روتر معمولاً همین کار را می‌کند. اجازهٔ شبکه به مرورگر را چک کن یا با هات‌اسپات موبایل امتحان کن.';
      }
      return 'دو دستگاه به هم نرسیدند. یک بار دیگر بزن؛ اگر نشد، هات‌اسپات موبایل را امتحان کن.';
    }
    case 'channel-closed':
      return 'طرف مقابل قطع شد. اگر فایل ناقص مانده باشد، با همان فایل و همان کد ادامه‌اش می‌دهیم.';
    case 'storage-failed':
      return 'ذخیره‌کردن فایل روی دستگاه گیرنده نشد. جای خالی مرورگر را چک کن و دوباره تلاش کن.';
    case 'file-too-large':
      return `این انتقال از مسیر رله می‌گذرد و فعلاً تا ۲۰۰ مگابایت پذیرفته می‌شود. اگر هر دو دستگاه روی یک وای‌فای باشند، فایل‌های بزرگ‌تر هم بدون سقف می‌روند.`;
    case 'send-failed':
      return 'فرستادن متوقف شد. اگر طرف مقابل صفحه را بسته باشد، همان اتفاق افتاده است.';
    default:
      return 'اتصال قطع شد. یک بار دیگر تلاش کن.';
  }
}

function buildTransfer(role: TransferRole, iceServers: RTCIceServer[]): Transfer {
  // A transfer that has been replaced must not touch the page: its channel can
  // die seconds after the drop, and a late event would tear down whatever
  // connection replaced it.
  const owner: { current: Transfer | null } = { current: null };
  const live = (): boolean => owner.current !== null && owner.current === transfer;

  const built = new Transfer(role, iceServers, (payload: SignalPayload) => {
    if (live()) signal?.relay(payload);
  }, {
    onState: (state) => {
      if (!live()) return;
      if (state === 'open') {
        reconnectAttempts = 0;
        hideAlert();
        if (role === 'sender' && sending) {
          if (!session.active) sessionStart(role);
          void sendNext();
        }
      }
      if (state === 'closed' && busy) {
        busy = false;
        bridge.classList.remove('is-active');
      }
    },
    onMeta: (meta: FileMeta) => {
      if (!live()) return;
      if (role === 'receiver') {
        receiveStartedAt = 0;
        receiveEndedAt = 0;
        receiveLastProgressAt = 0;
      }
      progressCard.hidden = false;
      resetProgress();
      currentFileDone = 0;
      receivedName = meta.name;
      lastFileSize = meta.size;
      lastFileMime = meta.mime;
      if (!session.active) sessionStart(role);
      const key = `${meta.name}:${meta.size}`;
      if (countedReceiveKey !== key) {
        sessionBytesTotal += meta.size;
        countedReceiveKey = key;
      }
      progressName.textContent = shortenName(meta.name);
      progressSize.textContent = `۰ بایت از ${formatBytes(meta.size)}`;
      setStatus('فایل پیدا شد؛ انتقال شروع می‌شود.', true);
    },
    onResume: (offset, total) => {
      if (!live()) return;
      setStatus(`ادامهٔ همان فایل از ${formatBytes(offset)} از ${formatBytes(total)} — بقیه‌اش می‌رسد.`, true);
    },
    onProgress: (done, total) => {
      if (!live()) return;
      // First byte to final file: the benchmark's window, setup excluded.
      if (role === 'receiver' && receiveStartedAt === 0 && done > 0) {
        receiveStartedAt = performance.now();
      }
      if (role === 'receiver') receiveLastProgressAt = performance.now();
      // Counting bytes is cheap; laying out the page is not. The tracker owns
      // the paint interval, so the session strip rides along with it instead
      // of rewriting the DOM for every 64 KB chunk.
      currentFileDone = done;
      if (!trackProgress(done, total)) return;
      bridge.classList.add('is-active');
      if (session.active) {
        renderSessionMeta();
        renderSessionBar();
      }
      renderSessionEta(Math.max(0, total - done));
    },
    onVerified: ({ checked, ok, received, blob }) => {
      if (!live()) return;
      if (role === 'receiver') receiveEndedAt = performance.now();
      lastVerified = { size: blob?.size ?? 0, expected: lastFileSize, ok: checked && ok };
      busy = false;
      countedReceiveKey = null;
      bridge.classList.remove('is-active');
      setBar(1);
      setStatus(null);
      renderSessionEta(0);
      addSessionFile({
        name: receivedName,
        size: currentFileDone > 0 ? currentFileDone : lastFileSize,
        ok: checked && ok,
      });
      currentFileDone = 0;
      renderSessionMeta();
      renderSessionBar();
      playResultAnimation(checked && ok);
      if (!blob) return;

      downloadUrl = URL.createObjectURL(blob);
      download.href = downloadUrl;
      download.download = receivedName;
      download.hidden = false;

      result.hidden = false;
      // Text snippets get an inline view and a copy button instead of download.
      const isText = lastFileMime.startsWith('text/');
      resultText.hidden = !isText;
      copyTextButton.hidden = !isText;
      download.hidden = isText;
      if (isText && blob) {
        void blob.text().then((text) => {
          resultText.textContent = text;
        });
      }

      if (!checked) {
        result.classList.add('is-warn');
        resultTitle.textContent = isText ? 'متن رسید، ولی بررسی سلامت انجام نشد.' : 'فایل رسید، ولی بررسی سلامت انجام نشد.';
        resultHash.textContent = '';
      } else if (ok) {
        result.classList.add('is-ok');
        resultTitle.textContent = isText ? 'متن رسید و سلامت آن تأیید شد.' : 'فایل رسید و سلامت آن تأیید شد.';
        resultHash.textContent = `SHA-256: ${received ?? ''}`;
      } else {
        result.classList.add('is-warn');
        resultTitle.textContent = isText ? 'متن رسید، ولی هش نمی‌خواند. ممکن است ناقص رسیده باشد.' : 'فایل رسید، ولی هش نمی‌خواند. ممکن است ناقص رسیده باشد.';
        resultHash.textContent = `SHA-256: ${received ?? ''}`;
      }
      resultSession.hidden = true;
      // The room stays open for the next file; say so, and offer a clean end.
      sessionClose.hidden = false;
      sessionClose.textContent = 'پایان نشست';
    },
    onFingerprint: (words) => {
      if (!live()) return;
      showFingerprint(words);
    },
    onHandshakeFailed: () => {
      if (!live()) return;
      busy = false;
      bridge.classList.remove('is-active');
      setStatus(null);
      hideResult();
      resetProgress();
      progressCard.hidden = true;
      showAlert('کد دو طرف هم‌خوانی ندارد یا مسیر دستکاری شده. یک کد تازه بگیر و دوباره تلاش کن.');
    },
    onAck: (ok, size) => {      if (!live()) return;
      busy = false;
      countedSendKey = null;
      // The receiver has confirmed (or rejected) the file, so a later
      // reconnect must not resend it; a drop before this point does.
      sending = null;
      bridge.classList.remove('is-active');
      progressCard.hidden = false;
      setBar(1);
      progressSpeed.textContent = '';
      setStatus(null);
      renderSessionEta(0);
      // The receiver reports the real byte count, so both sides agree even
      // when the ZIP size was only an estimate before streaming.
      addSessionFile({ name: lastSentName, size: size ?? lastFileSize, ok });
      currentFileDone = 0;
      renderSessionMeta();
      renderSessionBar();
      playResultAnimation(ok);

      result.hidden = false;
      result.classList.add(ok ? 'is-ok' : 'is-warn');
      resultTitle.textContent = ok
        ? 'طرف مقابل فایل را گرفت و هش تأیید شد.'
        : 'فایل رفت، ولی طرف مقابل گفت هش نمی‌خواند. یک بار دیگر بفرست.';
      resultHash.textContent = '';
      resultSession.hidden = true;
      sessionClose.hidden = false;
      sessionClose.textContent = 'پایان نشست';
    },
    onError: (code, detail) => {
      if (!live()) return;
      busy = false;
      bridge.classList.remove('is-active');
      setStatus(null);

      const attempt = lastAttempt;
      // A dead channel is repaired in place: the room and both seats stay as
      // they are, so nothing has to rejoin and nothing is counted twice.
      if (code === 'channel-closed' && autoRetry && attempt && reconnectAttempts < 2) {
        reconnectAttempts += 1;
        setStatus('اتصال قطع شد؛ ادامهٔ همان فایل را وصل می‌کنم…', true);
        showAlert(describeError(code, detail));
        // The sender offers, so it gives the receiver a moment to rebuild
        // first; the receiver builds at once and waits for the offer.
        restartPeer(attempt.role, attempt.role === 'sender' ? 600 : 150);
        return;
      }

      const canRetry =
        (code === 'connection-failed' || code === 'channel-closed') && attempt !== null;
      const retry = canRetry
        ? () => {
            // Let the old socket close on the server before rejoining.
            window.setTimeout(() => void connect(attempt.role, attempt.room), 600);
          }
        : undefined;

      showAlert(describeError(code, detail), retry, detail);
    },
  });

  owner.current = built;
  return built;
}

function beginSending(meta: { name: string; size: number }): void {
  busy = true;
  lastSentName = meta.name;
  lastFileSize = meta.size;
  // A resumed attempt announces the same file again; do not count it twice.
  const key = `${meta.name}:${meta.size}`;
  if (countedSendKey !== key) {
    sessionBytesTotal += meta.size;
    countedSendKey = key;
  }
  hideAlert();
  hideResult();
  progressCard.hidden = false;
  progressName.textContent = shortenName(meta.name);
  progressSpeed.textContent = '';
  setStatus('در حال فرستادن…', true);
  resetProgress();
  renderSessionMeta();
  renderSessionBar();
  bridge.classList.add('is-active');
}

async function connect(role: TransferRole, room: string): Promise<void> {
  const attempt = ++connectAttempt;
  teardown();
  busy = true;
  lastAttempt = { role, room };
  setStatus('در حال آماده‌کردن مسیر اتصال…', true);

  const ice = await loadIceServers(defaultSignalUrl());
  if (attempt !== connectAttempt || !busy) return;

  iceServers = ice.servers;
  transfer = buildTransfer(role, ice.servers);
  if (activeWords) transfer.armHandshake(formatCode(activeWords), null);
  // Every socket for this tab carries the same client id, so the server can
  // hand our own seat back after a drop without ever kicking the peer.
  let client: SignalClient | null = null;
  client = new SignalClient(defaultSignalUrl(), room, role, {
    onMessage: (message: ServerMessage) => {
      if (client === null || signal !== client) return;
      handleServerMessage(message, role);
    },
    onClose: () => {
      if (client === null || signal !== client) return;
      if (!busy) return;
      busy = false;
      setStatus(null);
      showAlert(
        'ارتباط با سرور سیگنالینگ برقرار نشد. اگر نسخهٔ دمو تازه بیدار می‌شود، چند ثانیه صبر کن و دوباره بزن.',
        () => void connect(role, room),
      );
    },
  });
  signal = client;

  setStatus(role === 'sender' ? 'منتظر وصل‌شدن طرف مقابل…' : 'در حال وصل‌شدن…', true);
}

function handleServerMessage(message: ServerMessage, role: TransferRole): void {
  debug('signal', message.t, role);
  switch (message.t) {
    case 'ready': {
      // Both seats are present. Build the peer connection now (a rejoin after
      // a drop leaves the old one dead), and let the sender offer.
      setStatus(
        role === 'sender' ? 'طرف مقابل وصل شد؛ پیشنهاد اتصال می‌رود.' : 'وصل شدی. منتظر فایل…',
        true,
      );
      restartPeer(role, 0, true);
      return;
    }
    case 's': {
      const payload = message.data as SignalPayload;
      if (!payload || typeof payload !== 'object') return;
      debug('relay-in', payload.kind);
      void transfer?.handleSignal(payload).catch(() => {
        showAlert(describeError('connection-failed'));
      });
      return;
    }
    case 'replaced': {
      // Our own socket was superseded by this tab's newer one; rejoin quietly.
      teardown();
      busy = false;
      reconnectAttempts = 0;
      setStatus('اتصال را از نو برقرار می‌کنم…', true);
      window.setTimeout(() => {
        if (lastAttempt) void connect(lastAttempt.role, lastAttempt.room);
      }, 200);
      return;
    }
    case 'full': {
      // A just-dropped peer can still hold the room for a moment; a resume
      // retry is allowed to wait it out.
      if (scheduleResume(1400)) return;
      busy = false;
      setStatus(null);
      showAlert('این کد همین حالا در حال استفاده است. یک بار دیگر فایل را انتخاب کن تا کد تازه بگیری.');
      return;
    }
    case 'peer-left': {
      // Our socket is fine; only the other side vanished (tab closed, network
      // gone). Reconnecting here would close our own socket and make the peer
      // do the same, so wait: the room tells us when they are back.
      busy = false;
      setStatus(null);
      showAlert('طرف مقابل قطع شد.');
      return;
    }
    case 'error': {
      busy = false;
      setStatus(null);
      showAlert(
        message.message === 'room-expired'
          ? 'این کد منقضی شده. یک بار دیگر فایل را انتخاب کن.'
          : 'سرور سیگنالینگ درخواست را قبول نکرد. یک بار دیگر تلاش کن.',
      );
      return;
    }
    default:
      return;
  }
}

/** What the sender queued: one file, a folder of files, or a text snippet. */
type Sending =
  | { kind: 'file'; file: File }
  | { kind: 'folder'; entries: FolderEntry[]; zipName: string; totalSize: number; count: number }
  | { kind: 'text'; text: string };

let sending: Sending | null = null;

function startSendingFile(file: File): void {
  // A live session keeps its room and history: the next file rides the same
  // connection. Only a fresh start (no session) builds a new code.
  const continuing = session.active && !busy;
  if (!continuing) reset();
  if (!session.active) sessionStart('sender');
  const words = activeWords ?? makeCode();
  activeWords = words;

  if (!continuing) {
    codeBox.replaceChildren(
      ...words.map((word) => {
        const span = document.createElement('span');
        span.textContent = word;
        return span;
      }),
    );
  }
  picked.replaceChildren();
  const nameNode = document.createElement('bdi');
  nameNode.dir = 'ltr';
  nameNode.textContent = shortenName(file.name);
  picked.append(nameNode, document.createTextNode(` — ${formatBytes(file.size)}`));
  codeCard.hidden = false;
  renderShareCode(words);
  hideResult();
  hideAlert();

  sending = { kind: 'file', file };
  if (continuing && transfer) {
    // Channel is already open; just queue the next file.
    void sendNext();
    return;
  }
  void connect('sender', formatCode(words));
}

/** Send a text snippet: a tiny synthetic file on the same pipeline. */
function startSendingText(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const continuing = session.active && !busy;
  if (!continuing) reset();
  if (!session.active) sessionStart('sender');
  const words = activeWords ?? makeCode();
  activeWords = words;

  if (!continuing) {
    codeBox.replaceChildren(
      ...words.map((word) => {
        const span = document.createElement('span');
        span.textContent = word;
        return span;
      }),
    );
  }
  picked.replaceChildren();
  picked.append(document.createTextNode(`متن — ${formatBytes(new Blob([trimmed]).size)}`));
  codeCard.hidden = false;
  renderShareCode(words);
  hideResult();
  hideAlert();

  sending = { kind: 'text', text: trimmed };
  if (continuing && transfer) {
    void sendNext();
    return;
  }
  void connect('sender', formatCode(words));
}

/** Send a whole folder as one streaming ZIP. */
function startSendingFolder(files: File[]): void {
  if (files.length === 0) return;
  const continuing = session.active && !busy;
  if (!continuing) reset();
  if (!session.active) sessionStart('sender');
  const words = activeWords ?? makeCode();
  activeWords = words;

  const root = commonRoot(files);
  const readSize = 1024 * 1024;
  const entries: FolderEntry[] = files.map((file) => {
    const path = root ? relativePath(file.webkitRelativePath, root) || file.name : file.name;
    return {
      path,
      size: file.size,
      modified: new Date(file.lastModified),
      read: async function* (): AsyncGenerator<Uint8Array> {
        let offset = 0;
        while (offset < file.size) {
          const buffer = await file.slice(offset, offset + readSize).arrayBuffer();
          const block = new Uint8Array(buffer);
          offset += block.byteLength;
          yield block;
        }
      },
    };
  });
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const zipName = `${root || 'folder'}.zip`;

  if (!continuing) {
    codeBox.replaceChildren(
      ...words.map((word) => {
        const span = document.createElement('span');
        span.textContent = word;
        return span;
      }),
    );
  }
  picked.replaceChildren();
  picked.append(
    document.createTextNode(`پوشهٔ «${root || 'folder'}» — ${formatInt(entries.length)} فایل — ${formatBytes(totalSize)}`),
  );
  codeCard.hidden = false;
  renderShareCode(words);
  hideResult();
  hideAlert();

  sending = { kind: 'folder', entries, zipName, totalSize, count: entries.length };
  if (continuing && transfer) {
    void sendNext();
    return;
  }
  void connect('sender', formatCode(words));
}

/** Longest shared folder prefix of all relative paths, if any. */
function commonRoot(files: File[]): string {
  if (files.length === 0) return '';
  const first = files[0];
  if (!first) return '';
  const parts = (first.webkitRelativePath || '').split('/');
  const root = parts.length > 1 ? (parts[0] ?? '') : '';
  for (const file of files) {
    const path = file.webkitRelativePath || '';
    if (!path.startsWith(`${root}/`)) return '';
  }
  return root;
}

/** Show the comparable session words once the SPAKE2 handshake completes. */
function showFingerprint(words: string[]): void {
  lastFingerprintWords = words;
  fingerprintWords.replaceChildren();
  if (words.length === 0) {
    fingerprintCard.hidden = true;
    return;
  }
  fingerprintWords.replaceChildren(
    ...words.map((word) => {
      const span = document.createElement('span');
      span.textContent = word;
      return span;
    }),
  );
  fingerprintCard.hidden = false;
}

function hideFingerprint(): void {
  lastFingerprintWords = [];
  fingerprintCard.hidden = true;
  fingerprintWords.replaceChildren();
}

/** Strip "root/" from a webkitRelativePath; keeps inner folders intact. */
function relativePath(path: string, root: string): string {
  if (!root || !path.startsWith(`${root}/`)) return path;
  return path.slice(root.length + 1);
}

/** Dispatch whatever the sender queued, once the channel can take it. */
async function sendNext(): Promise<void> {
  if (!transfer || !sending) return;
  if (sending.kind === 'file') {
    beginSending({ name: sending.file.name, size: sending.file.size });
    await transfer.sendFile(sending.file);
  } else if (sending.kind === 'text') {
    const size = new Blob([sending.text]).size;
    beginSending({ name: 'متن.txt', size });
    await transfer.sendText(sending.text);
  } else {
    beginSending({ name: sending.zipName, size: sending.totalSize });
    setStatus(`بسته‌بندی ${formatInt(sending.count)} فایل…`, true);
    await transfer.sendFolder(sending.entries, sending.zipName);
  }
}

function startReceiving(input: string): void {
  const words = parseCode(input);
  if (!words) {
    showAlert('کد باید چهار کلمه از فهرست باشد. مثال: آب باد ماه گل');
    codeInput.focus();
    return;
  }
  activeWords = words;
  reset();
  void connect('receiver', formatCode(words));
}

/** The link a phone can open straight into this session. */
function shareLink(words: string[]): string {
  return `${location.origin}/#${words.join('-')}`;
}

/** Draw the share link as a QR in the code card. */
function renderShareCode(words: string[]): void {
  try {
    renderQr(encodeQr(shareLink(words)));
  } catch {
    qrBox.hidden = true;
    qrBox.replaceChildren();
  }
}

function renderQr(matrix: QrMatrix): void {
  const size = matrix.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'کد QR این نشست؛ با دوربین گوشی بخوان');
  let path = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matrix[y]?.[x]) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  qrBox.replaceChildren(svg);
  qrBox.hidden = false;
}

/** A four-word code carried in the URL hash, if the link has one. */
function codeFromLocation(): string | null {
  const raw = location.hash.replace(/^#/, '').trim();
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep the raw text; parseCode will reject it if it is not a code */
  }
  const words = parseCode(decoded.replace(/[-+_]/g, ' '));
  return words ? formatCode(words) : null;
}

async function copyCode(): Promise<void> {
  if (!activeWords) return;
  const text = formatCode(activeWords);
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    ok = document.execCommand('copy');
    area.remove();
  }

  copyButton.textContent = ok ? 'کپی شد' : 'کپی نشد';
  window.setTimeout(() => {
    copyButton.textContent = 'کپی کد';
  }, 1600);
}

function applyTheme(next: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('pol-theme', next);
  } catch {
    /* storage can be disabled; the theme still applies */
  }
}

tabs.send.addEventListener('click', () => setMode('send'));
tabs.receive.addEventListener('click', () => setMode('receive'));

setupReveal();

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) startSendingFile(file);
  fileInput.value = '';
});

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files ?? []];
  if (files.length > 0) startSendingFolder(files);
  folderInput.value = '';
});

textInput.addEventListener('input', () => {
  sendTextButton.disabled = textInput.value.trim().length === 0;
});

sendTextButton.addEventListener('click', () => {
  const text = textInput.value;
  textInput.value = '';
  sendTextButton.disabled = true;
  startSendingText(text);
});

pasteTextButton.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      textInput.value = text;
      sendTextButton.disabled = false;
      textInput.focus();
    }
  } catch {
    setStatus('کلیپ‌بورد در دسترس نیست؛ متن را دستی در کادر بنویس.');
  }
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('is-over');
});

drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));

drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('is-over');
  // A dropped folder comes through items, not files.
  const items = [...event.dataTransfer?.items ?? []];
  const folderItem = items.find((item) => item.webkitGetAsEntry()?.isDirectory);
  if (folderItem) {
    const entry = folderItem.webkitGetAsEntry();
    if (entry && 'createReader' in entry) {
      const files: File[] = [];
      const reader = (
        entry as FileSystemDirectoryEntry & { _collect: unknown }
      ).createReader();
      const readBatch = (): void => {
        reader.readEntries((batch: FileSystemEntry[]) => {
          if (batch.length === 0) {
            if (files.length > 0) startSendingFolder(files);
            return;
          }
          for (const item of batch) collectEntry(item as FileSystemFileEntry, '', files, readBatch);
        });
      };
      readBatch();
      return;
    }
  }
  const file = event.dataTransfer?.files?.[0];
  if (file) startSendingFile(file);
});

/** Walk a dropped filesystem entry recursively, collecting real files. */
function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  files: File[],
  done: () => void,
): void {
  if (entry.isFile) {
    (entry as FileSystemFileEntry).file((file) => {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: prefix ? `${prefix}/${file.name}` : file.name,
        configurable: true,
      });
      files.push(file);
      done();
    });
    return;
  }
  if (entry.isDirectory) {
    const dir = entry as FileSystemDirectoryEntry;
    const reader = dir.createReader();
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const readBatch = (): void => {
      reader.readEntries((batch: FileSystemEntry[]) => {
        if (batch.length === 0) {
          done();
          return;
        }
        let waiting = batch.length;
        for (const item of batch) {
          collectEntry(item, nextPrefix, files, () => {
            waiting -= 1;
            if (waiting === 0) readBatch();
          });
        }
      });
    };
    readBatch();
  }
}

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

copyButton.addEventListener('click', () => void copyCode());
copyLinkButton.addEventListener('click', async () => {
  if (!activeWords) return;
  try {
    await navigator.clipboard.writeText(shareLink(activeWords));
    copyLinkButton.textContent = 'کپی شد';
  } catch {
    copyLinkButton.textContent = 'کپی نشد';
  }
  window.setTimeout(() => {
    copyLinkButton.textContent = 'کپی لینک';
  }, 1600);
});
cancelButton.addEventListener('click', () => reset());
sessionClose.addEventListener('click', () => reset());
copyTextButton.addEventListener('click', async () => {
  const text = resultText.textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyTextButton.textContent = 'کپی شد';
  } catch {
    copyTextButton.textContent = 'کپی نشد';
  }
  window.setTimeout(() => {
    copyTextButton.textContent = 'کپی متن';
  }, 1600);
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startReceiving(codeInput.value);
});

window.addEventListener('beforeunload', (event) => {
  if (!busy) return;
  event.preventDefault();
  event.returnValue = '';
});

// A link with a code in the hash (from the QR or a shared URL) joins straight
// away: scanning with a phone should land in the room, not on the landing page.
function joinFromLocation(): void {
  const code = codeFromLocation();
  if (!code || busy) return;
  setMode('receive');
  codeInput.value = code;
  startReceiving(code);
}

joinFromLocation();
window.addEventListener('hashchange', joinFromLocation);

// The installed app keeps working with the network down; the browser only
// offers installation on its own schedule, so the button appears when it does.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

let installPrompt: InstallPrompt | null = null;
const installButton = el<HTMLButtonElement>('install');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event as InstallPrompt;
  installButton.hidden = false;
});

installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  installButton.hidden = true;
});

setBar(0);

// Leftovers from earlier visits (finished downloads whose blob is gone) are
// swept once per load; a pending resume is spared.
void cleanupStaleFiles();

// A tiny test hook: the e2e suite uses it to drop the channel mid-transfer and
// prove that the receiver resumes instead of starting over. Gated so a normal
// visit never sees it.
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { polDebug: unknown }).polDebug = {
    interrupt: () => transfer?.interrupt(),
    hasOpfs: () => hasOpfs(),
    progress: () => progressSize.textContent,
    /** Bytes the session total currently shows, for exact e2e assertions. */
    sessionBytes: () => session.bytes + currentFileDone,
    /** Size/result of the last finished receive. */
    lastReceive: () => lastVerified,
    /** Sender tuning of this page, for the benchmark. */
    tuning: () => getTransferTuning(),
    setTuning: (patch: Record<string, number>) => setTransferTuning(patch),
    /** Receiver window of the last file: first byte in → verified. */
    timeline: () => ({
      startedAt: receiveStartedAt,
      endedAt: receiveEndedAt,
      lastProgressAt: receiveLastProgressAt,
      bytes: lastVerified?.size ?? 0,
      ok: lastVerified?.ok ?? false,
    }),
    /** Where the last transfer spent its time, in ms. */
    stats: () => transfer?.timings() ?? null,
    /** The comparable session words this side computed after the handshake. */
    fingerprint: () => lastFingerprintWords,
    /** Stop the automatic rejoin so a reload can be tested as a clean start. */
    stopRetries: () => {
      autoRetry = false;
    },
    /**
     * Drop the last received file: blob URL, result card and its OPFS entry.
     * The benchmark uses this between runs so one run does not leave 128 MB
     * behind for the next one to pay for.
     */
    clearReceived: async () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
      download.hidden = true;
      result.hidden = true;
      lastVerified = null;
      receiveStartedAt = 0;
      receiveEndedAt = 0;
      receiveLastProgressAt = 0;
      await cleanupStaleFiles();
    },
  };
}


