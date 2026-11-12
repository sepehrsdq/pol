import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, formatCode, makeCode, normalizeCodeText, parseCode, WORDS } from './words';

const known = new Set<string>(WORDS);

describe('makeCode', () => {
  it('returns four distinct known words', () => {
    for (let run = 0; run < 40; run += 1) {
      const code = makeCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(new Set(code).size).toBe(CODE_LENGTH);
      expect(code.every((word) => known.has(word))).toBe(true);
    }
  });

  it('formats with single spaces', () => {
    expect(formatCode(['آب', 'باد', 'ماه', 'گل'])).toBe('آب باد ماه گل');
  });
});

describe('normalizeCodeText', () => {
  it('maps Arabic letters to Persian ones', () => {
    expect(normalizeCodeText('سيب كاغذ')).toBe('سیب کاغذ');
  });

  it('drops diacritics and direction marks', () => {
    expect(normalizeCodeText('\u202bآبِ باد\u202c')).toBe('آب باد');
  });

  it('turns zero-width joiners into spaces', () => {
    expect(normalizeCodeText('آب\u200cباد')).toBe('آب باد');
  });

  it('collapses repeated whitespace', () => {
    expect(normalizeCodeText('  آب   باد  ')).toBe('آب باد');
  });
});

describe('parseCode', () => {
  it('accepts a clean code', () => {
    expect(parseCode('آب باد ماه گل')).toEqual(['آب', 'باد', 'ماه', 'گل']);
  });

  it('accepts Arabic spelling and extra spaces', () => {
    expect(parseCode('  سيب   باد  ماه گل ')).toEqual(['سیب', 'باد', 'ماه', 'گل']);
  });

  it('rejects the wrong number of words', () => {
    expect(parseCode('آب باد ماه')).toBeNull();
    expect(parseCode('آب باد ماه گل نمک')).toBeNull();
  });

  it('rejects unknown words', () => {
    expect(parseCode('آب باد ماه سیب‌زمینی')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseCode('')).toBeNull();
    expect(parseCode('   ')).toBeNull();
  });
});
