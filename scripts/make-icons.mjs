// Generates the PWA icons from the same bridge mark the header uses.
// Run with `node scripts/make-icons.mjs`; output is committed so the build
// never needs this script. No image library involved: plain RGBA + zlib.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'public/icons';
const BG = [11, 18, 32]; // --ink from the dark theme
const MARK = [110, 160, 255]; // --primary in dark mode

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded-rect coverage with one-pixel antialiasing. */
function roundedRect(px, py, x, y, w, h, r, scale) {
  const dx = Math.max(x - px, 0, px - (x + w));
  const dy = Math.max(y - py, 0, py - (y + h));
  const distance = Math.hypot(dx, dy) - r;
  return Math.min(1, Math.max(0, 0.5 - distance / scale));
}

/** Draw the bridge mark into a size×size RGBA buffer. */
function icon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  // The mark is designed on a 32-unit grid with 20% padding for maskable icons.
  const padding = size * 0.2;
  const scale = (size - padding * 2) / 32;

  const shapes = [
    // two posts
    { x: 3, y: 8, w: 9, h: 16, r: 3 },
    { x: 20, y: 8, w: 9, h: 16, r: 3 },
    // the deck that joins them
    { x: 10, y: 14.6, w: 12, h: 2.8, r: 1.4 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Unit-space coordinates inside the padded mark.
      const ux = (x + 0.5 - padding) / scale;
      const uy = (y + 0.5 - padding) / scale;
      let cover = 0;
      for (const s of shapes) {
        cover = Math.max(cover, roundedRect(ux, uy, s.x, s.y, s.w, s.h, s.r, 1 / scale));
      }
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        pixels[i + c] = Math.round(BG[c] + (MARK[c] - BG[c]) * cover);
      }
      pixels[i + 3] = 255;
    }
  }
  return png(size, pixels);
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512, 180]) {
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(`${OUT}/${name}`, icon(size));
  console.log(`wrote ${OUT}/${name}`);
}

// A crisp vector favicon for the tab.
writeFileSync(
  'public/favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0b1220"/>
  <g fill="#6ea0ff">
    <rect x="6" y="11" width="7" height="12" rx="2.5"/>
    <rect x="19" y="11" width="7" height="12" rx="2.5"/>
    <rect x="11.6" y="15.1" width="8.8" height="2.4" rx="1.2"/>
  </g>
</svg>
`,
);
console.log('wrote public/favicon.svg');
