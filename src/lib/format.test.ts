import { describe, expect, it } from 'vitest';
import { formatBytes, formatPercent, formatSpeed, shortenName } from './format';

describe('formatBytes', () => {
  it('handles zero and negatives', () => {
    expect(formatBytes(0)).toBe('۰ بایت');
    expect(formatBytes(-10)).toBe('۰ بایت');
  });

  it('uses Persian units', () => {
    expect(formatBytes(1024)).toBe('۱ کیلوبایت');
    expect(formatBytes(5 * 1024 * 1024)).toContain('مگابایت');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toContain('گیگابایت');
  });

  it('shows one decimal for small values', () => {
    expect(formatBytes(1536)).toMatch(/^۱[٫.]۵ کیلوبایت$/);
  });

  it('drops decimals for large values', () => {
    expect(formatBytes(150 * 1024)).toMatch(/^۱۵۰ کیلوبایت$/);
  });
});

describe('formatPercent', () => {
  it('rounds and clamps', () => {
    expect(formatPercent(0)).toBe('۰٪');
    expect(formatPercent(0.456)).toBe('۴۶٪');
    expect(formatPercent(1)).toBe('۱۰۰٪');
    expect(formatPercent(-0.5)).toBe('۰٪');
    expect(formatPercent(2)).toBe('۱۰۰٪');
    expect(formatPercent(Number.NaN)).toBe('۰٪');
  });
});

describe('formatSpeed', () => {
  it('returns a dash when there is no measurement', () => {
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(-1)).toBe('—');
  });

  it('appends the Persian phrase', () => {
    expect(formatSpeed(2 * 1024 * 1024)).toContain('بر ثانیه');
  });
});

describe('shortenName', () => {
  it('keeps short names intact', () => {
    expect(shortenName('report.pdf')).toBe('report.pdf');
  });

  it('compresses the middle and keeps the extension', () => {
    const long = `${'a'.repeat(80)}.pdf`;
    const short = shortenName(long, 24);
    expect(short).toContain('…');
    expect(short.endsWith('.pdf')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(24);
  });
});
