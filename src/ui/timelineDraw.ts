// Timeline painting. Draws only what is visible, so cost depends on the view, not the project size.
import type { Gesture } from '../core/editor/gestures.ts';
import { rows, tickAt, visibleRange, xOf, type Metrics } from '../core/editor/layout.ts';
import { clipEnd, getMedia, sourceTimeAt, type Clip, type MediaAsset } from '../core/model.ts';
import { formatTimecode, TICKS_PER_SECOND, type Tick } from '../core/time.ts';
import { peakRange, type Peaks } from '../media/peaks.ts';
import { color, type } from '../theme/theme.ts';
import type { App } from './app.ts';

const RULER_STEPS = [1 / 30, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 600, 1800, 3600];
const KIND_COLOR: Record<Clip['kind'], string> = { video: color.clipVideo, audio: color.clipAudio, text: color.clipText, adjust: color.clipAdjust, caption: color.clipCaption };
const THUMB_PAD = 14;
const DETAIL_MIN_PX = 24;
/** Clips narrower than this merge with touching neighbours when painted. */
const MERGE_BELOW_PX = 6;

interface Block {
  fill: string;
  alpha: number;
  x: number;
  w: number;
  h: number;
  merged: boolean;
}

export class TimelinePainter {
  private readonly app: App;
  private readonly m: Metrics;
  private readonly redraw: () => void;
  private readonly peaks = new Map<string, Peaks | 'pending'>();

  constructor(app: App, metrics: Metrics, redraw: () => void) {
    this.app = app;
    this.m = metrics;
    this.redraw = redraw;
  }

  private peaksFor(asset: MediaAsset): Peaks | null {
    const hit = this.peaks.get(asset.fingerprint);
    if (hit) return hit === 'pending' ? null : hit;
    const spec = this.app.spec(asset);
    if (!spec) return null;
    this.peaks.set(asset.fingerprint, 'pending');
    this.app.jobs.peaks(asset.fingerprint, spec).then(
      (p) => {
        this.peaks.set(asset.fingerprint, p);
        this.redraw();
      },
      () => this.peaks.delete(asset.fingerprint),
    );
    return null;
  }

  /** Where a clip's block sits on screen. */
  private box(c: Clip, y: number, w: number): { x0: number; left: number; width: number; top: number; h: number } {
    const x0 = xOf(c.start, this.app.session.view);
    const left = Math.max(x0, -2);
    const right = Math.min(xOf(clipEnd(c), this.app.session.view), w + 2);
    return { x0, left, width: Math.max(1, right - left - 1), top: y + 2, h: this.m.trackHeight - 4 };
  }

