// Canvas 2D compositor, used only where WebGL2 is unavailable. Same plan, same
// geometry; blend modes use the canvas's own operators, so pixels differ slightly from GL.
import type { BlendMode } from '../../core/model.ts';
import type { FramePlan } from '../../core/render/plan.ts';
import { OFFLINE_RGB, type Compositor, type LayerImage } from './gl.ts';

const OPERATION: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'lighter', darken: 'darken', lighten: 'lighten', difference: 'difference',
};

const sizeOf = (image: TexImageSource): [number, number] => {
  const i = image as { displayWidth?: number; displayHeight?: number; width?: number; height?: number };
  return [i.displayWidth ?? i.width ?? 1, i.displayHeight ?? i.height ?? 1];
};

export class Canvas2dCompositor implements Compositor {
  readonly backend = 'canvas2d' as const;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  render(plan: FramePlan, images: readonly LayerImage[], scale: number): void {
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
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    plan.layers.forEach((layer, i) => {
      if (layer.kind !== 'media') return;
      const image = images[i] ?? null;
      const [a, b, c, d, e, f] = layer.matrix;
      ctx.save();
      ctx.setTransform(a * k, b * k, c * k, d * k, e * k, f * k); // unit square -> output pixels
      ctx.globalAlpha = layer.opacity;
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
        ctx.translate(-u0 * fw + fw / 2, -v0 * fh + fh / 2);
        ctx.rotate((layer.rotation * Math.PI) / 180);
        const swap = layer.rotation === 90 || layer.rotation === 270;
        const [bw, bh] = swap ? [fh, fw] : [fw, fh];
        const [sw, sh] = sizeOf(image);
        ctx.drawImage(image as CanvasImageSource, 0, 0, sw, sh, -bw / 2, -bh / 2, bw, bh);
      }
      ctx.restore();
    });
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
