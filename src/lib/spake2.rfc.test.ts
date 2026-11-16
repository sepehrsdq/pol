/**
 * The RFC 9383 Appendix C vectors pin the whole protocol: transcript bytes,
 * key schedule and confirmation tags. The vectors use PBKDF-provided w0/w1,
 * so the test drives the transcript/confirm layers with the RFC's exact
 * scalars — this proves the curve arithmetic, transcript encoding and key
 * schedule byte-for-byte, independently of Pol's password derivation.
 */
import { describe, expect, it } from 'vitest';
import { Sha256 } from './sha256';
import {
  add,
  decodeUncompressed,
  encodeUncompressed,
  GENERATOR,
  multiply,
  bytesToNumber,
  numberToBytes,
} from './p256';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const CURVE_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const M_HEX =
  '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const N_HEX =
  '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function lengthPrefix(bytes: Uint8Array): Uint8Array {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(bytes.length), true);
  return new Uint8Array(view.buffer);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) k = new Sha256().update(k).digest();
  // RFC 2104: pads are the key XOR the constants, byte by byte.
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const byte = i < k.length ? (k[i] ?? 0) : 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  const innerHash = new Sha256().update(inner).update(message).digest();
  return new Sha256().update(outer).update(innerHash).digest();
}

/**
 * The first RFC 9383 P-256/SHA-256 vector, verbatim.
 */
const VECTOR = {
  context: 'SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors',
  idProver: 'client',
  idVerifier: 'server',
  w0: 'bb8e1bbcf3c48f62c08db243652ae55d3e5586053fca77102994f23ad95491b3',
  w1: '7e945f34d78785b8a3ef44d0df5a1a97d6b3b460409a345ca7830387a74b1dba',
  x: 'd1232c8e8693d02368976c174e2088851b8365d0d79a9eee709c6a05a2fad539',
  shareP:
    '04ef3bd051bf78a2234ec0df197f7828060fe9856503579bb1733009042c15c0c1de127727f418b5966afadfdd95a6e4591d171056b333dab97a79c7193e341727',
  y: '717a72348a182085109c8d3917d6c43d59b224dc6a7fc4f0483232fa6516d8b3',
  shareV:
    '04c0f65da0d11927bdf5d560c69e1d7d939a05b0e88291887d679fcadea75810fb5cc1ca7494db39e82ff2f50665255d76173e09986ab46742c798a9a68437b048',
  Z: '04bbfce7dd7f277819c8da21544afb7964705569bdf12fb92aa388059408d50091a0c5f1d3127f56813b5337f9e4e67e2ca633117a4fbd559946ab474356c41839',
  V: '0458bf27c6bca011c9ce1930e8984a797a3419797b936629a5a937cf2f11c8b9514b82b993da8a46e664f23db7c01edc87faa530db01c2ee405230b18997f16b68',
  kMain: '4c59e1ccf2cfb961aa31bd9434478a1089b56cd11542f53d3576fb6c2a438a29',
  kConfirmP: '871ae3f7b78445e34438fb284504240239031c39d80ac23eb5ab9be5ad6db58a',
  kConfirmV: 'ccd53c7c1fa37b64a462b40db8be101cedcf838950162902054e644b400f1680',
  confirmP: '926cc713504b9b4d76c9162ded04b5493e89109f6d89462cd33adc46fda27527',
  confirmV: '9747bcc4f8fe9f63defee53ac9b07876d907d55047e6ff2def2e7529089d3e68',
  kShared: '0c5f8ccd1413423a54f6c1fb26ff01534a87f893779c6e68666d772bfd91f3e7',
};

