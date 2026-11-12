import { describe, expect, it } from 'vitest';
import { Sha256, hashFile, sha256Hex } from './sha256';

const encode = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

describe('Sha256', () => {
  it('matches the empty string vector', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the "abc" vector', () => {
    expect(sha256Hex(encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes one million "a" characters', () => {
    expect(sha256Hex(encode('a'.repeat(1_000_000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('gives the same digest whether fed in one or many slices', () => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 256;

    const oneShot = sha256Hex(bytes);
    const sliced = new Sha256();
    sliced.update(bytes.subarray(0, 13));
    sliced.update(bytes.subarray(13, 64));
    sliced.update(bytes.subarray(64, 1000));
    sliced.update(bytes.subarray(1000));

    expect(sliced.digestHex()).toBe(oneShot);
  });

  it('refuses to digest twice', () => {
    const hash = new Sha256().update(encode('x'));
    hash.digestHex();
    expect(() => hash.digestHex()).toThrow();
  });
});

describe('hashFile', () => {
  it('hashes a File and reports progress', async () => {
    const file = new File([encode('hello world')], 'hello.txt', { type: 'text/plain' });
    const ratios: number[] = [];
    const digest = await hashFile(file, (ratio) => ratios.push(ratio));

    expect(digest).toBe(sha256Hex(encode('hello world')));
    expect(ratios.at(-1)).toBe(1);
  });
});
