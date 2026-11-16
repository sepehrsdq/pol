/**
 * SPAKE2+ per RFC 9383 — the password is the four-word room code.
 *
 * Both peers derive w0/w1 from the password; the sender speaks first, so it
 * takes the RFC's Prover role (X = x*P + w0*M) and the receiver the Verifier
 * role (Y = y*P + w0*N). Flow over the existing relayed channel, no new
 * server involvement:
 *
 *   sender:  shareP                 →  receiver
 *   receiver: shareV + confirmV     →  sender
 *   sender:  confirmP               →  receiver
 *
 * After the confirmations both sides hold K_main; the visible fingerprint is
 * derived from it (fingerprint.ts) and binds this transcript to the DTLS
 * fingerprints inside the SDP offer/answer, so a signalling man-in-the-middle
 * re-encrypting both legs with different DTLS keys produces visibly different
 * code words on the two screens.
 */
import { Sha256 } from './sha256';
import {
  add,
  decodeCompressed,
  decodeUncompressed,
  encodeUncompressed,
  GENERATOR,
  isInfinity,
  multiply,
  randomScalar,
  bytesToNumber,
  numberToBytes,
  type Point,
} from './p256';

/** RFC 9383 section 4: fixed points for P-256, discrete log unknown. */
const M_HEX =
  '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const N_HEX =
  '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';

const M = decodeCompressed(hexToBytes(M_HEX));
const N = decodeCompressed(hexToBytes(N_HEX));
const M_ENC = hexToBytes(M_HEX);
const N_ENC = hexToBytes(N_HEX);

const CURVE_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const CONTEXT = 'pol v0.7 SPAKE2+ P-256 SHA-256';
const ID_PROVER = 'pol-sender';
const ID_VERIFIER = 'pol-receiver';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** RFC 9383: len(S) as an 8-byte little-endian number. */
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

/**
 * RFC 9383 section 3.2 RECOMMENDS a PBKDF for slow passwords. Pol's password
 * is 4 words from a 64-word pool (24 bits), but it changes per session and
 * the server rate-limits joins, so brute force is bounded by the room's short
 * lifetime — a plain hash keeps both sides identical without shipping scrypt.
 * Identity strings are fixed constants folded in for domain separation.
 */
function deriveW0W1(password: string): { w0: bigint; w1: bigint } {
  const pw = utf8(password);
  const idP = utf8(ID_PROVER);
  const idV = utf8(ID_VERIFIER);
  const digest = new Sha256()
    .update(lengthPrefix(pw))
    .update(pw)
    .update(lengthPrefix(idP))
    .update(idP)
    .update(lengthPrefix(idV))
    .update(idV)
    .digest();
  const digest2 = new Sha256().update(digest).update(utf8('pol-w1')).digest();
  return {
    w0: bytesToNumber(digest) % CURVE_N,
    w1: bytesToNumber(digest2) % CURVE_N,
  };
}

/** The Prover's session state between round 1 and round 2. */
export interface ProverState {
  x: bigint;
  w0: bigint;
  w1: bigint;
  share: Point;
}

/** The Verifier's session state between round 1 and round 2. */
export interface VerifierState {
  y: bigint;
  w0: bigint;
  share: Point;
  /** (Z, V) stay pending until confirmP arrives, per RFC Appendix A.2. */
  shareP: Uint8Array;
  Z: Point;
  V: Point;
}

export interface ProverStart {
  state: ProverState;
  /** Uncompressed SEC 1 encoding of X — what goes on the wire. */
  shareP: Uint8Array;
}

export interface VerifierStart {
  state: VerifierState;
  shareV: Uint8Array;
  confirmV: Uint8Array;
}

/** Round 1, sender (Prover): X = x*P + w0*M. */
export function proverStart(password: string): ProverStart {
  const { w0, w1 } = deriveW0W1(password);
  const x = randomScalar();
  const share = add(multiply(x, GENERATOR), multiply(w0, M));
  return {
    state: { x, w0, w1, share },
    shareP: encodeUncompressed(share),
  };
}

/** Round 1, receiver (Verifier): Y = y*P + w0*N, then confirmV over shareP. */
export function verifierStart(password: string, shareP: Uint8Array): VerifierStart {
  const { w0, w1 } = deriveW0W1(password);
  const X = decodeUncompressed(shareP);
  if (isInfinity(X)) throw new Error('spake: peer share is the point at infinity');
  const y = randomScalar();
  const share = add(multiply(y, GENERATOR), multiply(w0, N));
  // Z = y*(X - w0*M), V = y*L with L = w1*P. Cofactor is 1 on P-256, so the
  // RFC's h-multiplication is a no-op and subgroup membership was already
  // checked in decodeUncompressed.
  const negW0M = multiply(CURVE_N - (w0 % CURVE_N), M);
  const Z = multiply(y, add(X, negW0M));
  const L = multiply(w1, GENERATOR);
  const V = multiply(y, L);

  const state: VerifierState = { y, w0, share, shareP, Z, V };
  const tt = transcript(shareP, encodeUncompressed(share), Z, V, w0);
  const { kConfirmV } = keySchedule(tt);
  return {
    state,
    shareV: encodeUncompressed(share),
    confirmV: hmacSha256(kConfirmV, shareP),
  };
}

