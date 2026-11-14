// Minimal ZIP writer for the folder-transfer feature.
//
// Design: "store" method (no compression) with streaming CRC — each file's
// bytes flow through the CRC as they are produced, and the local header is
// patched afterwards. Files are never held in memory whole; only the current
// 1 MB read block lives briefly. The central directory is tiny (per-file
// metadata) and is emitted at the end.
//
// Data descriptor (bit 3 of the flags) is used instead of seeking back: the
// streaming output can stay sequential, which fits chunked sending.

import { Crc32 } from './crc32';

/** DOS timestamp: 2-second resolution, local time. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

export interface ZipEntry {
  /** Path inside the archive; forward slashes, no leading slash. */
  name: string;
  size: number;
  /** Produce the file bytes in chunks; must yield exactly `size` bytes. */
  read: () => AsyncGenerator<Uint8Array>;
  modified?: Date;
}

export type ZipChunk =
  | { kind: 'bytes'; data: Uint8Array }
  | { kind: 'patch'; /** Offset of the little-endian value to set. */ offset: number; value: number };

/**
 * Build a ZIP archive as an ordered mix of raw bytes and header patches.
 * The caller streams the chunks and applies patches to its own output buffer
 * before sending the patched range onward.
 */
export async function* buildZip(
  entries: ZipEntry[],
  now: Date = new Date(),
): AsyncGenerator<ZipChunk> {
  const encoder = new TextEncoder();
  const offsets: { name: string; offset: number; size: number; crc: number; time: number; date: number }[] = [];
  let out = 0;

  const emit = function* (bytes: Uint8Array): Generator<ZipChunk> {
    if (bytes.length > 0) yield { kind: 'bytes', data: bytes };
    out += bytes.length;
  };
  const u16 = (value: number): Uint8Array => {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
  };
  const u32 = (value: number): Uint8Array => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const { time, date } = dosDateTime(entry.modified ?? now);
    const localOffset = out;
    const crc = new Crc32();

    // Local file header; sizes and CRC are zero here, patched after streaming.
    yield* emit(u32(0x04034b50));
    yield* emit(u16(20)); // version needed
    yield* emit(u16(0x0008)); // flags: bit 3 = data descriptor
    yield* emit(u16(0)); // method: store
    yield* emit(u16(time));
    yield* emit(u16(date));
    yield* emit(u32(0)); // crc (patch)
    yield* emit(u32(0)); // compressed size (patch)
    yield* emit(u32(0)); // uncompressed size (patch)
    yield* emit(u16(nameBytes.length));
    yield* emit(u16(0)); // extra length
    // Patch offsets must be captured before the name shifts `out` past the
    // header. Header layout (30 bytes): crc at 14, csize at 18, usize at 22 —
    // i.e. from the end: crc -16, csize -12, usize -8.
    const crcPatchOffset = out - 16;
    const sizePatchOffset = out - 12;
    const unpPatchOffset = out - 8;
    yield* emit(nameBytes);

    let written = 0;
    for await (const chunk of entry.read()) {
      crc.update(chunk);
      written += chunk.length;
      yield* emit(chunk);
    }
    if (written !== entry.size) {
      throw new Error(`zip entry "${entry.name}" produced ${written} bytes, expected ${entry.size}`);
    }

    // Data descriptor (no signature variant, sizes are known so readers cope).
    yield* emit(u32(crc.value()));
    yield* emit(u32(written));
    yield* emit(u32(written));

    offsets.push({ name: entry.name, offset: localOffset, size: written, crc: crc.value(), time, date });
    yield { kind: 'patch', offset: crcPatchOffset, value: crc.value() };
    yield { kind: 'patch', offset: sizePatchOffset, value: written };
    yield { kind: 'patch', offset: unpPatchOffset, value: written };
  }

  // Central directory.
  const centralStart = out;
  for (const entry of offsets) {
    const nameBytes = encoder.encode(entry.name);
    yield* emit(u32(0x02014b50));
    yield* emit(u16(20)); // version made by
    yield* emit(u16(20)); // version needed
    yield* emit(u16(0x0008)); // flags
    yield* emit(u16(0)); // method: store
    yield* emit(u16(entry.time));
    yield* emit(u16(entry.date));
    yield* emit(u32(entry.crc));
    yield* emit(u32(entry.size));
    yield* emit(u32(entry.size));
    yield* emit(u16(nameBytes.length));
    yield* emit(u16(0)); // extra
    yield* emit(u16(0)); // comment
    yield* emit(u16(0)); // disk number
    yield* emit(u16(0)); // internal attrs
    yield* emit(u32(0)); // external attrs
    yield* emit(u32(entry.offset));
    yield* emit(nameBytes);
  }
  const centralSize = out - centralStart;

  // End of central directory.
  yield* emit(u32(0x06054b50));
  yield* emit(u16(0));
  yield* emit(u16(0));
  yield* emit(u16(offsets.length));
  yield* emit(u16(offsets.length));
  yield* emit(u32(centralSize));
  yield* emit(u32(centralStart));
  yield* emit(u16(0));
}
