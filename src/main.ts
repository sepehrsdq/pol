import './styles.css';
import { formatBytes, formatPercent, formatSpeed, shortenName } from './lib/format';
import { hashFile } from './lib/sha256';
import { trace } from './lib/trace';
import { formatCode, makeCode, parseCode } from './lib/words';
import { defaultSignalUrl, SignalClient, type ServerMessage } from './net/signal';
import { Transfer, type FileMeta, type SignalPayload, type TransferRole } from './net/transfer';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
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
const result = el<HTMLDivElement>('result');
const resultTitle = el<HTMLParagraphElement>('result-title');
const resultHash = el<HTMLParagraphElement>('result-hash');
const download = el<HTMLAnchorElement>('download');
const themeToggle = el<HTMLButtonElement>('theme-toggle');

let mode: 'send' | 'receive' = 'send';
let signal: SignalClient | null = null;
let transfer: Transfer | null = null;
let selectedFile: File | null = null;
let activeWords: string[] | null = null;
let receivedName = 'file';
let downloadUrl: string | null = null;
let busy = false;
let sampleTime = 0;
let sampleBytes = 0;
let speed = 0;

function readIceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RTCIceServer[]) : [];
  } catch {
    return [];
  }
}

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

function showAlert(message: string, retry?: () => void): void {
  alertBox.textContent = message;
  alertBox.hidden = false;
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
  result.classList.remove('is-ok', 'is-warn');
  download.hidden = true;
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
  setBar(0);
  progressSize.textContent = '';
  progressSpeed.textContent = '';
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

  const ratio = total > 0 ? done / total : 0;
  setBar(ratio);
  progressSize.textContent = total > 0 ? `${formatBytes(done)} از ${formatBytes(total)}` : formatBytes(done);
  progressSpeed.textContent = speed > 0 ? formatSpeed(speed) : '';
}

function describeError(code: string): string {
  switch (code) {
    case 'connection-failed':
      return 'اتصال مستقیم برقرار نشد. احتمالاً دو دستگاه در دو شبکهٔ جدا هستند و مسیر مستقیم بسته است. با یک شبکهٔ مشترک امتحان کن.';
    case 'channel-closed':
      return 'طرف مقابل قطع شد. صفحه را نبند تا انتقال تمام شود.';
    case 'send-failed':
      return 'فرستادن متوقف شد. اگر طرف مقابل صفحه را بسته باشد، همان اتفاق افتاده است.';
    default:
      return 'اتصال قطع شد. یک بار دیگر تلاش کن.';
  }
}

function buildTransfer(role: TransferRole): Transfer {
  return new Transfer(role, readIceServers(), (payload: SignalPayload) => signal?.relay(payload), {
    onState: (state) => {
      if (state === 'open' && role === 'sender' && selectedFile) {
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
      progressName.textContent = shortenName(meta.name);
      progressSize.textContent = `۰ بایت از ${formatBytes(meta.size)}`;
      setStatus('فایل پیدا شد؛ انتقال شروع می‌شود.', true);
    },
    onProgress: (done, total) => {
      bridge.classList.add('is-active');
      trackProgress(done, total);
    },
    onVerified: ({ checked, ok, received, blob }) => {
      busy = false;
      bridge.classList.remove('is-active');
      setBar(1);
      setStatus(null);
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
    },
    onAck: (ok) => {
      busy = false;
      bridge.classList.remove('is-active');
      progressCard.hidden = false;
      setBar(1);
      progressSpeed.textContent = '';
      setStatus(null);

      result.hidden = false;
      result.classList.add(ok ? 'is-ok' : 'is-warn');
      resultTitle.textContent = ok
        ? 'طرف مقابل فایل را گرفت و هش تأیید شد.'
        : 'فایل رفت، ولی طرف مقابل گفت هش نمی‌خواند. یک بار دیگر بفرست.';
      resultHash.textContent = '';
    },
    onError: (code) => {
      busy = false;
      bridge.classList.remove('is-active');
      setStatus(null);
      showAlert(describeError(code));
    },
  });
}

async function sendSelected(file: File): Promise<void> {
  if (!transfer) return;

  busy = true;
  hideAlert();
  hideResult();
  progressCard.hidden = false;
  progressName.textContent = shortenName(file.name);
  progressSpeed.textContent = '';
  setStatus('در حال بررسی سلامت فایل…', true);
  resetProgress();

  let hash: string | null = null;
  try {
    hash = await hashFile(file);
  } catch {
    hash = null;
  }

  setStatus('در حال فرستادن…', true);
  bridge.classList.add('is-active');
  resetProgress();
  await transfer.sendFile(file, hash);
}

function connect(role: TransferRole, room: string, file: File | null): void {
  teardown();
  selectedFile = file;
  busy = true;

  transfer = buildTransfer(role);
  signal = new SignalClient(defaultSignalUrl(), room, role, {
    onMessage: (message: ServerMessage) => handleServerMessage(message, role),
    onClose: () => {
      if (!busy) return;
      busy = false;
      setStatus(null);
      showAlert(
        'ارتباط با سرور سیگنالینگ برقرار نشد. اگر نسخهٔ دمو تازه بیدار می‌شود، چند ثانیه صبر کن و دوباره بزن.',
        () => connect(role, room, file),
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
  reset();
  const words = makeCode();
  activeWords = words;

  codeBox.replaceChildren(
    ...words.map((word) => {
      const span = document.createElement('span');
      span.textContent = word;
      return span;
    }),
  );
  picked.replaceChildren();
  const nameNode = document.createElement('bdi');
  nameNode.dir = 'ltr';
  nameNode.textContent = shortenName(file.name);
  picked.append(nameNode, document.createTextNode(` — ${formatBytes(file.size)}`));
  codeCard.hidden = false;
  hideResult();
  hideAlert();

  connect('sender', formatCode(words), file);
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
  connect('receiver', formatCode(words), null);
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
