// Draws the Cutline app icon (original artwork: two clip blocks parted by a slanted cut line) and
// writes desktop/icon.png (512 px) and desktop/icon.ico (256 px).   node tools/icon.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { color, parseHex } from '../src/theme/theme.ts';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop');

/** RGBA pixels of the icon at `size`, drawn with 4x4 supersampling for smooth edges. */
export function drawIcon(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const rgb = (hex: string): number[] => parseHex(hex).slice(0, 3).map((v) => v * 255);
  const [bg, left, right, cut] = [rgb(color.bg1), rgb(color.clipVideo), rgb(color.clipAudio), rgb(color.accent)];
  const SS = 4;
  /** Colour and coverage at a point in 0..1 coordinates. */
  const sample = (x: number, y: number): number[] | null => {
    // Rounded square background.
    const r = 0.2;
    const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
    if (dx * dx + dy * dy > r * r) return null;
    // The cut: a slanted amber line through the middle; blocks stop short of it on both sides.
    const d = x - 0.5 + (y - 0.5) * 0.28;
    if (Math.abs(d) < 0.03 && y > 0.14 && y < 0.86) return cut;
    const inBand = y > 0.3 && y < 0.7;
    if (inBand && d < -0.075 && x > 0.13) return left;
    if (inBand && d > 0.075 && x < 0.87) return right;
    return bg;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!c) continue;
          for (let k = 0; k < 3; k++) acc[k] = (acc[k] as number) + (c[k] as number);
          acc[3] = (acc[3] as number) + 1;
        }
      }
      const o = (y * size + x) * 4;
      const n = acc[3] as number;
      for (let k = 0; k < 3; k++) px[o + k] = n ? Math.round((acc[k] as number) / n) : 0;
      px[o + 3] = Math.round((n / (SS * SS)) * 255);
    }
  }
  return px;
}

export function encodePng(rgba: Uint8Array, size: number): Uint8Array {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A Windows .ico holding one PNG image. */
export function encodeIco(png: Uint8Array, size: number): Uint8Array {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = size >= 256 ? 0 : size;
  head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.png'), encodePng(drawIcon(512), 512));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(encodePng(drawIcon(256), 256), 256));
  console.log('icon: wrote desktop/icon.png and desktop/icon.ico');
}
