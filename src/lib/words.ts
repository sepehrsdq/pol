/** Pool of 64 short Persian words. Four of them identify a room. */
export const WORDS = [
  'آب', 'آتش', 'آینه', 'ابر', 'اسب', 'انار', 'انگور', 'انجیر',
  'باد', 'باغ', 'برف', 'برنج', 'پرده', 'پرچم', 'پل', 'پنجره',
  'پارو', 'پشم', 'توپ', 'تیر', 'جارو', 'جو', 'چای', 'چراغ',
  'چنگال', 'حوض', 'خاک', 'خرما', 'خرگوش', 'خشت', 'دود', 'در',
  'دریا', 'روز', 'روباه', 'زره', 'سنگ', 'سطل', 'سپر', 'سیب',
  'شب', 'شمع', 'شیر', 'صندلی', 'طناب', 'عسل', 'قالی', 'قاشق',
  'قفل', 'قند', 'کارد', 'کاسه', 'کاغذ', 'کبوتر', 'کوه', 'کوزه',
  'کلید', 'گل', 'گندم', 'گرگ', 'لیوان', 'ماه', 'مرغ', 'نمک',
] as const;

export const CODE_LENGTH = 4;

const DIACRITICS = /[\u064B-\u0652\u0670]/g;
const JOINERS = /[\u200c\u200d]/g;
const MARKS = /[\u200e\u200f\u202a-\u202e]/g;

/** Collapse Arabic/Persian variants and invisible characters. */
export function normalizeCodeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(DIACRITICS, '')
    .replace(JOINERS, ' ')
    .replace(MARKS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function randomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % max;
  }
}

/** Four distinct words, in random order. */
export function makeCode(): string[] {
  const pool = WORDS.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    const a = pool[i];
    const b = pool[j];
    pool[i] = b as (typeof WORDS)[number];
    pool[j] = a as (typeof WORDS)[number];
  }
  return pool.slice(0, CODE_LENGTH);
}

/**
 * Accepts whatever the user typed and returns the canonical four words,
 * or null when it is not a valid code.
 */
export function parseCode(input: string): string[] | null {
  const parts = normalizeCodeText(input).split(' ').filter(Boolean);
  if (parts.length !== CODE_LENGTH) return null;
  const known = new Set<string>(WORDS);
  if (!parts.every((part) => known.has(part))) return null;
  return parts;
}

export function formatCode(words: readonly string[]): string {
  return words.join(' ');
}
