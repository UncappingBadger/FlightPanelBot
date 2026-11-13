// Draws the green "OPEN" rubber stamp shown on a flight that still needs a pilot.
//
//   node scripts/make-stamp.mjs              writes src/discord/openStampImage.ts
//   node scripts/make-stamp.mjs --preview f  also writes a copy on a dark background (to look at it)
//
// Everything is drawn here, with no image tools: heavy block letters inside a double border, tilted a little, then
// worn like real ink (uneven patches and tiny specks missing). The picture is written into a source file (as text), so it
// travels inside the bot and is attached to the panel's messages; it only needs drawing again to change how it looks.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const previewPath = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : null;

const W = 256;
const H = 176;
const TILT = (-8 * Math.PI) / 180;
const INK = [46, 204, 113];
const SAMPLES = 4;

/* ------------------------------------------------------------------ shapes (in the untilted picture, pixel units) */

const box = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/** Inside a rounded rectangle. */
function rounded(x, y, x0, y0, x1, y1, r) {
  if (!box(x, y, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Inside a polygon (even-odd). */
function polygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A rounded ring: inside the outer rectangle and not inside the one inset by the stroke. */
const ring = (x, y, x0, y0, x1, y1, r, t) => rounded(x, y, x0, y0, x1, y1, r) && !rounded(x, y, x0 + t, y0 + t, x1 - t, y1 - t, Math.max(r - t, 3));

// The four letters, each in its own box. `t` is the stroke.
const T = 14;
const LET_Y0 = 54;
const LET_Y1 = 124;
const LET_W = 36;
const GAP = 9;
const LET_X0 = (W - (4 * LET_W + 3 * GAP)) / 2;
const at = (i) => LET_X0 + i * (LET_W + GAP);

const letters = [
  // O
  (x, y) => ring(x, y, at(0), LET_Y0, at(0) + LET_W, LET_Y1, 15, T),
  // P
  (x, y) =>
    box(x, y, at(1), LET_Y0, at(1) + T, LET_Y1) ||
    ring(x, y, at(1), LET_Y0, at(1) + LET_W, LET_Y0 + (LET_Y1 - LET_Y0) * 0.62, 15, T),
  // E
  (x, y) =>
    box(x, y, at(2), LET_Y0, at(2) + T, LET_Y1) ||
    box(x, y, at(2), LET_Y0, at(2) + LET_W, LET_Y0 + T - 1) ||
    box(x, y, at(2), (LET_Y0 + LET_Y1) / 2 - (T - 2) / 2, at(2) + LET_W * 0.86, (LET_Y0 + LET_Y1) / 2 + (T - 2) / 2) ||
    box(x, y, at(2), LET_Y1 - T + 1, at(2) + LET_W, LET_Y1),
  // N
  (x, y) =>
    box(x, y, at(3), LET_Y0, at(3) + T, LET_Y1) ||
    box(x, y, at(3) + LET_W - T, LET_Y0, at(3) + LET_W, LET_Y1) ||
    polygon(x, y, [
      [at(3), LET_Y0],
      [at(3) + T + 3, LET_Y0],
      [at(3) + LET_W, LET_Y1],
      [at(3) + LET_W - T - 3, LET_Y1],
    ]),
];

/** Whether a point of the untilted picture is ink: the double border, a pair of small stars between border and letters, or a letter. */
function isInk(x, y) {
  if (ring(x, y, 16, 18, W - 16, H - 18, 22, 9)) return true; // heavy outer border
  if (ring(x, y, 31, 33, W - 31, H - 33, 12, 3)) return true; // thin inner border
  for (const l of letters) if (l(x, y)) return true;
  return false;
}

/* ------------------------------------------------------------------ wear: uneven ink and missing specks */

/** A repeatable random number in [0, 1) for a point of a grid. */
function hash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise: random values at grid points, blended between them. */
function noise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How much ink actually reaches the paper at a point: 1 is full, 0 is a bare patch. */
function wear(x, y) {
  const patches = 0.62 * noise(x / 16, y / 16, 11) + 0.38 * noise(x / 5.5, y / 5.5, 23);
  const uneven = smooth(0.15, 0.27, patches); // worn patches
  const specks = hash(Math.floor(x / 1.2), Math.floor(y / 1.2), 5) < 0.03 ? 0 : 1; // tiny missing specks
  return Math.max(0.3, uneven) * specks * (0.9 + 0.1 * noise(x / 3, y / 3, 41));
}

/* ------------------------------------------------------------------ draw */

const rgba = Buffer.alloc(W * H * 4);
const cos = Math.cos(-TILT);
const sin = Math.sin(-TILT);
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    let covered = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const x = px + (sx + 0.5) / SAMPLES;
        const y = py + (sy + 0.5) / SAMPLES;
        // Back to the untilted picture.
        const dx = x - W / 2;
        const dy = y - H / 2;
        const u = W / 2 + dx * cos - dy * sin;
        const v = H / 2 + dx * sin + dy * cos;
        if (isInk(u, v)) covered++;
      }
    }
    const coverage = covered / (SAMPLES * SAMPLES);
    const o = (py * W + px) * 4;
    rgba[o] = INK[0];
    rgba[o + 1] = INK[1];
    rgba[o + 2] = INK[2];
    rgba[o + 3] = Math.round(255 * coverage * (coverage > 0 ? wear(px, py) : 0));
  }
}

/* ------------------------------------------------------------------ PNG */

function encodePng(width, height, pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = join(root, 'src', 'discord', 'openStampImage.ts');
const png = encodePng(W, H, rgba);
writeFileSync(
  out,
  `// Written by scripts/make-stamp.mjs: the green OPEN stamp, as a PNG picture in base64. Do not edit by hand.
export const OPEN_STAMP_PNG_BASE64 =
  '${png.toString('base64')}';
`,
);
console.log(`Wrote ${out} (${W}x${H} picture, ${png.length} bytes)`);

if (previewPath) {
  // The same stamp on the dark grey of a Discord card, scaled up 2x so the wear can be seen.
  const bg = [43, 45, 49];
  const S = 2;
  const prev = Buffer.alloc(W * S * H * S * 4);
  for (let y = 0; y < H * S; y++) {
    for (let x = 0; x < W * S; x++) {
      const i = (Math.floor(y / S) * W + Math.floor(x / S)) * 4;
      const a = rgba[i + 3] / 255;
      const o = (y * W * S + x) * 4;
      for (let c = 0; c < 3; c++) prev[o + c] = Math.round(bg[c] * (1 - a) + rgba[i + c] * a);
      prev[o + 3] = 255;
    }
  }
  writeFileSync(resolve(previewPath), encodePng(W * S, H * S, prev));
  console.log(`Wrote the preview ${resolve(previewPath)}`);
}
