import { describe, expect, it } from 'vitest';
import { proverStart, proverFinish, verifierStart, verifierFinish } from './spake2';

const CODE = 'آب باد ماه گل';
const WRONG = 'برف کوه درخت باران';

describe('spake2 protocol flow', () => {
  it('completes between two peers with the same room code', () => {
    const prover = proverStart(CODE);
    const verifier = verifierStart(CODE, prover.shareP);

    const sender = proverFinish(prover.state, verifier.shareV, verifier.confirmV);
    const receiver = verifierFinish(verifier.state, sender.confirmP);

    expect(hex(sender.kMain)).toBe(hex(receiver.kMain));
    expect(sender.kMain.length).toBe(32);
  });

  it('produces different kMain for a different code (rejection works)', () => {
    const prover = proverStart(CODE);
    const verifier = verifierStart(CODE, prover.shareP);
    const good = proverFinish(prover.state, verifier.shareV, verifier.confirmV);

    const prover2 = proverStart(WRONG);
    const verifier2 = verifierStart(CODE, prover2.shareP);
    expect(() => proverFinish(prover2.state, verifier2.shareV, verifier2.confirmV)).toThrow();
    void good;
  });

  it('verifier rejects a wrong confirmP', () => {
    const prover = proverStart(CODE);
    const verifier = verifierStart(CODE, prover.shareP);
    const sender = proverFinish(prover.state, verifier.shareV, verifier.confirmV);
    const forged = sender.confirmP.slice();
    forged[0] = (forged[0] ?? 0) ^ 0x01;
    expect(() => verifierFinish(verifier.state, forged)).toThrow();
  });

  it('prover rejects a forged confirmV', () => {
    const prover = proverStart(CODE);
    const verifier = verifierStart(CODE, prover.shareP);
    const forged = verifier.confirmV.slice();
    forged[5] = (forged[5] ?? 0) ^ 0x02;
    expect(() => proverFinish(prover.state, verifier.shareV, forged)).toThrow();
  });

  it('rejects a share that is not a valid curve point', () => {
    const garbage = new Uint8Array(65).fill(9);
    expect(() => verifierStart(CODE, garbage)).toThrow();
  });

  it('shares differ on every run (fresh randomness)', () => {
    const a = proverStart(CODE);
    const b = proverStart(CODE);
    expect(hex(a.shareP)).not.toBe(hex(b.shareP));
  });

  it('derives the same key across many independent runs', () => {
    const codes = ['پل باد آب ماه', 'شب شمع چای عسل', 'کوه سنگ کلید در'];
    for (const code of codes) {
      const prover = proverStart(code);
      const verifier = verifierStart(code, prover.shareP);
      const sender = proverFinish(prover.state, verifier.shareV, verifier.confirmV);
      const receiver = verifierFinish(verifier.state, sender.confirmP);
      expect(hex(sender.kMain)).toBe(hex(receiver.kMain));
    }
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