export interface ProverFinish {
  confirmP: Uint8Array;
  /** The transcript hash both sides now agree on. */
  kMain: Uint8Array;
}

/** Round 2, sender: verify confirmV, then emit confirmP. */
export function proverFinish(
  state: ProverState,
  shareV: Uint8Array,
  confirmV: Uint8Array,
): ProverFinish {
  const Y = decodeUncompressed(shareV);
  if (isInfinity(Y)) throw new Error('spake: peer share is the point at infinity');
  const negW0N = multiply(CURVE_N - (state.w0 % CURVE_N), N);
  const peerMinus = add(Y, negW0N);
  const Z = multiply(state.x, peerMinus);
  const V = multiply(state.w1, peerMinus);
  const shareP = encodeUncompressed(state.share);
  const tt = transcript(shareP, shareV, Z, V, state.w0);
  const { kMain, kConfirmP, kConfirmV } = keySchedule(tt);
  const expected = hmacSha256(kConfirmV, shareP);
  if (!constantTimeEquals(expected, confirmV)) {
    throw new Error('spake: key confirmation failed — the room code does not match');
  }
  return { confirmP: hmacSha256(kConfirmP, shareV), kMain };
}

export interface VerifierFinish {
  kMain: Uint8Array;
}

/** Round 2, receiver: verify confirmP against the pending (Z, V). */
export function verifierFinish(
  state: VerifierState,
  confirmP: Uint8Array,
): VerifierFinish {
  const shareV = encodeUncompressed(state.share);
  const tt = transcript(state.shareP, shareV, state.Z, state.V, state.w0);
  const { kMain, kConfirmP } = keySchedule(tt);
  const expected = hmacSha256(kConfirmP, shareV);
  if (!constantTimeEquals(expected, confirmP)) {
    throw new Error('spake: key confirmation failed — the room code does not match');
  }
  return { kMain };
}

/**
 * RFC 9383 section 3.3, verbatim layout: every field length-prefixed with an
 * 8-byte little-endian count, context first, w0 last.
 */
function transcript(
  shareP: Uint8Array,
  shareV: Uint8Array,
  Z: Point,
  V: Point,
  w0: bigint,
): Uint8Array {
  const context = utf8(CONTEXT);
  const idP = utf8(ID_PROVER);
  const idV = utf8(ID_VERIFIER);
  const zBytes = encodeUncompressed(Z);
  const vBytes = encodeUncompressed(V);
  const w0Bytes = numberToBytes(w0);
  return concat(
    lengthPrefix(context), context,
    lengthPrefix(idP), idP,
    lengthPrefix(idV), idV,
    lengthPrefix(M_ENC), M_ENC,
    lengthPrefix(N_ENC), N_ENC,
    lengthPrefix(shareP), shareP,
    lengthPrefix(shareV), shareV,
    lengthPrefix(zBytes), zBytes,
    lengthPrefix(vBytes), vBytes,
    lengthPrefix(w0Bytes), w0Bytes,
  );
}

/**
 * The RFC's KDF is HKDF-SHA256 with an empty salt. HKDF-Extract with a nil
 * salt hashes K_main under 32 zero bytes (RFC 5869), then Expand produces
 * 64 bytes: T(1) = HMAC(PRK, info || 0x01), T(2) = HMAC(PRK, T(1) || info || 0x02).
 */
function hkdfExpand64(kMain: Uint8Array, info: Uint8Array): [Uint8Array, Uint8Array] {
  const zeroSalt = new Uint8Array(32);
  const prk = hmacSha256(zeroSalt, kMain);
  const t1 = hmacSha256(prk, concat(info, new Uint8Array([1])));
  const t2 = hmacSha256(prk, concat(t1, info, new Uint8Array([2])));
  return [t1, t2];
}

/**
 * K_main = Hash(TT). The confirmation keys come from the RFC's KDF, which
 * with empty salt and 64 requested bytes collapses to two HKDF-Expand blocks:
 * HMAC(K_main, info || 0x01) and HMAC(K_main, info || 0x02).
 */
function keySchedule(tt: Uint8Array): {
  kMain: Uint8Array;
  kConfirmP: Uint8Array;
  kConfirmV: Uint8Array;
} {
  const kMain = new Sha256().update(tt).digest();
  const [kConfirmP, kConfirmV] = hkdfExpand64(kMain, utf8('ConfirmationKeys'));
  return { kMain, kConfirmP, kConfirmV };
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * HMAC-SHA256 per RFC 2104 over the home-grown incremental SHA-256. The pads
 * are the key XOR the constants, byte by byte — not the constants followed by
 * the key (that bug only shows with a non-zero key, and every KDF key here is
 * non-zero).
 */
function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) k = new Sha256().update(k).digest();
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
