import { describe, expect, it } from 'vitest';
import { crc32, Crc32 } from './crc32';

describe('crc32', () => {
  // Canonical check value: CRC-32("123456789") = 0xCBF43926.
  it('matches the canonical check vector', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe('cbf43926');
  });

  it('is empty-friendly', () => {
    expect(crc32(new Uint8Array(0))).toBe('00000000');
  });

  it('is incremental: chunked equals one-shot', () => {
    const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    const oneShot = crc32(bytes);
    const streamed = new Crc32();
    for (let i = 0; i < bytes.length; i += 7) {
      streamed.update(bytes.subarray(i, i + 7));
    }
    expect(streamed.digestHex()).toBe(oneShot);
  });

  it('keeps values unsigned', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    expect(crc32(bytes)).toMatch(/^[0-9a-f]{8}$/);
    expect(parseInt(crc32(bytes), 16)).toBeGreaterThanOrEqual(0);
  });
});
