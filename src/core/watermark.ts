// The small mark put on exported pictures when the app has no valid licence key.

// 5x7 letters, one string per row.
const GLYPHS: Record<string, readonly string[]> = {
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
};
const WORD = 'CUTLINE';

/** Where the mark sits for a frame size: [x, y, width, height] in pixels. */
export function watermarkBox(width: number, height: number): [number, number, number, number] {
  const s = Math.max(1, Math.round(Math.min(width, height) / 270));
  const w = (WORD.length * 6 + 3) * s;
  const h = 11 * s;
  return [Math.max(0, width - w - 4 * s), Math.max(0, height - h - 4 * s), Math.min(w, width), Math.min(h, height)];
}

/** Draw the mark into an RGBA frame (top row first), bottom right: light letters on a darkened patch. */
export function stampWatermark(rgba: Uint8Array, width: number, height: number): void {
  const [bx, by, bw, bh] = watermarkBox(width, height);
  const s = Math.max(1, Math.round(Math.min(width, height) / 270));
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const col = Math.floor(x / s) - 2;
      const row = Math.floor(y / s) - 2;
      const letter = GLYPHS[WORD[Math.floor(col / 6)] ?? ''];
      const lit = col >= 0 && row >= 0 && row < 7 && col % 6 < 5 && letter?.[row]?.[col % 6] === '1';
      const o = ((by + y) * width + bx + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = lit ? Math.round((rgba[o + c] as number) * 0.25 + 255 * 0.75) : Math.round((rgba[o + c] as number) * 0.55);
    }
  }
}
