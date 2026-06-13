'use strict';
// Generates the VoxelDeck app icon: a minimal white isometric cube on a blue
// background. Rendered at 4× and downsampled with coverage-correct alpha so the
// edges are smooth and fringe-free. Run: node scripts/make-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 256;        // output size
const SS = 4;         // supersample factor
const BIG = S * SS;   // render resolution

// palette
const BG_TOP = [58, 136, 247];   // #3A88F7
const BG_BOT = [33, 99, 222];    // #2163DE
const TOP = [255, 255, 255];     // brightest cube face
const LEFT = [211, 224, 244];    // #D3E0F4
const RIGHT = [183, 201, 233];   // #B7C9E9

const cx = BIG / 2;
const cy = BIG * 0.50;
const L = BIG * 0.30;            // cube scale
const RAD = BIG * 0.18;          // background corner radius

const P = (x, y) => [cx + x * L, cy + y * L];
// 2:1 isometric cube — three visible faces sharing the centre vertex (0,0).
const topFace = [P(0, -1), P(0.866, -0.5), P(0, 0), P(-0.866, -0.5)];
const rightFace = [P(0.866, -0.5), P(0.866, 0.5), P(0, 1), P(0, 0)];
const leftFace = [P(-0.866, -0.5), P(0, 0), P(0, 1), P(-0.866, 0.5)];

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y) {
  const minx = RAD, maxx = BIG - RAD, miny = RAD, maxy = BIG - RAD;
  let dx = 0, dy = 0;
  if (x < minx) dx = minx - x; else if (x > maxx) dx = x - maxx;
  if (y < miny) dy = miny - y; else if (y > maxy) dy = y - maxy;
  return dx === 0 && dy === 0 ? true : dx * dx + dy * dy <= RAD * RAD;
}

// Accumulate opaque colour + coverage per output pixel for clean AA.
const sumR = new Float64Array(S * S);
const sumG = new Float64Array(S * S);
const sumB = new Float64Array(S * S);
const cnt = new Float64Array(S * S);

for (let by = 0; by < BIG; by++) {
  for (let bx = 0; bx < BIG; bx++) {
    const px = bx + 0.5, py = by + 0.5;
    if (!inRoundRect(px, py)) continue;
    let col;
    if (inPoly(px, py, topFace)) col = TOP;
    else if (inPoly(px, py, rightFace)) col = RIGHT;
    else if (inPoly(px, py, leftFace)) col = LEFT;
    else {
      const t = by / BIG;
      col = [
        BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t,
        BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t,
        BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t
      ];
    }
    const idx = (by >> 2) * S + (bx >> 2);
    sumR[idx] += col[0]; sumG[idx] += col[1]; sumB[idx] += col[2]; cnt[idx] += 1;
  }
}

const buf = Buffer.alloc(S * S * 4);
const N = SS * SS;
for (let i = 0; i < S * S; i++) {
  const c = cnt[i];
  if (c > 0) {
    buf[i * 4] = Math.round(sumR[i] / c);
    buf[i * 4 + 1] = Math.round(sumG[i] / c);
    buf[i * 4 + 2] = Math.round(sumB[i] / c);
  }
  buf[i * 4 + 3] = Math.round((c / N) * 255);
}

// ---- minimal PNG encoder (RGBA) ----
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log('Wrote', out, '(' + png.length + ' bytes,', S + 'x' + S + ')');
