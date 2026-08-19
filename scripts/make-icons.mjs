#!/usr/bin/env node
/**
 * Generates the PolStudio application icons into src-tauri/icons/.
 *
 *   node scripts/make-icons.mjs          # write the icons
 *   node scripts/make-icons.mjs --check  # decode what is on disk and print it as ASCII
 *
 * There is no image toolchain in this repo (no ImageMagick, no canvas), so the
 * bitmaps are rasterised here by hand and encoded straight into PNG/BMP/ICO/ICNS
 * containers. Keeping the icons generated rather than checked in as opaque blobs
 * is the point: the mark can be re-tuned by editing the geometry below and
 * re-running, and `--check` decodes the real files back so a regression is
 * visible in the terminal instead of only in a taskbar.
 *
 * The mark is the film ticket from the in-app logo (src/components/PolStudioLogo.tsx):
 * a blue plate with a column of four perforations punched clean through it and a
 * heavy white letter. Every size carries a single "P" — "PolS" is four letters in
 * the space that fits one, and at 16px it was an illegible smudge.
 *
 * The perforations are transparent, not white, at every size. They are 2x2 at
 * 16px and grow from there, always with at least 2px of plate to their left, so
 * a hole reads as a hole rather than as a nibbled edge; and the whole point of
 * the mark is that light passes through the film.
 */

import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

/* ---------------------------------------------------------------- geometry */

/** Gradient stops of .pol-logo__ticket: linear-gradient(145deg, ...). */
const PLATE_STOPS = [
  [0.0, [0x08, 0x78, 0xf5]],
  [0.48, [0x07, 0x5b, 0xe3]],
  [1.0, [0x15, 0x3b, 0xc5]],
];

/**
 * Layout for one canvas size, in pixel units.
 *
 * Small canvases are snapped to whole pixels: a 2px-wide perforation that
 * starts at x=1.84 is two columns of grey, and grey is how "PolS" became a
 * smudge in the first place.
 */
function layout(size) {
  const r = Math.round;

  // Full-bleed at icon sizes, a hair of inset once there are pixels to spare.
  const margin = size >= 48 ? r(size * 0.04) : 0;
  const D = size - 2 * margin;
  const plate = { x0: margin, y0: margin, x1: margin + D, y1: margin + D, r: D * 0.2 };

  // The letter, in heavy grotesque proportions keyed off its cap height.
  const Ph = r(D * 0.72);
  const t = Math.max(1, r(Ph * 0.19));
  const Pw = r(Ph * 0.66);
  const Bh = r(Ph * 0.58);

  // Four perforations down the left, wider than tall like the CSS ones, and
  // spanning the same height as the letter beside them.
  const perfH = Math.max(1, r(Ph * 0.17));
  const perfGap = Math.max(1, r(Ph * 0.09));
  const perfW = Math.max(1, r(perfH * 1.1));
  const perfSpan = 4 * perfH + 3 * perfGap;

  // Perforations + letter are one group, centred in the plate as a unit; a
  // letter centred on its own leaves the mark visibly shoved to the right.
  const inner = Math.max(1, r(D * 0.1));
  const gx = margin + r((D - (perfW + inner + Pw)) / 2);
  const cy = margin + D / 2;

  // Every edge but the plate's corners and the bowl's curve lands on a pixel
  // boundary. A 2px-wide perforation that starts at x=1.84 is two columns of
  // grey, and grey is how "PolS" became a smudge in the first place.
  return {
    size,
    margin,
    D,
    plate,
    perf: { x: gx, y: r(cy - perfSpan / 2), w: perfW, h: perfH, gap: perfGap, r: perfW >= 5 ? 1 : 0 },
    p: { x: gx + perfW + inner, y: r(cy - Ph / 2), w: Pw, h: Ph, t, bowl: Bh },
  };
}

/** Inside-test for a rectangle with per-corner radii. */
function inRoundRect(x, y, x0, y0, x1, y1, rtl, rtr, rbr, rbl) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const corner = (cx, cy, r) => {
    if (r <= 0) return true;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
  if (x < x0 + rtl && y < y0 + rtl) return corner(x0 + rtl, y0 + rtl, rtl);
  if (x > x1 - rtr && y < y0 + rtr) return corner(x1 - rtr, y0 + rtr, rtr);
  if (x > x1 - rbr && y > y1 - rbr) return corner(x1 - rbr, y1 - rbr, rbr);
  if (x < x0 + rbl && y > y1 - rbl) return corner(x0 + rbl, y1 - rbl, rbl);
  return true;
}

function inPlate(L, x, y) {
  const { x0, y0, x1, y1, r } = L.plate;
  return inRoundRect(x, y, x0, y0, x1, y1, r, r, r, r);
}

/**
 * The four perforations. These are holes, not ink: the plate is punched out
 * there and the alpha channel carries it, so whatever the icon sits on shows
 * through — the same thing the in-app logo's mask does.
 */
function inPerf(L, x, y) {
  const { perf } = L;
  for (let i = 0; i < 4; i++) {
    const y0 = perf.y + i * (perf.h + perf.gap);
    if (inRoundRect(x, y, perf.x, y0, perf.x + perf.w, y0 + perf.h, perf.r, perf.r, perf.r, perf.r)) return true;
  }
  return false;
}

