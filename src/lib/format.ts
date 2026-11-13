const UNITS = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'] as const;

const faNumber = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
const faInteger = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 });

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '۰ بایت';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const text = value >= 100 ? faInteger.format(value) : faNumber.format(value);
  return `${text} ${UNITS[unit]}`;
}

export function formatPercent(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  return `${faInteger.format(Math.round(clamped * 100))}٪`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)} بر ثانیه`;
}

/** Persian integer, for counts like file totals. */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '۰';
  return faInteger.format(Math.round(value));
}

/** Human remaining time: «۴۲ ثانیه», «۲ دقیقه و ۵ ثانیه». Empty when unknown. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  if (total < 60) return `${faInteger.format(total)} ثانیه`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) {
    return rest > 0
      ? `${faInteger.format(minutes)} دقیقه و ${faInteger.format(rest)} ثانیه`
      : `${faInteger.format(minutes)} دقیقه`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0
    ? `${faInteger.format(hours)} ساعت و ${faInteger.format(restMinutes)} دقیقه`
    : `${faInteger.format(hours)} ساعت`;
}

/** Keep the start and the extension, compress the middle. */
export function shortenName(name: string, max = 42): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const keep = Math.max(6, max - extension.length - 1);
  return `${name.slice(0, keep)}…${extension}`;
}
