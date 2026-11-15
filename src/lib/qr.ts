// Minimal QR encoder — byte mode, error-correction level M, versions 1..15.
//
// A share link is short (origin + four Persian words), so keeping the table to
// fifteen versions is enough and avoids shipping a 30 KB third-party encoder.
// The matrix is verified against a real decoder in the unit tests.

export type QrMatrix = boolean[][];

/** Error-correction codewords per block, blocks, data codewords per block. */
const BLOCKS: Record<number, [ec: number, g1: number, d1: number, g2: number, d2: number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
};

const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
};

/* ---------- GF(256) arithmetic for Reed-Solomon ---------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** Generator polynomial for `degree` error codewords, leading 1 included. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const root = EXP[i] as number;
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, root);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], ecLength: number): number[] {
  const gen = generator(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i += 1) {
      remainder[i] = (remainder[i] as number) ^ gfMul(gen[i + 1] as number, factor);
    }
  }
  return [...remainder];
}

/* ---------- bit stream ---------- */

class Bits {
  readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }
}

/** Byte-mode data capacity, in bytes, for a version. */
export function byteCapacity(version: number): number {
  const block = BLOCKS[version];
  if (!block) return 0;
  const [, g1, d1, g2, d2] = block;
  const codewords = g1 * d1 + g2 * d2;
  // Mode indicator (4) + character count (8 or 16) eats into the payload.
  const header = version < 10 ? 12 : 20;
  return Math.floor((codewords * 8 - header) / 8);
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 15; version += 1) {
    if (byteCapacity(version) >= byteLength) return version;
  }
  throw new Error('qr: text too long for versions 1..15');
}

/* ---------- matrix building ---------- */

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    (this.modules[y] as boolean[])[x] = dark;
    (this.reserved[y] as boolean[])[x] = true;
  }

  isReserved(x: number, y: number): boolean {
    return (this.reserved[y] as boolean[])[x] as boolean;
  }

  isDark(x: number, y: number): boolean {
    return (this.modules[y] as boolean[])[x] as boolean;
  }
}

function placeFinder(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const inRing = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
        (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6));
      const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      matrix.set(x, y, inRing || inCore);
    }
  }
}

function placeAlignment(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      matrix.set(cx + dx, cy + dy, ring !== 1);
    }
  }
}

function formatBits(mask: number): number {
  const level = 0b00; // M
  const data = (level << 3) | mask;
  let value = data << 10;
  const gen = 0b10100110111;
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >>> (i + 10)) & 1) value ^= gen << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function versionBits(version: number): number {
  let value = version << 12;
  const gen = 0b1111100100101;
  for (let i = 5; i >= 0; i -= 1) {
    if ((value >>> (i + 12)) & 1) value ^= gen << i;
  }
  return (version << 12) | value;
}

function placeFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, size - 7, 0);
  placeFinder(matrix, 0, size - 7);

  for (let i = 8; i < size - 8; i += 1) {
    matrix.set(i, 6, i % 2 === 0);
    matrix.set(6, i, i % 2 === 0);
  }
  matrix.set(8, size - 8, true); // dark module

  const centers = ALIGNMENT[version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      const overlapsFinder =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (!overlapsFinder) placeAlignment(matrix, cx, cy);
    }
  }

  // Reserve format areas; the real bits are written after masking.
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      matrix.set(8, i, false);
      matrix.set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    matrix.set(8, size - 1 - i, false);
    matrix.set(size - 1 - i, 8, false);
  }

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      matrix.set(a, b, bit);
      matrix.set(b, a, bit);
    }
  }
}

function placeData(matrix: Matrix, codewords: number[]): void {
  const size = matrix.size;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (matrix.isReserved(x, y)) continue;
        const bit =
          bitIndex < codewords.length * 8
            ? ((codewords[bitIndex >> 3] as number) >>> (7 - (bitIndex & 7))) & 1
            : 0;
        matrix.modules[y]![x] = bit === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASK: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix: Matrix, mask: number): void {
  const fn = MASK[mask] as (x: number, y: number) => boolean;
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.isReserved(x, y)) continue;
      if (fn(x, y)) matrix.modules[y]![x] = !matrix.isDark(x, y);
    }
  }
}

