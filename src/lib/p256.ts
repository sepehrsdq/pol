/**
 * Minimal NIST P-256 point arithmetic in BigInt Jacobian coordinates.
 * No dependencies, no WebCrypto: SPAKE2 needs scalar*point + point*point
 * additions (X = x*P + w0*M), which the native ECDH interface cannot express.
 *
 * Scope is deliberately narrow — everything SPAKE2 needs and nothing more:
 * scalar multiplication, point addition, SEC1 encode/decode with subgroup
 * checks, and multiplication by the curve's cofactor (h = 1 on P-256, so the
 * RFC's "multiply by h" step is a no-op, but subgroup membership is still
 * checked on every decoded point).
 *
 * Ground truth: the RFC 9383 Appendix C test vectors (spake2.test.ts pin the
 * full protocol) and the standard doubling of G (p256.test.ts).
 */

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
/** a = -3, expressed mod p for the curve equations. */
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
/** Curve order n: the prime-order subgroup the protocol works in. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** P-256 cofactor: 1, so every valid point is already in the big subgroup. */
const COFACTOR = 1n;

const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

/** RFC 9383 section 4: fixed points whose discrete log nobody knows. */
export const M_HEX =
  '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
export const N_HEX =
  '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';

/** Affine point: [0n, 0n, 0n] is the point at infinity. */
export type Point = readonly [bigint, bigint, bigint];

export const INFINITY: Point = [0n, 0n, 0n];
export const GENERATOR: Point = [GX, GY, 1n];

function mod(value: bigint): bigint {
  const r = value % P;
  return r < 0n ? r + P : r;
}

function inverse(value: bigint): bigint {
  // Fermat: a^(p-2) mod p. Constant per handshake, ~1ms.
  let result = 1n;
  let base = mod(value);
  let exponent = P - 2n;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % P;
    base = (base * base) % P;
    exponent >>= 1n;
  }
  return result;
}

export function isInfinity(point: Point): boolean {
  return point[2] === 0n;
}

/** y^2 = x^3 + ax + b, in affine terms. */
export function onCurve(point: Point): boolean {
  if (isInfinity(point)) return true;
  const [x, y] = point;
  const left = mod(y * y);
  const right = mod(mod(x * x * x) + mod(A * x) + B);
  return left === right;
}

/**
 * RFC 9383 section 6: every received element MUST be in the large prime-order
 * subgroup. P-256's cofactor is 1, so on-curve implies in-subgroup — the
 * check is kept explicit anyway, so a future curve swap cannot forget it.
 */
export function inSubgroup(point: Point): boolean {
  return onCurve(point) && (isInfinity(point) || mod(COFACTOR) === 1n);
}

export function add(a: Point, b: Point): Point {
  const [x1, y1, z1] = a;
  const [x2, y2, z2] = b;
  if (z1 === 0n) return b;
  if (z2 === 0n) return a;

  const z1s = mod(z1 * z1);
  const z2s = mod(z2 * z2);
  const u1 = mod(x1 * z2s);
  const u2 = mod(x2 * z1s);
  const s1 = mod(y1 * z2 * z2s);
  const s2 = mod(y2 * z1 * z1s);

  if (u1 === u2) {
    if (s1 === s2) return double(a);
    return INFINITY;
  }

  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const h2 = mod(h * h);
  const h3 = mod(h2 * h);
  const u1h2 = mod(u1 * h2);
  const x3 = mod(r * r - h3 - 2n * u1h2);
  const y3 = mod(r * (u1h2 - x3) - s1 * h3);
  const z3 = mod(z1 * z2 * h);
  return [x3, y3, z3];
}

export function double(point: Point): Point {
  if (isInfinity(point)) return INFINITY;
  const [x1, y1, z1] = point;
  if (y1 === 0n) return INFINITY;

  const y1s = mod(y1 * y1);
  const s = mod(4n * x1 * y1s);
  const m = mod(3n * x1 * x1 + A * z1 * z1 * z1 * z1);
  const x3 = mod(m * m - 2n * s);
  const z3 = mod(2n * y1 * z1);
  const y3 = mod(m * (s - x3) - 8n * y1s * y1s);
  return [x3, y3, z3];
}

