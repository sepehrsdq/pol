import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, isAboveHighWater, resolveTuning } from './tuning';

describe('resolveTuning', () => {
  it('keeps the defaults when nothing is given', () => {
    expect(resolveTuning(DEFAULT_TUNING)).toEqual(DEFAULT_TUNING);
  });

  it('accepts a sane configuration unchanged', () => {
    const tuned = resolveTuning(DEFAULT_TUNING, {
      chunkSize: 256 * 1024,
      highWater: 8 * 1024 * 1024,
      lowWater: 2 * 1024 * 1024,
    });
    expect(tuned).toEqual({
      chunkSize: 256 * 1024,
      highWater: 8 * 1024 * 1024,
      lowWater: 2 * 1024 * 1024,
    });
  });

  it('keeps the queue below the limit where Chrome closes the channel', () => {
    expect(resolveTuning(DEFAULT_TUNING, { highWater: 32 * 1024 * 1024 }).highWater).toBe(
      8 * 1024 * 1024,
    );
  });

  it('clamps a chunk that is too small or too large', () => {
    expect(resolveTuning(DEFAULT_TUNING, { chunkSize: 1 }).chunkSize).toBe(4 * 1024);
    expect(resolveTuning(DEFAULT_TUNING, { chunkSize: 8 * 1024 * 1024 }).chunkSize).toBe(256 * 1024);
  });

  it('grows the high watermark when the chunk needs more room', () => {
    const tuned = resolveTuning(DEFAULT_TUNING, { chunkSize: 256 * 1024, highWater: 512 * 1024 });
    expect(tuned.highWater).toBe(1024 * 1024);
    expect(tuned.highWater).toBeGreaterThanOrEqual(tuned.chunkSize * 4);
  });

  it('keeps the low watermark below the high one', () => {
    const tuned = resolveTuning(DEFAULT_TUNING, {
      chunkSize: 64 * 1024,
      highWater: 512 * 1024,
      lowWater: 500 * 1024,
    });
    expect(tuned.lowWater).toBe(448 * 1024);
    expect(tuned.lowWater).toBeLessThanOrEqual(tuned.highWater - tuned.chunkSize);
    expect(tuned.lowWater).toBeGreaterThanOrEqual(tuned.chunkSize);
  });

  it('falls back for values that are not numbers', () => {
    const tuned = resolveTuning(DEFAULT_TUNING, {
      chunkSize: Number.NaN,
      highWater: Number.POSITIVE_INFINITY,
      lowWater: undefined,
    });
    expect(tuned).toEqual(DEFAULT_TUNING);
  });

  it('compares against the high watermark', () => {
    expect(isAboveHighWater(DEFAULT_TUNING, DEFAULT_TUNING.highWater)).toBe(false);
    expect(isAboveHighWater(DEFAULT_TUNING, DEFAULT_TUNING.highWater + 1)).toBe(true);
  });
});
