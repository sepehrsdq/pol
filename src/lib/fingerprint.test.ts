import { describe, expect, it } from 'vitest';
import { fingerprintWords, fingerprintsFromSdp, normalizeFingerprint, FINGERPRINT_LENGTH } from './fingerprint';

const FP_A = 'sha-256 4A:AD:C0:74:C2:34:56:D8:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78';
const FP_B = 'sha-256 C2:9B:1E:40:5F:6A:7B:8C:9D:0E:1F:2A:3B:4C:5D:6E:7F:08:19:2A:3B:4C:5D:6E:7F:80:91:A2:B3:C4:D5:E6';
const CODE = 'آب باد ماه گل';
const K = new Uint8Array(32).fill(0x42);

describe('fingerprint derivation', () => {
  it('yields six words from the room-code pool', () => {
    const words = fingerprintWords(K, FP_A, FP_B, CODE);
    expect(words.length).toBe(FINGERPRINT_LENGTH);
  });

  it('is deterministic: same input, same words', () => {
    const a = fingerprintWords(K, FP_A, FP_B, CODE);
    const b = fingerprintWords(K, FP_A, FP_B, CODE);
    expect(a.join(' ')).toBe(b.join(' '));
  });

  it('swapping fingerprints changes the words (fixed order matters)', () => {
    const a = fingerprintWords(K, FP_A, FP_B, CODE);
    const b = fingerprintWords(K, FP_B, FP_A, CODE);
    expect(a.join(' ')).not.toBe(b.join(' '));
  });

  it('any changed input changes the words', () => {
    const base = fingerprintWords(K, FP_A, FP_B, CODE);
    const otherKey = fingerprintWords(new Uint8Array(32).fill(0x43), FP_A, FP_B, CODE);
    const otherCode = fingerprintWords(K, FP_A, FP_B, 'برف کوه درخت باران');
    expect(base.join(' ')).not.toBe(otherKey.join(' '));
    expect(base.join(' ')).not.toBe(otherCode.join(' '));
  });

  it('is case-insensitive on fingerprints (browser casing differs)', () => {
    const a = fingerprintWords(K, FP_A, FP_B, CODE);
    const b = fingerprintWords(K, FP_A.toLowerCase(), FP_B.toLowerCase(), CODE);
    expect(a.join(' ')).toBe(b.join(' '));
  });

  it('extracts fingerprint lines from real SDP', () => {
    const sdp = [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      'a=fingerprint:sha-256 4A:AD:C0:74:C2:34:56:D8:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78',
      'a=group:BUNDLE 0',
      'a=fingerprint:sha-256 4A:AD:C0:74:C2:34:56:D8:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78',
    ].join('\r\n');
    const fps = fingerprintsFromSdp(sdp);
    expect(fps.length).toBe(1);
    expect(fps[0]?.startsWith('sha-256 4a:ad:c0')).toBe(true);
  });

  it('normalizes whitespace and case', () => {
    expect(normalizeFingerprint('  SHA-256   AA:BB  ')).toBe('sha-256 aa:bb');
  });
});
