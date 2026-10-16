#!/usr/bin/env node
/**
 * Generates build/icon.ico (a single 256x256 PNG-compressed entry) so the
 * desktop build ships with a real icon instead of the Electron default.
 * Pure Node: no image libraries involved.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SAMPLES = 3; // supersampling factor per axis

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'build');

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function over(dst, src) {
  const alpha = src[3];
  if (alpha <= 0) return dst;
  const out = [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = src[i] * alpha + dst[i] * (1 - alpha);
  out[3] = alpha + dst[3] * (1 - alpha);
  return out;
}

function roundedRectAlpha(x, y) {
  const radius = 56;
  const left = 8;
  const right = SIZE - 8;
  const top = 8;
  const bottom = SIZE - 8;
  if (x < left || x > right || y < top || y > bottom) return 0;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  const distance = Math.hypot(dx, dy);
  return distance <= radius ? 1 : distance <= radius + 1 ? radius + 1 - distance : 0;
}

/** Classic database cylinder: top ellipse, straight barrel, three ring arcs. */
function cylinderAlpha(x, y) {
  const cx = 128;
  const topY = 92;
  const bottomY = 168;
  const rx = 62;
  const ry = 25;
  const top = ((x - cx) / rx) ** 2 + ((y - topY) / ry) ** 2 <= 1;
  const bottom = ((x - cx) / rx) ** 2 + ((y - bottomY) / ry) ** 2 <= 1;
  const barrel = Math.abs(x - cx) <= rx && y >= topY && y <= bottomY;
  return top || bottom || barrel ? 1 : 0;
}

function ringShade(x, y) {
  const cx = 128;
  const rx = 62;
  const ry = 25;
  for (const ringY of [126, 158]) {
    if (y < ringY) continue;
    if (((x - cx) / rx) ** 2 + ((y - ringY) / ry) ** 2 <= 1) return true;
  }
  return false;
}

function renderPixels() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SAMPLES;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let pixel = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;
          const bgAlpha = roundedRectAlpha(x, y);
          if (bgAlpha <= 0) continue;

          const t = (x / SIZE + y / SIZE) / 2;
          const background = [
            lerp(0x4c, 0x25, t),
            lerp(0x8d, 0x63, t),
            lerp(0xff, 0xeb, t),
            bgAlpha,
          ];
          let layer = background;

          if (cylinderAlpha(x, y) > 0) {
            const shade = ringShade(x, y);
            layer = over(layer, shade ? [0xb9, 0xcf, 0xf7, bgAlpha] : [0xf7, 0xf9, 0xff, bgAlpha]);
          }
          pixel = [
            pixel[0] + layer[0],
            pixel[1] + layer[1],
            pixel[2] + layer[2],
            pixel[3] + layer[3],
          ];
        }
      }
      const total = SAMPLES * SAMPLES;
      const offset = (py * SIZE + px) * 4;
      const alphaSum = pixel[3];
      if (alphaSum <= 0) continue;
      rgba[offset] = Math.round(pixel[0] / alphaSum);
      rgba[offset + 1] = Math.round(pixel[1] / alphaSum);
      rgba[offset + 2] = Math.round(pixel[2] / alphaSum);
      rgba[offset + 3] = Math.round((alphaSum / total) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolor + alpha
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const directory = Buffer.alloc(6);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // 1 = icon
  directory.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = 0; // 0 means 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  return Buffer.concat([directory, entry, png]);
}

const png = encodePng(renderPixels());
mkdirSync(outDir, { recursive: true });
const icoFile = resolve(outDir, 'icon.ico');
const pngFile = resolve(outDir, 'icon.png');
writeFileSync(icoFile, encodeIco(png));
writeFileSync(pngFile, png);
console.log(`icon written: ${icoFile} and ${pngFile}`);
