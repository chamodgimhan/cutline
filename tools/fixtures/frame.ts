// Deterministic test picture: static gradient with tinted quadrants, a moving
// bar, and a burned-in frame counter. Also the reader that recovers the counter.
import type { Yuv420 } from './h264pcm.ts';

// 5x7 digit glyphs, one string per row.
const FONT: readonly (readonly string[])[] = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
];

export const COUNTER_DIGITS = 6;

export interface CounterLayout {
  scale: number;
  originX: number;
  originY: number;
  /** Horizontal distance between digit origins. */
  pitch: number;
}

export function counterLayout(width: number): CounterLayout {
  const scale = Math.max(1, Math.floor(width / 80));
  return { scale, originX: 2 * scale, originY: 2 * scale, pitch: 6 * scale };
}

const Y_BLACK = 16;
const Y_WHITE = 235;
const Y_BAR = 200;

function digitLit(digit: number, cx: number, cy: number): boolean {
  return FONT[digit]?.[cy]?.[cx] === '1';
}

/** Draw frame `n` of a width x height picture into coded-size planes (padding replicated). */
export function drawFrame(width: number, height: number, n: number): Yuv420 {
  const cw = Math.ceil(width / 16) * 16;
  const ch = Math.ceil(height / 16) * 16;
  const y = new Uint8Array(cw * ch);
  const u = new Uint8Array((cw / 2) * (ch / 2));
  const v = new Uint8Array((cw / 2) * (ch / 2));
  const L = counterLayout(width);
  const s = L.scale;
  const digits = String(n % 10 ** COUNTER_DIGITS).padStart(COUNTER_DIGITS, '0');
  const boxW = L.originX + COUNTER_DIGITS * L.pitch + s;
  const boxH = L.originY + 7 * s + 2 * s;
  const barW = Math.max(2, 2 * s);
  const barX = (n * barW) % width;

  for (let py = 0; py < ch; py++) {
    const sy = Math.min(py, height - 1);
    for (let px = 0; px < cw; px++) {
      const sx = Math.min(px, width - 1);
      let val = 40 + Math.floor((sx * 120) / width);
      if (sy >= height / 2 && sx >= barX && sx < barX + barW) val = Y_BAR;
      if (sx < boxW && sy < boxH) {
        val = Y_BLACK;
        const dx = sx - L.originX;
        const dy = sy - L.originY;
        if (dx >= 0 && dy >= 0 && dy < 7 * s) {
          const d = Math.floor(dx / L.pitch);
          const cx = Math.floor((dx % L.pitch) / s);
          if (d < COUNTER_DIGITS && cx < 5 && digitLit(digits.charCodeAt(d) - 48, cx, Math.floor(dy / s))) val = Y_WHITE;
        }
      }
      y[py * cw + px] = val;
    }
  }
  for (let py = 0; py < ch / 2; py++) {
    const top = Math.min(py * 2, height - 1) < height / 2;
    for (let px = 0; px < cw / 2; px++) {
      const left = Math.min(px * 2, width - 1) < width / 2;
      const o = py * (cw / 2) + px;
      u[o] = top ? (left ? 100 : 160) : left ? 110 : 150;
      v[o] = top ? (left ? 160 : 100) : left ? 110 : 150;
    }
  }
  return { width: cw, height: ch, y, u, v };
}

/** Visible (cropped) I420 bytes of a coded frame: Y then U then V, tightly packed. */
export function visibleI420(f: Yuv420, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height + 2 * (width / 2) * (height / 2));
  let o = 0;
  for (let r = 0; r < height; r++) {
    out.set(f.y.subarray(r * f.width, r * f.width + width), o);
    o += width;
  }
  for (const p of [f.u, f.v]) {
    for (let r = 0; r < height / 2; r++) {
      out.set(p.subarray(r * (f.width / 2), r * (f.width / 2) + width / 2), o);
      o += width / 2;
    }
  }
  return out;
}

/**
 * Read the burned-in counter. `bright(x, y)` reports whether the pixel is
 * closer to white than black. Returns -1 when the digits are unreadable.
 */
export function readCounter(width: number, bright: (x: number, y: number) => boolean): number {
  const L = counterLayout(width);
  const s = L.scale;
  let value = 0;
  for (let d = 0; d < COUNTER_DIGITS; d++) {
    let found = -1;
    for (let digit = 0; digit < 10 && found < 0; digit++) {
      let ok = true;
      for (let cy = 0; cy < 7 && ok; cy++) {
        for (let cx = 0; cx < 5 && ok; cx++) {
          const px = L.originX + d * L.pitch + cx * s + (s >> 1);
          const py = L.originY + cy * s + (s >> 1);
          if (bright(px, py) !== digitLit(digit, cx, cy)) ok = false;
        }
      }
      if (ok) found = digit;
    }
    if (found < 0) return -1;
    value = value * 10 + found;
  }
  return value;
}
