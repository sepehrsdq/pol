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
import { trace } from './lib/trace';
import { formatCode, makeCode, parseCode } from './lib/words';
import { loadIceServers } from './net/ice';
import { defaultSignalUrl, SignalClient, type ServerMessage } from './net/signal';
import { Transfer, type FileMeta, type SignalPayload, type TransferDiagnostics, type TransferRole } from './net/transfer';

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
const codeCard = el<HTMLDivElement>('code-card');
const codeBox = el<HTMLDivElement>('code');
const picked = el<HTMLParagraphElement>('picked');
const copyButton = el<HTMLButtonElement>('copy-code');
const cancelButton = el<HTMLButtonElement>('cancel');
const joinForm = el<HTMLFormElement>('join-form');
const codeInput = el<HTMLInputElement>('code-input');
const alertBox = el<HTMLParagraphElement>('alert');
const statusLine = el<HTMLParagraphElement>('status');
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
const themeToggle = el<HTMLButtonElement>('theme-toggle');

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
let selectedFile: File | null = null;
let activeWords: string[] | null = null;
let receivedName = 'file';
let downloadUrl: string | null = null;
let busy = false;
let lastAttempt: { role: TransferRole; room: string; file: File | null } | null = null;
let sampleTime = 0;
let sampleBytes = 0;
let speed = 0;
let lastPaint = 0;
/** Done-bytes of the file in flight, receiver-side, for the session total. */
let sessionLastDone = 0;
/** Bytes the sender promised so far, receiver-side (sums of meta.size). */
let sessionBytesTotal = 0;
/** Size and name of the file currently in flight, for the session list. */
let lastFileSize = 0;
let lastSentName = 'file';

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

function hideResult(): void {
  result.hidden = true;
  result.classList.remove('is-ok', 'is-warn', 'is-animated');
  resultMark.classList.remove('is-drawn', 'is-fail');
  download.hidden = true;
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
  sessionFiles.hidden = true;
  sessionList.replaceChildren();
}

function sessionEnd(): void {
  session.active = false;
  sessionBytesTotal = 0;
  sessionMeta.hidden = true;
  sessionBarWrap.hidden = true;
}

function renderSessionMeta(): void {
  const count = session.files.length;
  sessionMeta.hidden = count === 0 && sessionBytesTotal === 0;
  sessionCount.textContent = count > 0 ? `فایل ${formatInt(count)}` : '';
  sessionTotal.textContent =
    session.bytes > 0 ? `مجموع ${formatBytes(session.bytes)}` : '';
}

function renderSessionBar(): void {
  sessionBarWrap.hidden = sessionBytesTotal <= 0;
  if (sessionBytesTotal <= 0) return;
  const ratio = Math.min(1, session.bytes / sessionBytesTotal);
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

function reset(): void {
  teardown();
  sessionEnd();
  setStatus(null);
  progressCard.hidden = true;
  hideResult();
  hideAlert();
  codeCard.hidden = true;
}

function trackProgress(done: number, total: number): void {
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
  if (!complete && now - lastPaint < 90) return;
  lastPaint = now;

  const ratio = total > 0 ? done / total : 0;
  setBar(ratio);
  progressSize.textContent = total > 0 ? `${formatBytes(done)} از ${formatBytes(total)}` : formatBytes(done);
  progressSpeed.textContent = speed > 0 ? formatSpeed(speed) : '';
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
      return 'طرف مقابل قطع شد. صفحه را نبند تا انتقال تمام شود.';
    case 'file-too-large':
      return `این انتقال از مسیر رله می‌گذرد و فعلاً تا ۲۰۰ مگابایت پذیرفته می‌شود. اگر هر دو دستگاه روی یک وای‌فای باشند، فایل‌های بزرگ‌تر هم بدون سقف می‌روند.`;
    case 'send-failed':
      return 'فرستادن متوقف شد. اگر طرف مقابل صفحه را بسته باشد، همان اتفاق افتاده است.';
    default:
      return 'اتصال قطع شد. یک بار دیگر تلاش کن.';
  }
}

