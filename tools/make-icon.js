'use strict';

/**
 * Generates assets/icon.png — the app icon — with no external dependencies.
 * A rounded square with the brand gradient and a diamond mark, rendered with
 * 3x3 supersampling for anti-aliased edges. Run: `npm run icon`.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

/* ---- minimal PNG encoder ---- */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- drawing ---- */
const C1 = [255, 140, 66]; // orange
const C2 = [255, 94, 98]; // red
const MARK = [26, 18, 5]; // dark

const lerp = (a, b, t) => a + (b - a) * t;

// macOS-style icon grid: the artwork sits inside the canvas with ~10%
// transparent padding so it matches the size of other dock icons.
const MARGIN = SIZE * 0.1;
const BODY = SIZE - MARGIN * 2;

function insideRoundedRect(x, y, w, h, r) {
  const dx = Math.max(r - x, x - (w - r), 0);
  const dy = Math.max(r - y, y - (h - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function sample(x, y) {
  const bx = x - MARGIN;
  const by = y - MARGIN;
  if (!insideRoundedRect(bx, by, BODY, BODY, BODY * 0.225)) return null;

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const d = Math.abs(x - cx) + Math.abs(y - cy); // diamond distance
  const outer = BODY * 0.3;
  const inner = BODY * 0.205;
  const bar = BODY * 0.033;

  if ((d >= inner && d <= outer) || (Math.abs(x - cx) <= bar && d <= outer)) {
    return MARK;
  }
  const t = Math.max(0, Math.min(1, (bx + by) / (BODY * 2)));
  return [lerp(C1[0], C2[0], t), lerp(C1[1], C2[1], t), lerp(C1[2], C2[2], t)];
}

const buf = Buffer.alloc(SIZE * SIZE * 4);
const SS = 3;

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let covered = 0;
    for (let j = 0; j < SS; j++) {
      for (let i = 0; i < SS; i++) {
        const c = sample(px + (i + 0.5) / SS, py + (j + 0.5) / SS);
        if (c) {
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
    }
    const o = (py * SIZE + px) * 4;
    if (covered === 0) {
      buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
    } else {
      buf[o] = Math.round(r / covered);
      buf[o + 1] = Math.round(g / covered);
      buf[o + 2] = Math.round(b / covered);
      buf[o + 3] = Math.round((covered / (SS * SS)) * 255);
    }
  }
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, encodePNG(SIZE, SIZE, buf));
console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)`);
