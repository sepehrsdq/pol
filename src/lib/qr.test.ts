import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { byteCapacity, encodeQr } from './qr';

/** Render a matrix into RGBA pixels (4 px per module, quiet zone around it). */
function rasterize(matrix: boolean[][], scale = 4, quiet = 4): Uint8ClampedArray {
  const size = matrix.length;
  const width = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!(matrix[y] as boolean[])[x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = ((quiet + x) * scale + dx + ((quiet + y) * scale + dy) * width) * 4;
          data[px] = 0;
          data[px + 1] = 0;
          data[px + 2] = 0;
        }
      }
    }
  }
  return data;
}

function decode(matrix: boolean[][]): string | null {
  const size = matrix.length;
  const width = (size + 8) * 4;
  const result = jsQR(rasterize(matrix), width, width);
  return result?.data ?? null;
}

describe('encodeQr', () => {
  it('encodes a share URL and a real decoder reads it back', () => {
    const text = 'https://qqsp.ir/#آب-باد-ماه-گل';
    const matrix = encodeQr(text);
    expect(decode(matrix)).toBe(text);
  });

  it('picks a version that fits the payload', () => {
    const matrix = encodeQr('https://qqsp.ir/#آب-باد-ماه-گل');
    // 40 UTF-8 bytes fit version 3 (29x29) at level M; every QR size is 4n+1.
    expect(matrix.length).toBeGreaterThanOrEqual(29);
    expect(matrix.length % 4).toBe(1);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
  });

  it('keeps the three finder patterns in place', () => {
    const matrix = encodeQr('pol');
    const size = matrix.length;
    const corners: [number, number][] = [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ];
    for (const [cx, cy] of corners) {
      expect(matrix[cy]![cx]).toBe(true);
      expect(matrix[cy + 1]![cx + 1]).toBe(false);
      expect(matrix[cy + 3]![cx + 3]).toBe(true);
    }
  });

  it('round-trips through several versions', () => {
    for (const length of [10, 40, 80, 120, 160]) {
      const text = `https://qqsp.ir/#${'x'.repeat(length)}`;
      expect(decode(encodeQr(text))).toBe(text);
    }
  });

  it('reports capacity that shrinks with padding needs', () => {
    expect(byteCapacity(1)).toBe(14);
    expect(byteCapacity(10)).toBe(213);
  });
});
