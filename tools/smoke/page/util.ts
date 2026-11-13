// Page-side helpers shared by smoke suites.
import { drawRotated } from '../../../src/engine/draw2d.ts';
import { hashBytes } from '../../../src/media/bytes.ts';
import { readCounter } from '../../fixtures/frame.ts';

/** A fixture file chosen into the page's file input by the runner. */
export function file(name: string): File {
  const input = document.getElementById('files') as HTMLInputElement;
  const f = [...(input.files ?? [])].find((x) => x.name === name || x.name === name + '.mp4');
  if (!f) throw new Error(`fixture ${name} not loaded into the page`);
  return f;
}

/** Visible pixels as packed I420 (Y, U, V), whatever layout the decoder produced. */
export async function i420(frame: VideoFrame): Promise<Uint8Array> {
  const raw = new Uint8Array(frame.allocationSize());
  await frame.copyTo(raw);
  if (frame.format === 'I420') return raw;
  if (frame.format !== 'NV12') throw new Error('unexpected pixel format ' + frame.format);
  const ySize = frame.displayWidth * frame.displayHeight;
  const cSize = ySize / 4;
  const out = new Uint8Array(ySize + 2 * cSize);
  out.set(raw.subarray(0, ySize));
  for (let i = 0; i < cSize; i++) {
    out[ySize + i] = raw[ySize + 2 * i] as number;
    out[ySize + cSize + i] = raw[ySize + 2 * i + 1] as number;
  }
  return out;
}

export const frameHash = async (frame: VideoFrame): Promise<string> => hashBytes(await i420(frame));

/** Burned-in counter read from the luma plane (stored orientation). */
export async function counterOf(frame: VideoFrame): Promise<number> {
  const w = frame.displayWidth;
  const y = await i420(frame);
  return readCounter(w, (px, py) => (y[py * w + px] as number) > 128);
}

/**
 * Draw the frame the way a viewer sees it (rotation applied) and read the counter from
 * those pixels. Returns the displayed size too.
 */
export function displayedCounter(frame: VideoFrame, rotation: number): { counter: number; width: number; height: number } {
  const sw = frame.displayWidth;
  const sh = frame.displayHeight;
  const swap = rotation === 90 || rotation === 270;
  const [dw, dh] = swap ? [sh, sw] : [sw, sh];
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  drawRotated(ctx, frame, sw, sh, rotation, dw, dh);
  const px = ctx.getImageData(0, 0, dw, dh).data;
  // Map a stored-orientation pixel to where it lands on screen.
  const at = (x: number, y: number): number => {
    const [dx, dy] = rotation === 90 ? [sh - 1 - y, x] : rotation === 180 ? [sw - 1 - x, sh - 1 - y] : rotation === 270 ? [y, sw - 1 - x] : [x, y];
    return px[(dy * dw + dx) * 4] as number;
  };
  return { counter: readCounter(sw, (x, y) => at(x, y) > 128), width: dw, height: dh };
}

export async function errorMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'NO ERROR';
  } catch (e) {
    return `${e instanceof Error ? e.name : 'thrown'}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
