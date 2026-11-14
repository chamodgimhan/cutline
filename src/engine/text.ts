// Titles and captions: bundled fonts and drawing a text block onto a canvas the size of the frame.
import type { TextProps } from '../core/model.ts';

/** Font families shipped with the app (latin, weights 400 and 700). Licences are in assets/fonts. */
export const FONTS = ['Roboto', 'Roboto Slab', 'Roboto Mono'] as const;

const FILES: [string, number, URL][] = [
  ['Roboto', 400, new URL('../../assets/fonts/roboto-latin-400-normal.woff2', import.meta.url)],
  ['Roboto', 700, new URL('../../assets/fonts/roboto-latin-700-normal.woff2', import.meta.url)],
  ['Roboto Slab', 400, new URL('../../assets/fonts/roboto-slab-latin-400-normal.woff2', import.meta.url)],
  ['Roboto Slab', 700, new URL('../../assets/fonts/roboto-slab-latin-700-normal.woff2', import.meta.url)],
  ['Roboto Mono', 400, new URL('../../assets/fonts/roboto-mono-latin-400-normal.woff2', import.meta.url)],
  ['Roboto Mono', 700, new URL('../../assets/fonts/roboto-mono-latin-700-normal.woff2', import.meta.url)],
];

let loading: Promise<void> | null = null;

/** Load the bundled fonts once (works on the main thread and in workers). Text drawn before this would use a system font. */
export function loadFonts(): Promise<void> {
  loading ??= Promise.all(
    FILES.map(async ([family, weight, url]) => {
      const face = new FontFace(family, `url(${url.href})`, { weight: String(weight) });
      await face.load();
      // The font set lives on the document in a window and on the global scope in a worker.
      (typeof document !== 'undefined' ? document.fonts : (globalThis as unknown as { fonts: FontFaceSet }).fonts).add(face);
    }),
  ).then(() => undefined);
  return loading;
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** Break text into lines that fit `maxWidth`. Markup tags (<i>, <b>, <v Name>) are not drawn. */
function wrap(ctx: Ctx, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/<[^>]+>/g, '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

const cache = new Map<string, OffscreenCanvas>();

/**
 * Draw a text block on a transparent canvas covering the whole frame (width x height sequence
 * pixels, drawn at `scale`). The block is placed by alignment inside the safe margins.
 */
export function drawText(t: TextProps, width: number, height: number, scale: number): OffscreenCanvas {
  const key = JSON.stringify([t, width, height, scale]);
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = canvas.getContext('2d') as Ctx;
  ctx.scale(canvas.width / width, canvas.height / height);
  ctx.font = `${t.weight} ${t.size}px "${t.font}", sans-serif`;
  ctx.textBaseline = 'middle';
  const mx = t.margin * width;
  const my = t.margin * height;
  const pad = t.boxPadding;
  const lines = wrap(ctx, t.text, Math.max(10, width - 2 * mx - 2 * pad));
  const lineHeight = t.size * 1.25;
  const blockW = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  const blockH = lines.length * lineHeight;
  const left = t.align === 'left' ? mx + pad : t.align === 'right' ? width - mx - pad - blockW : (width - blockW) / 2;
  const top = t.valign === 'top' ? my + pad : t.valign === 'bottom' ? height - my - pad - blockH : (height - blockH) / 2;
  ctx.fillStyle = t.boxColor;
  ctx.fillRect(left - pad, top - pad, blockW + 2 * pad, blockH + 2 * pad);
  ctx.textAlign = t.align;
  const x = t.align === 'left' ? left : t.align === 'right' ? left + blockW : left + blockW / 2;
  lines.forEach((line, i) => {
    const y = top + (i + 0.5) * lineHeight;
    ctx.shadowColor = t.shadowColor;
    ctx.shadowBlur = t.shadowBlur * scale;
    ctx.shadowOffsetX = t.shadowX * scale;
    ctx.shadowOffsetY = t.shadowY * scale;
    if (t.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = t.strokeColor;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent'; // the shadow belongs to the outline, not to the fill on top of it
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, x, y);
  });
  if (cache.size >= 24) cache.delete(cache.keys().next().value as string);
  cache.set(key, canvas);
  return canvas;
}