function writeFormat(matrix: Matrix, mask: number): void {
  const size = matrix.size;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    // Around the top-left finder.
    if (i < 6) matrix.set(8, i, dark);
    else if (i < 8) matrix.set(8, i + 1, dark);
    else matrix.set(8, size - 15 + i, dark);
    // The mirror copy.
    if (i < 8) matrix.set(size - 1 - i, 8, dark);
    else matrix.set(15 - i - 1, 8, dark);
  }
  matrix.set(8, size - 8, true); // dark module stays dark
}

/** Penalty score used to pick the mask with the fewest artefacts. */
function penalty(matrix: Matrix): number {
  const size = matrix.size;
  let score = 0;

  const line = (get: (i: number) => boolean): number => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
        if (run === 5) total += 3;
        else if (run > 5) total += 1;
      } else {
        run = 1;
      }
    }
    return total;
  };

  for (let y = 0; y < size; y += 1) score += line((i) => matrix.isDark(i, y));
  for (let x = 0; x < size; x += 1) score += line((i) => matrix.isDark(x, i));

  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (get: (i: number) => boolean, start: number): boolean => {
    for (let k = 0; k < 11; k += 1) if (get(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x + 11 <= size; x += 1) {
      if (matches((i) => matrix.isDark(i, y), x)) score += 40;
      if (matches((i) => matrix.isDark(y, i), x)) score += 40;
    }
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const dark = matrix.isDark(x, y);
      if (
        matrix.isDark(x + 1, y) === dark &&
        matrix.isDark(x, y + 1) === dark &&
        matrix.isDark(x + 1, y + 1) === dark
      ) {
        score += 3;
      }
    }
  }

  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (matrix.isDark(x, y)) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Encode text as a QR matrix (true = dark). */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const block = BLOCKS[version] as [number, number, number, number, number];
  const [ecLength, g1, d1, g2, d2] = block;
  const dataCodewords = g1 * d1 + g2 * d2;

  const bits = new Bits();
  bits.put(0b0100, 4);
  bits.put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) bits.put(byte, 8);
  const capacity = dataCodewords * 8;
  const terminator = Math.min(4, capacity - bits.length);
  bits.put(0, terminator);
  while (bits.length % 8 !== 0) bits.bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | (bits.bits[i + k] as number);
    data.push(byte);
  }
  const pad = [0xec, 0x11];
  for (let i = 0; data.length < dataCodewords; i += 1) data.push(pad[i % 2] as number);

  // Split into blocks, compute EC per block, then interleave.
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < g1; i += 1) {
    const part = data.slice(cursor, cursor + d1);
    cursor += d1;
    dataBlocks.push(part);
    ecBlocks.push(reedSolomon(part, ecLength));
  }
  for (let i = 0; i < g2; i += 1) {
    const part = data.slice(cursor, cursor + d2);
    cursor += d2;
    dataBlocks.push(part);
    ecBlocks.push(reedSolomon(part, ecLength));
  }

  const interleaved: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i += 1) {
    for (const part of dataBlocks) if (i < part.length) interleaved.push(part[i] as number);
  }
  for (let i = 0; i < ecLength; i += 1) {
    for (const part of ecBlocks) interleaved.push(part[i] as number);
  }

  const matrix = new Matrix(version);
  placeFunctionPatterns(matrix, version);
  placeData(matrix, interleaved);

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(matrix, mask);
    writeFormat(matrix, mask);
    const score = penalty(matrix);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    // Undo before trying the next mask.
    applyMask(matrix, mask);
  }
  applyMask(matrix, bestMask);
  writeFormat(matrix, bestMask);

  return matrix.modules;
}