function buildTransfer(role: TransferRole, iceServers: RTCIceServer[]): Transfer {
  return new Transfer(role, iceServers, (payload: SignalPayload) => signal?.relay(payload), {
    onState: (state) => {
      if (state === 'open' && role === 'sender' && selectedFile) {
        if (!session.active) sessionStart(role);
        void sendSelected(selectedFile);
      }
      if (state === 'closed' && busy) {
        busy = false;
        bridge.classList.remove('is-active');
      }
    },
    onMeta: (meta: FileMeta) => {
      progressCard.hidden = false;
      resetProgress();
      receivedName = meta.name;
      lastFileSize = meta.size;
      if (!session.active) sessionStart(role);
      sessionBytesTotal += meta.size;
      progressName.textContent = shortenName(meta.name);
      progressSize.textContent = `۰ بایت از ${formatBytes(meta.size)}`;
      setStatus('فایل پیدا شد؛ انتقال شروع می‌شود.', true);
    },
    onProgress: (done, total) => {
      bridge.classList.add('is-active');
      trackProgress(done, total);
      // Session bytes: sender promises upfront, receiver counts as they land.
      if (session.role === 'receiver') {
        session.bytes = session.bytes - (sessionLastDone ?? 0) + done;
        sessionLastDone = done;
        renderSessionMeta();
        renderSessionBar();
      }
      renderSessionEta(Math.max(0, total - done));
    },
    onVerified: ({ checked, ok, received, blob }) => {
      busy = false;
      bridge.classList.remove('is-active');
      setBar(1);
      setStatus(null);
      renderSessionEta(0);
      addSessionFile({ name: receivedName, size: sessionBytesTotal > 0 ? lastFileSize : 0, ok: checked && ok });
      renderSessionMeta();
      renderSessionBar();
      playResultAnimation(checked && ok);
      if (!blob) return;

      downloadUrl = URL.createObjectURL(blob);
      download.href = downloadUrl;
      download.download = receivedName;
      download.hidden = false;

      result.hidden = false;
      if (!checked) {
        result.classList.add('is-warn');
        resultTitle.textContent = 'فایل رسید، ولی بررسی سلامت انجام نشد.';
        resultHash.textContent = '';
      } else if (ok) {
        result.classList.add('is-ok');
        resultTitle.textContent = 'فایل رسید و سلامت آن تأیید شد.';
        resultHash.textContent = `SHA-256: ${received ?? ''}`;
      } else {
        result.classList.add('is-warn');
        resultTitle.textContent = 'فایل رسید، ولی هش نمی‌خواند. ممکن است ناقص رسیده باشد.';
        resultHash.textContent = `SHA-256: ${received ?? ''}`;
      }
      resultSession.hidden = true;
      // The room stays open for the next file; say so, and offer a clean end.
      sessionClose.hidden = false;
      sessionClose.textContent = 'پایان نشست';
    },
    onAck: (ok) => {
      busy = false;
      bridge.classList.remove('is-active');
      progressCard.hidden = false;
      setBar(1);
      progressSpeed.textContent = '';
      setStatus(null);
      renderSessionEta(0);
      addSessionFile({ name: lastSentName, size: lastFileSize, ok });
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
      busy = false;
      bridge.classList.remove('is-active');
      setStatus(null);

      const attempt = lastAttempt;
      const retry =
        code === 'connection-failed' && attempt
          ? () => {
              // Let the old socket close on the server before rejoining.
              window.setTimeout(() => void connect(attempt.role, attempt.room, attempt.file), 600);
            }
          : undefined;

      showAlert(describeError(code, detail), retry, detail);
    },
  });
}

async function sendSelected(file: File): Promise<void> {
  if (!transfer) return;

  busy = true;
  lastSentName = file.name;
  lastFileSize = file.size;
  sessionBytesTotal += file.size;
  hideAlert();
  hideResult();
  progressCard.hidden = false;
  progressName.textContent = shortenName(file.name);
  progressSpeed.textContent = '';
  setStatus('در حال فرستادن…', true);
  resetProgress();
  renderSessionMeta();
  renderSessionBar();
  bridge.classList.add('is-active');

  await transfer.sendFile(file);
}

async function connect(role: TransferRole, room: string, file: File | null): Promise<void> {
  const attempt = ++connectAttempt;
  teardown();
  selectedFile = file;
  busy = true;
  lastAttempt = { role, room, file };
  setStatus('در حال آماده‌کردن مسیر اتصال…', true);

  const ice = await loadIceServers(defaultSignalUrl());
  if (attempt !== connectAttempt || !busy) return;

  transfer = buildTransfer(role, ice.servers);
  signal = new SignalClient(defaultSignalUrl(), room, role, {
    onMessage: (message: ServerMessage) => handleServerMessage(message, role),
    onClose: () => {
      if (!busy) return;
      busy = false;
      setStatus(null);
      showAlert(
        'ارتباط با سرور سیگنالینگ برقرار نشد. اگر نسخهٔ دمو تازه بیدار می‌شود، چند ثانیه صبر کن و دوباره بزن.',
        () => void connect(role, room, file),
      );
    },
  });

  setStatus(role === 'sender' ? 'منتظر وصل‌شدن طرف مقابل…' : 'در حال وصل‌شدن…', true);
}

function handleServerMessage(message: ServerMessage, role: TransferRole): void {
  debug('signal', message.t, role);
  switch (message.t) {
    case 'ready': {
      if (role === 'sender') {
        setStatus('طرف مقابل وصل شد؛ پیشنهاد اتصال می‌رود.', true);
        void transfer?.startOffer();
      } else {
        setStatus('وصل شدی. منتظر فایل…', true);
      }
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
    case 'full': {
      busy = false;
      setStatus(null);
      showAlert('این کد همین حالا در حال استفاده است. یک بار دیگر فایل را انتخاب کن تا کد تازه بگیری.');
      return;
    }
    case 'peer-left': {
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

function startSending(file: File): void {
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
  hideResult();
  hideAlert();

  if (continuing && transfer) {
    // Channel is already open; just queue the next file.
    void sendSelected(file);
    return;
  }
  void connect('sender', formatCode(words), file);
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
  void connect('receiver', formatCode(words), null);
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
  if (file) startSending(file);
  fileInput.value = '';
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('is-over');
});

drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));

drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('is-over');
  const file = event.dataTransfer?.files?.[0];
  if (file) startSending(file);
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

copyButton.addEventListener('click', () => void copyCode());
cancelButton.addEventListener('click', () => reset());
sessionClose.addEventListener('click', () => reset());

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startReceiving(codeInput.value);
});

window.addEventListener('beforeunload', (event) => {
  if (!busy) return;
  event.preventDefault();
  event.returnValue = '';
});

setBar(0);