/** Double-and-add over the scalar's bits, most significant first. */
export function multiply(scalar: bigint, point: Point): Point {
  const k = scalar % N;
  let result: Point = INFINITY;
  let addend: Point = point;
  for (let i = 255; i >= 0; i -= 1) {
    result = double(result);
    if ((k >> BigInt(i)) & 1n) result = add(result, addend);
  }
  return result;
}

export function toAffine(point: Point): Point {
  if (isInfinity(point)) return INFINITY;
  const [x, y, z] = point;
  const zi = inverse(z);
  return [mod(x * zi * zi), mod(y * zi * zi * zi), 1n];
}

/**
 * SEC 1 compressed encoding (33 bytes): 02/03 || x, the format the RFC uses
 * for its fixed M and N constants.
 */
export function encodeCompressed(point: Point): Uint8Array {
  const [x, y] = toAffine(point);
  const out = new Uint8Array(33);
  out[0] = (y & 1n) === 1n ? 0x03 : 0x02;
  for (let i = 0; i < 32; i += 1) {
    out[1 + i] = Number((x >> BigInt(8 * (31 - i))) & 0xffn);
  }
  return out;
}

/** Uncompressed SEC 1 (65 bytes, 0x04 prefix): what flows between peers. */
export function encodeUncompressed(point: Point): Uint8Array {
  const [x, y] = toAffine(point);
  const out = new Uint8Array(65);
  out[0] = 0x04;
  for (let i = 0; i < 32; i += 1) {
    out[1 + i] = Number((x >> BigInt(8 * (31 - i))) & 0xffn);
    out[33 + i] = Number((y >> BigInt(8 * (31 - i))) & 0xffn);
  }
  return out;
}

export class PointDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointDecodeError';
  }
}

/**
 * Decode an uncompressed SEC 1 point. RFC 9383 section 6 makes the subgroup
 * check mandatory: a point off the curve or in a small subgroup aborts the
 * protocol rather than leaking anything.
 */
export function decodeUncompressed(bytes: Uint8Array): Point {
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new PointDecodeError('not an uncompressed 65-byte point');
  }
  let x = 0n;
  let y = 0n;
  for (let i = 0; i < 32; i += 1) {
    x = (x << 8n) | BigInt(bytes[1 + i] ?? 0);
    y = (y << 8n) | BigInt(bytes[33 + i] ?? 0);
  }
  if (x >= P || y >= P) throw new PointDecodeError('coordinate out of field');
  const point: Point = [x, y, 1n];
  if (!inSubgroup(point)) throw new PointDecodeError('point not in subgroup');
  return point;
}

/** Decode RFC's compressed constants (M, N). */
export function decodeCompressed(bytes: Uint8Array): Point {
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
    throw new PointDecodeError('not a compressed 33-byte point');
  }
  const isOdd = bytes[0] === 0x03;
  let x = 0n;
  for (let i = 0; i < 32; i += 1) {
    x = (x << 8n) | BigInt(bytes[1 + i] ?? 0);
  }
  if (x >= P) throw new PointDecodeError('coordinate out of field');

  // y = sqrt(x^3 + ax + b) mod p; p % 4 == 3 so exponent (p+1)/4 is the root.
  const rhs = mod(mod(x * x * x) + mod(A * x) + B);
  const root = powMod(rhs, (P + 1n) / 4n);
  if (mod(root * root) !== rhs) throw new PointDecodeError('x is not on the curve');
  let y = root;
  const odd = (y & 1n) === 1n;
  if (odd !== isOdd) y = P - y;
  const point: Point = [x, y, 1n];
  if (!inSubgroup(point)) throw new PointDecodeError('point not in subgroup');
  return point;
}

function powMod(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/**
 * RFC 9383 section 3.3: x is drawn uniformly from [0, p-1]. WebCrypto's
 * getRandomValues is the CSPRNG; rejection sampling keeps the distribution
 * uniform (simple modulo would bias it).
 */
export function randomScalar(): bigint {
  const bytes = new Uint8Array(48);
  const limit = (1n << 384n) - (1n << 384n) % N;
  for (;;) {
    crypto.getRandomValues(bytes);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < limit) return value % N;
  }
}

export function bytesToNumber(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Big-endian fixed-width encoding of a scalar (32 bytes for P-256). */
export function numberToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export const CURVE = { p: P, a: A, b: B, n: N, cofactor: COFACTOR } as const;