/** The white ink: the letter P. */
function inLetter(L, x, y) {
  const { p } = L;

  // Stem.
  if (x >= p.x && x <= p.x + p.t && y >= p.y && y <= p.y + p.h) return true;

  // Bowl: a D-shape minus its counter, both rounded only on the right.
  const rOut = Math.min(p.bowl / 2, p.w * 0.55);
  const outer = inRoundRect(x, y, p.x, p.y, p.x + p.w, p.y + p.bowl, 0, rOut, rOut, 0);
  if (!outer) return false;
  const ix0 = p.x + p.t;
  const iy0 = p.y + p.t;
  const ix1 = p.x + p.w - p.t;
  const iy1 = p.y + p.bowl - p.t;
  if (ix1 <= ix0 || iy1 <= iy0) return true;
  const rIn = Math.max(0, Math.min((iy1 - iy0) / 2, rOut - p.t));
  return !inRoundRect(x, y, ix0, iy0, ix1, iy1, 0, rIn, rIn, 0);
}

function plateColor(L, x, y) {
  // linear-gradient(145deg, ...): axis points down-and-right.
  const ax = Math.sin((145 * Math.PI) / 180);
  const ay = -Math.cos((145 * Math.PI) / 180);
  const { x0, y0, x1, y1 } = L.plate;
  const proj = (px, py) => px * ax + py * ay;
  const lo = Math.min(proj(x0, y0), proj(x1, y0), proj(x0, y1), proj(x1, y1));
  const hi = Math.max(proj(x0, y0), proj(x1, y0), proj(x0, y1), proj(x1, y1));
  const t = Math.max(0, Math.min(1, (proj(x, y) - lo) / (hi - lo || 1)));
  for (let i = 1; i < PLATE_STOPS.length; i++) {
    const [t1, c1] = PLATE_STOPS[i];
    const [t0, c0] = PLATE_STOPS[i - 1];
    if (t <= t1 || i === PLATE_STOPS.length - 1) {
      const k = (t - t0) / (t1 - t0 || 1);
      const kk = Math.max(0, Math.min(1, k));
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * kk));
    }
  }
  return PLATE_STOPS[0][1];
}

const SS = 8; // supersampling factor per axis (64 samples/pixel)

/** Rasterise one square canvas to RGBA bytes. */
function render(size) {
  const L = layout(size);
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let solid = 0;
      let ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!inPlate(L, x, y)) continue;
          if (inPerf(L, x, y)) continue; // punched out: contributes to neither
          solid++;
          if (inLetter(L, x, y)) ink++;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (solid === 0) continue; // outside the plate, or entirely inside a hole
      const a = solid / n;
      const inkShare = ink / solid;
      const base = plateColor(L, px + 0.5, py + 0.5);
      for (let j = 0; j < 3; j++) out[i + j] = Math.round(base[j] + (255 - base[j]) * inkShare);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/* -------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Minimal decoder for the PNGs this script writes (8-bit RGBA, all filters). */
