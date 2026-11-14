// Canvas 2D compositor, used only where WebGL2 is unavailable. Same plan and geometry.
// Limits of the fallback: blend modes use the canvas's own operators; only exposure, contrast,
// saturation, blur and flip effects are drawn; adjustment clips are skipped; every transition
// is shown as a cross dissolve.
import { effectValue } from '../../core/effects.ts';
import type { BlendMode } from '../../core/model.ts';
import type { FramePlan, LayerPlan } from '../../core/render/plan.ts';
import { OFFLINE_RGB, sizeOf, type Compositor, type LayerImages } from './gl.ts';

const OPERATION: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'lighter', darken: 'darken', lighten: 'lighten', difference: 'difference',
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function filterFor(layer: LayerPlan): { filter: string; flipX: boolean; flipY: boolean } {
  const parts: string[] = [];
  let flipX = false;
  let flipY = false;
  for (const e of layer.clip.effects) {
    if (!e.enabled) continue;
    const v = (k: string): number => effectValue(e, k, layer.localTime);
    if (e.type === 'exposure') parts.push(`brightness(${2 ** v('stops')})`);
    else if (e.type === 'contrast') parts.push(`contrast(${1 + v('amount')})`);
    else if (e.type === 'saturation') parts.push(`saturate(${v('amount')})`);
    else if (e.type === 'blur') parts.push(`blur(${v('radius') / 2}px)`);
    else if (e.type === 'flip') {
      flipX = flipX !== v('horizontal') > 0.5;
      flipY = flipY !== v('vertical') > 0.5;
    }
  }
  return { filter: parts.join(' ') || 'none', flipX, flipY };
}

export class Canvas2dCompositor implements Compositor {
  readonly backend = 'canvas2d' as const;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: Ctx;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as Ctx | null;
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  private draw(layer: LayerPlan, images: LayerImages, k: number, opacity: number): void {
    if (layer.kind === 'adjust') return;
    const image = images.get(layer) ?? null;
    if (!image && layer.kind === 'text') return;
    const ctx = this.ctx;
    const [a, b, c, d, e, f] = layer.matrix;
    ctx.save();
    ctx.setTransform(a * k, b * k, c * k, d * k, e * k, f * k); // unit square -> output pixels
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = OPERATION[layer.blend];
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.clip();
    if (!image) {
      ctx.fillStyle = `rgb(${OFFLINE_RGB.join(',')})`;
      ctx.fillRect(0, 0, 1, 1);
    } else {
      // The whole upright picture in unit coordinates; the unit square is its visible (cropped) part.
      const [u0, v0, u1, v1] = layer.uv;
      const fw = 1 / (u1 - u0);
      const fh = 1 / (v1 - v0);
      const fx = filterFor(layer);
      ctx.filter = fx.filter;
      ctx.translate(-u0 * fw + fw / 2, -v0 * fh + fh / 2);
      ctx.scale(fx.flipX ? -1 : 1, fx.flipY ? -1 : 1);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      const swap = layer.rotation === 90 || layer.rotation === 270;
      const [bw, bh] = swap ? [fh, fw] : [fw, fh];
      const [sw, sh] = sizeOf(image);
      ctx.drawImage(image as CanvasImageSource, 0, 0, sw, sh, -bw / 2, -bh / 2, bw, bh);
    }
    ctx.restore();
  }

  render(plan: FramePlan, images: LayerImages, scale: number): void {
    const { canvas, ctx } = this;
    const w = Math.max(1, Math.round(plan.width * scale));
    const h = Math.max(1, Math.round(plan.height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const k = w / plan.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    for (const layer of plan.layers) {
      const tr = layer.transition;
      if (!tr) this.draw(layer, images, k, layer.opacity);
      else if (tr.incoming) {
        if (tr.outgoing) this.draw(tr.outgoing, images, k, tr.outgoing.opacity);
        this.draw(layer, images, k, layer.opacity * tr.progress);
      } else this.draw(layer, images, k, layer.opacity * (1 - tr.progress));
    }
  }

  readPixels(): Uint8Array {
    const d = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  }

  dispose(): void {
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
