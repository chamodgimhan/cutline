// RGB to YUV for encoding. Done here, not by the encoder, because encoders given RGB pick their own
// matrix and range and do not always label the stream to match; this way the file says what it holds.

/**
 * RGBA (top row first) to I420, BT.709 limited range, chroma averaged over each 2x2 block.
 * Width and height must be even. Returns Y, then U, then V, tightly packed.
 */
export function rgbaToI420(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 1.5);
  const cw = width >> 1;
  const uAt = width * height;
  const vAt = uAt + cw * (height >> 1);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < 4; k++) {
        const px = x + (k & 1);
        const py = y + (k >> 1);
        const o = (py * width + px) * 4;
        const [R, G, B] = [rgba[o] as number, rgba[o + 1] as number, rgba[o + 2] as number];
        out[py * width + px] = Math.round(16 + ((0.2126 * R + 0.7152 * G + 0.0722 * B) * 219) / 255);
        r += R;
        g += G;
        b += B;
      }
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 4;
      const c = (y >> 1) * cw + (x >> 1);
      out[uAt + c] = Math.round(128 + (((b / 4 - luma) / 1.8556) * 224) / 255);
      out[vAt + c] = Math.round(128 + (((r / 4 - luma) / 1.5748) * 224) / 255);
    }
  }
  return out;
}
