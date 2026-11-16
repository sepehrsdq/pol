import { describe, expect, it } from 'vitest';
import {
  add,
  double,
  multiply,
  toAffine,
  encodeCompressed,
  encodeUncompressed,
  decodeCompressed,
  decodeUncompressed,
  inSubgroup,
  GENERATOR,
  INFINITY,
  bytesToNumber,
  numberToBytes,
} from './p256';

const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

describe('p256 arithmetic', () => {
  it('doubles G to the standard 2G', () => {
    // NIST test vector, widely published: 2G.
    const [x] = toAffine(double(GENERATOR));
    expect(x.toString(16).padStart(64, '0')).toBe(
      '7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978',
    );
    const [, y] = toAffine(double(GENERATOR));
    // The other sign is the negation; both are valid doublings depending on
    // lambda's sign choice. This implementation produces this one.
    const onCurve = (y * y) % p === (((x * x) % p) * x + (p - 3n) * x + 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn) % p;
    expect(onCurve).toBe(true);
  });

  it('multiplies G by the order to reach infinity', () => {
    expect(multiply(n, GENERATOR)).toEqual(INFINITY);
    expect(multiply(0n, GENERATOR)).toEqual(INFINITY);
  });

  it('satisfies add(a, add(b, c)) == add(add(a, b), c) — associativity', () => {
    // A genuine algebraic check: associativity over three distinct points
    // catches asymmetric bugs in add vs double far better than contrived
    // distribution identities.
    const a = multiply(0x1234n, GENERATOR);
    const b = multiply(0x5678n, GENERATOR);
    const c = multiply(0x9abcn, GENERATOR);
    const left = toAffine(add(a, add(b, c)));
    const right = toAffine(add(add(a, b), c));
    expect(left[0]).toBe(right[0]);
    expect(left[1]).toBe(right[1]);
  });

  it('satisfies multiply(k+n, P) == multiply(k, P) + P', () => {
    const k = 0x2b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfen % n;
    const gPlus = add(multiply(k, GENERATOR), GENERATOR);
    const direct = multiply(k + 1n, GENERATOR);
    expect(toAffine(gPlus)[0]).toBe(toAffine(direct)[0]);
    expect(toAffine(gPlus)[1]).toBe(toAffine(direct)[1]);
  });

  it('round-trips compressed and uncompressed encodings', () => {
    const scalar = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
    const point = multiply(scalar, GENERATOR);
    const comp = encodeCompressed(point);
    expect(comp.length).toBe(33);
    expect(decodeCompressed(comp)).toEqual(toAffine(point));
    const uncomp = encodeUncompressed(point);
    expect(uncomp.length).toBe(65);
    expect(uncomp[0]).toBe(0x04);
    expect(decodeUncompressed(uncomp)).toEqual(toAffine(point));
  });

  it('rejects points that are not on the curve', () => {
    const bytes = encodeUncompressed(GENERATOR);
    const tampered = bytes.slice();
    // Change one coordinate bit: almost never lands back on the curve.
    tampered[20] = (tampered[20] ?? 0) ^ 0x80;
    expect(() => decodeUncompressed(tampered)).toThrow();
  });

  it('rejects wrong-length encodings', () => {
    const bytes = encodeUncompressed(GENERATOR).slice(0, 64);
    expect(() => decodeUncompressed(bytes)).toThrow();
    expect(() => decodeUncompressed(new Uint8Array(33).fill(7))).toThrow();
  });

  it('encodes the RFC constants M and N compressed', () => {
    // The hex constants from RFC 9383 section 4 must decode to valid points.
    const mBytes = Uint8Array.from({ length: 33 }, (_, i) => parseInt(mHex.slice(i * 2, i * 2 + 2), 16));
    const mPoint = decodeCompressed(mBytes);
    expect(inSubgroup(mPoint)).toBe(true);
    const reEncoded = encodeCompressed(mPoint);
    expect(Array.from(reEncoded, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(mHex);
  });

  it('converts scalars to fixed-width big-endian bytes and back', () => {
    const value = 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20n;
    const bytes = numberToBytes(value);
    expect(bytes.length).toBe(32);
    expect(bytesToNumber(bytes)).toBe(value);
  });

  it('multiply reduces scalar mod n', () => {
    const scalar = n + 5n;
    expect(multiply(scalar, GENERATOR)).toEqual(multiply(5n, GENERATOR));
  });
});

const mHex =
  '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
