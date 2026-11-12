const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Incremental SHA-256. Used to verify a transfer without loading the
 * whole file into memory twice.
 */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  // Reused per block: allocating 256 bytes per 64-byte block dominates
  // hashing cost on multi-gigabyte files.
  private readonly w = new Uint32Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('sha256: update() after digest()');
    this.bytesHashed += data.length;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let offset = 0;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.length);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength === 64) {
        this.compress(this.blockView, 0);
        this.blockLength = 0;
      }
    }

    while (offset + 64 <= data.length) {
      this.compress(view, offset);
      offset += 64;
    }

    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('sha256: digest() called twice');
    this.finished = true;

    const bitLengthHigh = Math.floor(this.bytesHashed / 0x20000000);
    const bitLengthLow = (this.bytesHashed * 8) >>> 0;

    const paddedLength = this.blockLength < 56 ? 64 : 128;
    const padding = new Uint8Array(paddedLength);
    padding.set(this.block.subarray(0, this.blockLength));
    padding[this.blockLength] = 0x80;

    const view = new DataView(padding.buffer);
    view.setUint32(paddedLength - 8, bitLengthHigh);
    view.setUint32(paddedLength - 4, bitLengthLow);

    for (let offset = 0; offset < paddedLength; offset += 64) {
      this.compress(view, offset);
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.state[i] as number);
    return out;
  }

  digestHex(): string {
    return Array.from(this.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private compress(view: DataView, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);

    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = this.state[0] as number;
    let b = this.state[1] as number;
    let c = this.state[2] as number;
    let d = this.state[3] as number;
    let e = this.state[4] as number;
    let f = this.state[5] as number;
    let g = this.state[6] as number;
    let h = this.state[7] as number;

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.state[0] = ((this.state[0] as number) + a) >>> 0;
    this.state[1] = ((this.state[1] as number) + b) >>> 0;
    this.state[2] = ((this.state[2] as number) + c) >>> 0;
    this.state[3] = ((this.state[3] as number) + d) >>> 0;
    this.state[4] = ((this.state[4] as number) + e) >>> 0;
    this.state[5] = ((this.state[5] as number) + f) >>> 0;
    this.state[6] = ((this.state[6] as number) + g) >>> 0;
    this.state[7] = ((this.state[7] as number) + h) >>> 0;
  }
}

export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex();
}

/** Hash a File in slices, so a 2 GB file does not need 2 GB of RAM. */
export async function hashFile(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<string> {
  const hash = new Sha256();
  const sliceSize = 4 * 1024 * 1024;

  for (let offset = 0; offset < file.size; offset += sliceSize) {
    const chunk = await file.slice(offset, offset + sliceSize).arrayBuffer();
    hash.update(new Uint8Array(chunk));
    onProgress?.(Math.min(1, (offset + sliceSize) / file.size));
  }

  onProgress?.(1);
  return hash.digestHex();
}
