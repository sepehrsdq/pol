/**
 * The comparable fingerprint: K_main from SPAKE2 + both sides' DTLS
 * fingerprints → six code words both screens show.
 *
 * Why bind to DTLS: SPAKE2 alone only proves both sides share the room code.
 * A signalling man-in-the-middle can run two independent SPAKE2 sessions (it
 * knows the code — it relayed it) and put itself between the two DTLS hops.
 * But it cannot make both DTLS fingerprints identical, so mixing the real
 * offer/answer fingerprints into the input makes the two screens compute
 * different words — the user sees the mismatch and aborts.
 *
 * Six words from the 64-word pool: 36 bits, so a MITM that must *predict*
 * matching words succeeds with probability 1/64^6 ≈ 1.5e-11 per session.
 */
import { Sha256 } from './sha256';
import { WORDS } from './words';

export const FINGERPRINT_LENGTH = 6;

export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Both `a=fingerprint:` lines of an SDP blob, lower-cased and deduped. */
export function fingerprintsFromSdp(sdp: string): string[] {
  const found: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=fingerprint:\s*(\S+)\s+(\S+)$/i.exec(line.trim());
    if (match) {
      const algo = (match[1] ?? '').toLowerCase();
      const value = (match[2] ?? '').toLowerCase();
      found.push(`${algo} ${value}`);
    }
  }
  return [...new Set(found)];
}

/**
 * Deterministic word sequence: SHA-256 over a domain-separated input of
 * K_main, both fingerprints (sender's first — the fixed order is what makes
 * both sides agree), and the room code. Words come from the same pool as the
 * room code, so comparing feels familiar.
 */
export function fingerprintWords(
  kMain: Uint8Array,
  senderFingerprint: string,
  receiverFingerprint: string,
  roomCode: string,
): string[] {
  const senderBytes = utf8(normalizeFingerprint(senderFingerprint));
  const receiverBytes = utf8(normalizeFingerprint(receiverFingerprint));
  const codeBytes = utf8(roomCode);
  const digest = new Sha256()
    .update(utf8('pol-fingerprint-v1'))
    .update(new Uint8Array([kMain.length]))
    .update(kMain)
    .update(new Uint8Array([senderBytes.length]))
    .update(senderBytes)
    .update(new Uint8Array([receiverBytes.length]))
    .update(receiverBytes)
    .update(new Uint8Array([codeBytes.length]))
    .update(codeBytes)
    .digest();

  const words: string[] = [];
  let round = 0;
  while (words.length < FINGERPRINT_LENGTH && round < 256) {
    // Fresh 16-bit candidates per round, rejection keeps them uniform.
    const block =
      round === 0 ? digest : new Sha256().update(digest).update(utf8(`round-${round}`)).digest();
    for (let i = 0; i + 1 < block.length && words.length < FINGERPRINT_LENGTH; i += 2) {
      const value = (block[i]! << 8) | (block[i + 1] ?? 0);
      const limit = Math.floor(0x10000 / WORDS.length) * WORDS.length;
      if (value < limit) words.push(WORDS[value % WORDS.length] as string);
    }
    round += 1;
  }
  if (words.length < FINGERPRINT_LENGTH) {
    throw new Error('fingerprint: word generation did not converge');
  }
  return words;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
