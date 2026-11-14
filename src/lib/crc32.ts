// CRC-32 (IEEE 802.3), the checksum ZIP uses. Table-driven, incremental.

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Streaming CRC-32: feed chunks, read digestHex at the end. */
export class Crc32 {
  private state = 0xffffffff;

  update(bytes: Uint8Array): this {
    let c = this.state;
    const table = TABLE;
    for (let i = 0; i < bytes.length; i += 1) {
      const byte: number = bytes[i] ?? 0;
      c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    }
    this.state = c;
    return this;
  }

  /** Unsigned CRC-32 value. */
  value(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }

  /** Eight lowercase hex digits, as ZIP headers want them. */
  digestHex(): string {
    return this.value().toString(16).padStart(8, '0');
  }
}

/** One-shot helper for tests and small buffers. */
export function crc32(bytes: Uint8Array): string {
  return new Crc32().update(bytes).digestHex();
}