function decodePNG(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const stored = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== stored) throw new Error(`bad CRC on ${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error("expected 8-bit RGBA");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, rgba: out };
}

/* -------------------------------------------------------------------- BMP */

/** ICO-flavoured DIB: BITMAPINFOHEADER, bottom-up BGRA, then the 1bpp AND mask. */
function encodeDIB(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      xor[dst + x * 4 + 0] = rgba[src + x * 4 + 2];
      xor[dst + x * 4 + 1] = rgba[src + x * 4 + 1];
      xor[dst + x * 4 + 2] = rgba[src + x * 4 + 0];
      xor[dst + x * 4 + 3] = rgba[src + x * 4 + 3];
      if (rgba[src + x * 4 + 3] < 128) mask[(size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([header, xor, mask]);
}

function decodeDIB(buf) {
  const width = buf.readInt32LE(4);
  const height = buf.readInt32LE(8) / 2;
  const bpp = buf.readUInt16LE(14);
  if (bpp !== 32) throw new Error(`expected 32bpp DIB, got ${bpp}`);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = 40 + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      rgba[(y * width + x) * 4 + 0] = buf[src + x * 4 + 2];
      rgba[(y * width + x) * 4 + 1] = buf[src + x * 4 + 1];
      rgba[(y * width + x) * 4 + 2] = buf[src + x * 4 + 0];
      rgba[(y * width + x) * 4 + 3] = buf[src + x * 4 + 3];
    }
  }
  return { width, height, rgba };
}

/* -------------------------------------------------------------- ICO / ICNS */

/**
 * Vista and later read PNG entries at any size, but classic DIB entries are what
 * every shell has always understood, so the small sizes stay DIB and only the
 * two big ones use PNG (a 256x256 DIB alone is 270KB).
 */
function buildICO(images) {
  const entries = images.map(({ size, rgba }) => ({
    size,
    data: size >= 128 ? encodePNG(size, rgba) : encodeDIB(size, rgba),
  }));
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((entry, i) => {
    const o = 6 + i * 16;
    dir[o] = entry.size >= 256 ? 0 : entry.size;
    dir[o + 1] = entry.size >= 256 ? 0 : entry.size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(entry.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

const ICNS_TYPES = { 16: "icp4", 32: "icp5", 128: "ic07", 256: "ic08", 512: "ic09" };

function buildICNS(images) {
  const parts = [];
  for (const { size, rgba } of images) {
    const type = ICNS_TYPES[size];
    if (!type) continue;
    const png = encodePNG(size, rgba);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ------------------------------------------------------------------ ASCII */

const RAMP = ".:-=+*#%@";

/** Prints a decoded image as ASCII, ramped on the red channel: the plate is
 *  blue (r ~ 0x08-0x15) and the ink is white (r = 0xff), so red *is* the ink.
 *  A blank is transparent — outside the plate, or one of the four perforations
 *  punched through it, which is why the holes show as gaps in the column. */
function ascii({ width, height, rgba }) {
  const lines = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      if (a < 40) {
        line += " ";
        continue;
      }
      const ink = Math.max(0, Math.min(1, (rgba[i] - 0x18) / (0xff - 0x18)));
      line += RAMP[Math.min(RAMP.length - 1, Math.round(ink * (RAMP.length - 1)))];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * The alpha actually stored in a decoded image, at the centre of each
 * perforation and, for contrast, at the centre of the plate. Reading the
 * generator proves nothing about the bytes on disk; these numbers do. Holes
 * must read 0 and the plate 255.
 */
function alphaProbe({ width, rgba }) {
  const L = layout(width);
  const at = (x, y) => rgba[(Math.floor(y) * width + Math.floor(x)) * 4 + 3];
  const holes = [];
  for (let i = 0; i < 4; i++) {
    const cy = L.perf.y + i * (L.perf.h + L.perf.gap) + L.perf.h / 2;
    holes.push(at(L.perf.x + L.perf.w / 2, cy));
  }
  return `alpha: holes [${holes.join(", ")}], plate ${at(L.plate.x0 + L.D / 2, L.plate.y0 + L.D / 2)}`;
}

function parseICO(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO");
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const declared = buf[o] || 256;
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const data = buf.subarray(off, off + len);
    const isPNG = data.readUInt32BE(0) === 0x89504e47;
    const img = isPNG ? decodePNG(data) : decodeDIB(data);
    if (img.width !== declared || img.height !== declared) throw new Error(`entry ${declared} decodes to ${img.width}x${img.height}`);
    out.push({ declared, kind: isPNG ? "PNG" : "BMP", bytes: len, ...img });
  }
  return out;
}

/* ------------------------------------------------------------------- main */

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const PNG_FILES = { 32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png", 512: "icon.png" };

function parseICNS(buf) {
  if (buf.toString("ascii", 0, 4) !== "icns") throw new Error("not an ICNS");
  if (buf.readUInt32BE(4) !== buf.length) throw new Error("ICNS length header disagrees with the file");
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const type = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) throw new Error(`bad ICNS entry ${type}`);
    const img = decodePNG(buf.subarray(off + 8, off + len));
    out.push(`${type}=${img.width}x${img.height}`);
    off += len;
  }
  return out;
}

/**
 * Decodes what is actually on disk and prints it. The point is to look at the
 * icon rather than trust the generator: the old wordmark icon survived a whole
 * round of "fixing the logo" because nobody parsed the ICO back.
 */
function check() {
  const entries = parseICO(readFileSync(join(ICONS_DIR, "icon.ico")));
  console.log(`icon.ico entries: ${entries.map((e) => e.declared).join(",")}`);
  for (const e of entries) {
    console.log(`\n--- ${e.declared}x${e.declared} (${e.kind}, ${e.bytes} bytes) — ${alphaProbe(e)} ---`);
    console.log(ascii(e));
  }
  console.log(`\nicon.icns: ${parseICNS(readFileSync(join(ICONS_DIR, "icon.icns"))).join(" ")}`);
  for (const [size, name] of Object.entries(PNG_FILES)) {
    const img = decodePNG(readFileSync(join(ICONS_DIR, name)));
    if (img.width !== Number(size) || img.height !== Number(size)) throw new Error(`${name} is ${img.width}x${img.height}`);
    console.log(`${name}: ${img.width}x${img.height} RGBA — ${alphaProbe(img)}`);
  }
}

function main() {
  if (process.argv.includes("--check")) {
    check();
    return;
  }

  mkdirSync(ICONS_DIR, { recursive: true });
  const images = SIZES.map((size) => ({ size, rgba: render(size) }));
  const written = [];
  const write = (name, data) => {
    writeFileSync(join(ICONS_DIR, name), data);
    written.push(`${name} (${data.length} bytes)`);
  };

  write("icon.ico", buildICO(images.filter((i) => i.size <= 256)));
  write("icon.icns", buildICNS(images));
  for (const { size, rgba } of images) {
    if (PNG_FILES[size]) write(PNG_FILES[size], encodePNG(size, rgba));
  }
  console.log(written.join("\n"));
}

main();