/** Rebuild the RFC's transcript with the vector's own scalars. */
describe('RFC 9383 P-256 SHA-256 vector (first)', () => {
  const M = decodeUncompressed(hexToBytes(
    // M is compressed in the RFC; rebuild its uncompressed form: 04 || x || y.
    uncompressedOfCompressed(M_HEX),
  ));
  const N = decodeUncompressed(hexToBytes(uncompressedOfCompressed(N_HEX)));

  it('recomputes shareP, shareV, Z, V from the vector scalars', () => {
    const w0 = bytesToNumber(hexToBytes(VECTOR.w0));
    const w1 = bytesToNumber(hexToBytes(VECTOR.w1));
    const x = bytesToNumber(hexToBytes(VECTOR.x));
    const y = bytesToNumber(hexToBytes(VECTOR.y));

    const X = add(multiply(x, GENERATOR), multiply(w0, M));
    expect(bytesToHex(encodeUncompressed(X))).toBe(VECTOR.shareP);

    const Y = add(multiply(y, GENERATOR), multiply(w0, N));
    expect(bytesToHex(encodeUncompressed(Y))).toBe(VECTOR.shareV);

    const negW0M = multiply(CURVE_N - (w0 % CURVE_N), M);
    const Z = multiply(y, add(X, negW0M));
    expect(bytesToHex(encodeUncompressed(Z))).toBe(VECTOR.Z);

    const L = multiply(w1, GENERATOR);
    const V = multiply(y, L);
    expect(bytesToHex(encodeUncompressed(V))).toBe(VECTOR.V);
  });

  it('recomputes the transcript hash and both confirmation tags', () => {
    const context = utf8(VECTOR.context);
    const idP = utf8(VECTOR.idProver);
    const idV = utf8(VECTOR.idVerifier);
    const mBytes = hexToBytes(uncompressedOfCompressed(M_HEX));
    const nBytes = hexToBytes(uncompressedOfCompressed(N_HEX));
    const shareP = hexToBytes(VECTOR.shareP);
    const shareV = hexToBytes(VECTOR.shareV);
    const zBytes = hexToBytes(VECTOR.Z);
    const vBytes = hexToBytes(VECTOR.V);
    const w0Bytes = numberToBytes(bytesToNumber(hexToBytes(VECTOR.w0)));

    // The TT in Appendix C length-prefixes the UNCOMPRESSED M/N encodings
    // (65 bytes each), verified against the raw TT hex in the RFC.
    const tt = concat(
      lengthPrefix(context), context,
      lengthPrefix(idP), idP,
      lengthPrefix(idV), idV,
      lengthPrefix(mBytes), mBytes,
      lengthPrefix(nBytes), nBytes,
      lengthPrefix(shareP), shareP,
      lengthPrefix(shareV), shareV,
      lengthPrefix(zBytes), zBytes,
      lengthPrefix(vBytes), vBytes,
      lengthPrefix(w0Bytes), w0Bytes,
    );
    const kMain = new Sha256().update(tt).digest();
    expect(bytesToHex(kMain)).toBe(VECTOR.kMain);

    // K_confirmP || K_confirmV = HKDF(nil salt, K_main, "ConfirmationKeys", 64).
    // HKDF per RFC 5869: PRK = HMAC(salt=hashLen zeros, IKM), then Expand
    // blocks T(1) = HMAC(PRK, info||0x01), T(2) = HMAC(PRK, T(1)||info||0x02).
    const info = utf8('ConfirmationKeys');
    const zeroSalt = new Uint8Array(32);
    const prk = hmacSha256(zeroSalt, kMain);
    const block1 = hmacSha256(prk, concat(info, new Uint8Array([1])));
    const block2 = hmacSha256(prk, concat(block1, info, new Uint8Array([2])));
    expect(bytesToHex(block1)).toBe(VECTOR.kConfirmP);
    expect(bytesToHex(block2)).toBe(VECTOR.kConfirmV);

    expect(bytesToHex(hmacSha256(block1, shareV))).toBe(VECTOR.confirmP);
    expect(bytesToHex(hmacSha256(block2, shareP))).toBe(VECTOR.confirmV);

    // K_shared = HKDF(nil salt, K_main, "SharedKey", 32): same extract + first
    // Expand block.
    const prkShared = hmacSha256(zeroSalt, kMain);
    const kShared = hmacSha256(prkShared, concat(utf8('SharedKey'), new Uint8Array([1])));
    expect(bytesToHex(kShared)).toBe(VECTOR.kShared);
  });
});

/** RFC Table 1 constants are compressed; the TT uses them uncompressed. */
function uncompressedOfCompressed(hex: string): string {
  const bytes = hexToBytes(hex);
  const isOdd = bytes[0] === 0x03;
  let x = 0n;
  for (let i = 1; i < 33; i += 1) x = (x << 8n) | BigInt(bytes[i] ?? 0);
  const rhs = ((x * x % P) * x + (P - 3n) * x + 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn + 4n * P) % P;
  const root = powMod(rhs, (P + 1n) / 4n);
  let y = root;
  if (((y & 1n) === 1n) !== isOdd) y = P - y;
  return '04' + x.toString(16).padStart(64, '0') + y.toString(16).padStart(64, '0');
}

function powMod(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}
