import { describe, expect, it } from 'vitest';
import { buildZip, type ZipEntry } from './zip';
import { crc32 } from './crc32';

/** Materialize the generator into one buffer, applying patches. */
async function materialize(entries: ZipEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const pendingPatches: { offset: number; value: number }[] = [];

  for await (const chunk of buildZip(entries)) {
    if (chunk.kind === 'bytes') parts.push(chunk.data);
    else pendingPatches.push({ offset: chunk.offset, value: chunk.value });
  }

  // Apply each patch: locate the part that contains the absolute offset.
  for (const patch of pendingPatches) {
    let acc = 0;
    let applied = false;
    for (const part of parts) {
      if (patch.offset < acc + part.length) {
        const local = patch.offset - acc;
        const dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
        dv.setUint32(local, patch.value >>> 0, true);
        applied = true;
        break;
      }
      acc += part.length;
    }
    if (!applied) throw new Error(`patch offset ${patch.offset} out of range`);
  }

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const buffer = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    buffer.set(part, cursor);
    cursor += part.length;
  }
  return buffer;
}

function textEntry(name: string, text: string): ZipEntry {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.length,
    read: async function* () {
      yield bytes;
    },
  };
}

describe('buildZip', () => {
  it('starts with the local header signature and stores the file', async () => {
    const buffer = await materialize([textEntry('hello.txt', 'hello world')]);
    const view = new DataView(buffer.buffer);

    expect(buffer[0]).toBe(0x50); // "P"
    expect(buffer[1]).toBe(0x4b); // "K"
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // Stored bytes appear verbatim after the 30-byte header + name.
    const nameLen = view.getUint16(26, true);
    const payload = new TextDecoder().decode(buffer.subarray(30 + nameLen, 30 + nameLen + 11));
    expect(payload).toBe('hello world');
  });

  it('patches the CRC and sizes into the local header', async () => {
    const text = 'pol archive test';
    const buffer = await materialize([textEntry('a.txt', text)]);
    const view = new DataView(buffer.buffer);
    const expected = parseInt(crc32(new TextEncoder().encode(text)), 16);

    expect(view.getUint32(14, true)).toBe(expected);
    expect(view.getUint32(18, true)).toBe(text.length);
    expect(view.getUint32(22, true)).toBe(text.length);
  });

  it('writes a central directory and EOCD with the right counts', async () => {
    const entries = [textEntry('a.txt', 'aaa'), textEntry('b/c.txt', 'bbb')];
    const buffer = await materialize(entries);
    const view = new DataView(buffer.buffer);

    // Locate the EOCD by signature rather than assuming the tail length.
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 100; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    expect(eocd).toBeGreaterThan(0);
    // EOCD layout: entries-this-disk at +8, total entries at +10.
    expect(view.getUint16(eocd + 8, true)).toBe(2);
    expect(view.getUint16(eocd + 10, true)).toBe(2);

    // Central directory contains both names.
    const bytes = new TextDecoder().decode(buffer);
    expect(bytes).toContain('a.txt');
    expect(bytes).toContain('b/c.txt');
  });

  it('rejects an entry that yields the wrong size', async () => {
    const bad: ZipEntry = {
      name: 'bad.bin',
      size: 10,
      read: async function* () {
        yield new Uint8Array(5);
      },
    };
    await expect(materialize([bad])).rejects.toThrow(/expected 10/);
  });

  it('keeps the whole archive CRC-consistent: stored bytes match declared CRC', async () => {
    const text = 'consistent';
    const buffer = await materialize([textEntry('x.txt', text)]);
    const view = new DataView(buffer.buffer);
    const declared = view.getUint32(14, true);

    const nameLen = view.getUint16(26, true);
    const payload = buffer.subarray(30 + nameLen, 30 + nameLen + text.length);
    expect(declared).toBe(parseInt(crc32(payload), 16));
  });
});