  /** Thumbnails, waveform and name for a clip wide enough to show them. */
  private detail(ctx: CanvasRenderingContext2D, c: Clip, y: number, w: number): void {
    const s = this.app.session;
    const { x0, left, width, top, h } = this.box(c, y, w);
    const right = left + width + 1;
    const asset = getMedia(s.project, c.mediaId);
    const spec = asset && this.app.spec(asset);
    ctx.globalAlpha = c.enabled ? 1 : 0.4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, Math.max(0, right - left - 1), h);
    ctx.clip();
    if (asset && spec && c.kind === 'video' && asset.kind === 'video' && asset.video) {
      const th = h - THUMB_PAD;
      const turned = asset.video.rotation === 90 || asset.video.rotation === 270;
      const tw = Math.max(8, Math.round((th * (turned ? asset.video.height : asset.video.width)) / (turned ? asset.video.width : asset.video.height)));
      // Tiles sit on a grid anchored to the clip start so they do not swim while scrolling.
      for (let tx = x0 + Math.floor((left - x0) / tw) * tw; tx < right; tx += tw) {
        const src = sourceTimeAt(c, tickAt(Math.max(tx, x0), s.view));
        const bmp = this.app.jobs.thumbNow(asset.fingerprint, src, th);
        if (bmp) ctx.drawImage(bmp, tx, top + THUMB_PAD, tw, th);
        else void this.app.jobs.thumb(asset.fingerprint, spec, src, th).then(this.redraw, () => undefined);
      }
    }
    if (asset && c.kind === 'audio') {
      const p = this.peaksFor(asset);
      if (p) {
        ctx.fillStyle = color.text;
        ctx.globalAlpha = c.enabled ? 0.7 : 0.3;
        const mid = top + h / 2 + THUMB_PAD / 2;
        const half = (h - THUMB_PAD) / 2;
        const bucketAt = (x: number): number => (sourceTimeAt(c, tickAt(x, s.view)) / TICKS_PER_SECOND) * p.rate;
        for (let x = Math.floor(left); x < right; x++) {
          const [b0, b1] = [bucketAt(x), bucketAt(x + 1)];
          const r = peakRange(p, Math.min(b0, b1), Math.max(b0, b1));
          ctx.fillRect(x, mid - r.max * half, 1, Math.max(1, (r.max - r.min) * half));
        }
        ctx.globalAlpha = c.enabled ? 1 : 0.4;
      }
    }
    if (right - left > 30) {
      ctx.fillStyle = color.text;
      ctx.font = `${type.sm}px ${type.family}`;
      ctx.textBaseline = 'top';
      ctx.fillText(c.name || asset?.name || c.kind, Math.max(left, 0) + 4, top + 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private ruler(ctx: CanvasRenderingContext2D, w: number): void {
    const s = this.app.session;
    ctx.fillStyle = color.bg2;
    ctx.fillRect(0, 0, w, this.m.rulerHeight);
    const step = RULER_STEPS.find((v) => v * s.view.pxPerSecond >= 90) ?? 3600;
    ctx.fillStyle = color.textDim;
    ctx.strokeStyle = color.line;
    ctx.font = `${type.xs}px ${type.mono}`;
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    for (let t = Math.floor(s.view.scrollX / s.view.pxPerSecond / step) * step; (t * s.view.pxPerSecond - s.view.scrollX) < w; t += step) {
      const x = Math.round(t * s.view.pxPerSecond - s.view.scrollX) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, this.m.rulerHeight - 8);
      ctx.lineTo(x, this.m.rulerHeight);
      ctx.stroke();
      ctx.fillText(formatTimecode(Math.round(t * TICKS_PER_SECOND), s.seq.fps), x + 3, 3);
    }
  }

  private line(ctx: CanvasRenderingContext2D, tick: Tick, h: number, stroke: string, width = 1): void {
    const x = Math.round(xOf(tick, this.app.session.view)) + 0.5;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  /** Paint the whole clip area. Returns how many clips were drawn (for the performance test). */
  paint(ctx: CanvasRenderingContext2D, w: number, h: number, gesture: Gesture | null): number {
    const s = this.app.session;
    const seq = s.seq;
    ctx.fillStyle = color.bg0;
    ctx.fillRect(0, 0, w, h);
    let drawn = 0;
    const t0 = tickAt(0, s.view);
    const t1 = tickAt(w, s.view);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.m.rulerHeight, w, h - this.m.rulerHeight);
    ctx.clip();
    for (const row of rows(seq, this.m)) {
      const y = this.m.rulerHeight + row.y - s.view.scrollY;
      if (y > h || y + row.height < this.m.rulerHeight) continue;
      ctx.fillStyle = row.track.id === s.activeTrackId ? color.bg2 : color.bg1;
      ctx.fillRect(0, y, w, row.height - 1);
      const [from, to] = visibleRange(row.track, t0, t1);
      // Rectangles to fill, in order. Runs of very narrow neighbours with the same look merge into one,
      // so a zoomed-out track with a thousand cuts costs a few draw calls instead of thousands.
      const blocks: Block[] = [];
      const marks: Block[] = [];
      const push = (list: Block[], fill: string, alpha: number, x: number, bw: number, bh: number): void => {
        const last = list[list.length - 1];
        if (bw < MERGE_BELOW_PX && last?.merged && last.fill === fill && last.alpha === alpha && x - (last.x + last.w) < 1.5) last.w = x + bw - last.x;
        else list.push({ fill, alpha, x, w: bw, h: bh, merged: bw < MERGE_BELOW_PX });
      };
      const wide: Clip[] = [];
      const picked: Clip[] = [];
      for (let i = from; i < to; i++) {
        const c = row.track.clips[i] as Clip;
        const box = this.box(c, y, w);
        push(blocks, KIND_COLOR[c.kind], c.enabled ? 1 : 0.4, box.left, box.width, box.h);
        const asset = getMedia(s.project, c.mediaId);
        if (asset && !this.app.spec(asset)) push(marks, color.danger, 1, box.left, box.width, 3); // offline marker
        if (s.selection.has(c.id)) picked.push(c);
        if (box.width > DETAIL_MIN_PX) wide.push(c);
        drawn++;
      }
      const fillAll = (list: Block[]): void => {
        for (const r of list) {
          ctx.globalAlpha = r.alpha;
          ctx.fillStyle = r.fill;
          ctx.fillRect(r.x, y + 2, r.w, r.h);
        }
        ctx.globalAlpha = 1;
      };
      fillAll(blocks);
      for (const c of wide) this.detail(ctx, c, y, w);
      fillAll(marks);
      ctx.strokeStyle = color.select;
      ctx.lineWidth = 2;
      for (const c of picked) {
        const box = this.box(c, y, w);
        ctx.strokeRect(box.left + 1, box.top + 1, Math.max(1, box.width - 2), box.h - 2);
      }
      if (row.track.locked) {
        ctx.fillStyle = color.overlay;
        ctx.fillRect(0, y, w, row.height - 1);
      }
    }
    if (seq.inPoint !== null || seq.outPoint !== null) {
      const a = seq.inPoint !== null ? xOf(seq.inPoint, s.view) : 0;
      const b = seq.outPoint !== null ? xOf(seq.outPoint, s.view) : w;
      ctx.fillStyle = color.range;
      ctx.fillRect(a, this.m.rulerHeight, b - a, h);
    }
    ctx.restore();
    this.ruler(ctx, w);
    for (const mk of seq.markers) {
      const x = xOf(mk.time, s.view);
      if (x < -8 || x > w + 8) continue;
      ctx.fillStyle = color.marker;
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 10);
      ctx.fill();
    }
    if (gesture?.snapLine !== null && gesture?.snapLine !== undefined) this.line(ctx, gesture.snapLine, h, color.select, 2);
    this.line(ctx, s.playhead, h, color.accent, 1);
    if (gesture?.marquee) {
      const q = gesture.marquee;
      ctx.strokeStyle = color.select;
      ctx.lineWidth = 1;
      ctx.strokeRect(q.x0 + 0.5, q.y0 + 0.5, q.x1 - q.x0, q.y1 - q.y0);
    }
    return drawn;
  }
}
