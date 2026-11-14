// renderFrame: the single path from a project and a time to pixels. Preview and export both use it.
import { getMedia, type Id, type Project, type TextProps } from '../core/model.ts';
import { pictureLayers, planFrame, type LayerPlan, type View } from '../core/render/plan.ts';
import type { Tick } from '../core/time.ts';
import { Canvas2dCompositor } from './compositor/canvas2d.ts';
import { GlCompositor, type Compositor, type LayerImage } from './compositor/gl.ts';
import type { MediaSources } from './mediaSources.ts';
import { drawText, loadFonts } from './text.ts';

export type PreviewScale = 1 | 0.5 | 0.25;

export class Renderer {
  readonly compositor: Compositor;
  private readonly media: MediaSources;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, media: MediaSources, forceCanvas2d = false) {
    this.media = media;
    let c: Compositor | null = null;
    if (!forceCanvas2d) {
      try {
        c = new GlCompositor(canvas);
      } catch {
        c = null; // no WebGL2 on this machine: fall back
      }
    }
    this.compositor = c ?? new Canvas2dCompositor(canvas);
  }

  private async image(project: Project, layer: LayerPlan): Promise<{ image: LayerImage; close?: () => void }> {
    const asset = getMedia(project, layer.mediaId);
    if (!asset) return { image: null };
    try {
      if (asset.kind === 'image') return { image: (await this.media.image(asset)) ?? null };
      const video = await this.media.video(asset);
      if (!video) return { image: null };
      const frame = await video.frameAt(layer.sourceTime);
      return { image: frame, close: () => frame.close() };
    } catch {
      return { image: null }; // unreadable media draws as offline; the project stays usable
    }
  }

  /**
   * Draw the sequence at `tick` onto the canvas. `scale` is output pixels per sequence pixel (preview quality,
   * or the export size); `view` is the output shape when it differs from the sequence's.
   */
  async renderFrame(project: Project, tick: Tick, scale = 1, seqId?: Id, view?: View): Promise<void> {
    const plan = planFrame(project, tick, seqId, view);
    const all = pictureLayers(plan);
    const layers = all.filter((l) => l.kind === 'media');
    const titles = all.filter((l) => l.kind === 'text' && l.clip.text);
    if (titles.length) await loadFonts();
    const loaded = await Promise.all(layers.map((l) => this.image(project, l)));
    try {
      const images = new Map<LayerPlan, LayerImage>(layers.map((l, i) => [l, (loaded[i] as { image: LayerImage }).image]));
      for (const l of titles) images.set(l, drawText(l.clip.text as TextProps, plan.width, plan.height, scale));
      this.compositor.render(plan, images, scale);
    } finally {
      for (const l of loaded) l.close?.();
    }
  }

  /** RGBA pixels of the last rendered frame, top row first. */
  readPixels(): Uint8Array {
    return this.compositor.readPixels();
  }

  dispose(): void {
    this.compositor.dispose();
  }
}
