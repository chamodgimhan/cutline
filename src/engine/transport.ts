// Playback transport. The audio context is the master clock: audio is scheduled in
// chunks and the picture follows the time of the audio being played. A slow or
// dropped video frame can therefore never move the audio.
import { getSequence, sequenceEnd, type Project } from '../core/model.ts';
import { frameTicks, snapToFrame, TICKS_PER_SECOND, type Tick } from '../core/time.ts';
import { renderAudio } from './audioRender.ts';
import type { MediaSources } from './mediaSources.ts';
import type { PreviewScale, Renderer } from './renderer.ts';

/** Wall-clock length of one scheduled audio chunk, and how far ahead audio is kept scheduled. */
const CHUNK_SECONDS = 0.4;
const AHEAD_SECONDS = 1.0;
export const SHUTTLE_SPEEDS = [1, 2, 4, 8];

interface Segment {
  ctxStart: number;
  ctxEnd: number;
  tickStart: Tick;
  tickEnd: Tick;
}

export interface TransportOptions {
  getProject: () => Project;
  renderer: Renderer;
  media: MediaSources;
}

export class Transport {
  private readonly o: TransportOptions;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private segments: Segment[] = [];
  private nodes = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private position: Tick = 0;
  private rateNow = 0;
  private nextTick: Tick = 0;
  private scheduledUntil = 0;
  private endCtx = Infinity;
  private pumping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private rendering = false;
  private renderAgain = false;
  private shown: Tick = -1;
  private wanted: Tick = -1;
  private readonly listeners = new Set<() => void>();
  loop = false;
  quality: PreviewScale = 1;
  /** Frames drawn and frames skipped because the previous one was still rendering. */
  stats = { presented: 0, dropped: 0 };
  /** Called after each frame is drawn during playback, with the audio-clock time it was drawn at. */
  onPresent: ((contextTime: number, frameTick: Tick) => void) | null = null;

  constructor(options: TransportOptions) {
    this.o = options;
  }

  private get seq() {
    return getSequence(this.o.getProject());
  }

  /** Master output; meters and the destination hang off this. Created on first use. */
  audio(): { context: AudioContext; output: GainNode } {
    if (!this.ctx || this.ctx.sampleRate !== this.seq.sampleRate) {
      void this.ctx?.close();
      this.ctx = new AudioContext({ sampleRate: this.seq.sampleRate, latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return { context: this.ctx, output: this.master as GainNode };
  }

  get playing(): boolean {
    return this.rateNow !== 0;
  }
  get rate(): number {
    return this.rateNow;
  }

  /** Timeline position of the audio at audio-context time `t`. */
  tickAt(t: number): Tick {
    let last: Segment | undefined;
    for (const s of this.segments) {
      if (t < s.ctxStart) break;
      last = s;
      if (t < s.ctxEnd) return Math.round(s.tickStart + ((t - s.ctxStart) / (s.ctxEnd - s.ctxStart)) * (s.tickEnd - s.tickStart));
    }
    return last ? last.tickEnd : this.position;
  }

  /** Current position: the audio being heard while playing, the parked position otherwise. */
  get playhead(): Tick {
    if (!this.playing || !this.ctx) return this.position;
    return this.tickAt(this.ctx.currentTime - (this.ctx.outputLatency || 0));
  }

  private bounds(): [Tick, Tick] {
    const seq = this.seq;
    const end = sequenceEnd(seq);
    if (!this.loop) return [0, end];
    const a = seq.inPoint ?? 0;
    const b = seq.outPoint ?? end;
    return b > a ? [a, b] : [0, end];
  }

  /** Start playing at `rate` (negative = reverse). Rates other than 1 play audio faster, like tape. */
  play(rate = 1): void {
    if (rate === 0) return this.pause();
    const from = this.playhead;
    this.stopAudio();
    const [lo, hi] = this.bounds();
    // Starting at the end (or the start, in reverse) restarts from the other side.
    this.position = rate > 0 ? (from >= hi || from < lo ? lo : from) : from <= lo || from > hi ? hi : from;
    this.rateNow = rate;
    const { context } = this.audio();
    void context.resume();
    this.nextTick = this.position;
    this.scheduledUntil = context.currentTime + 0.12;
    this.endCtx = Infinity;
    this.segments = [];
    this.timer = setInterval(() => void this.pump(), 50);
    void this.pump();
    this.startFrames();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.position = snapToFrame(this.playhead, this.seq.fps, 'floor');
    this.rateNow = 0;
    this.stopAudio();
    this.requestFrame();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play(1);
  }

  /** J/K/L: -1 steps reverse speed up (or slows forward), 0 stops, 1 steps forward speed up. */
  shuttle(direction: -1 | 0 | 1): void {
    if (direction === 0) return this.pause();
    const speed = Math.abs(this.rateNow);
    const same = Math.sign(this.rateNow) === direction;
    const next = same ? (SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.indexOf(speed) + 1] ?? speed) : 1;
    this.play(direction * next);
  }

  seek(tick: Tick): void {
    const t = Math.max(0, tick);
    if (this.playing) {
      const rate = this.rateNow;
      this.stopAudio();
      this.rateNow = 0;
      this.position = t;
      this.play(rate);
    } else {
      this.position = t;
      this.requestFrame();
      this.emit();
    }
  }

  /** Step by whole frames from the current frame; pauses first. */
  step(frames: number): void {
    this.pause();
    const fps = this.seq.fps;
    this.seek(Math.max(0, snapToFrame(this.position, fps, 'floor') + frames * frameTicks(fps)));
  }

  private stopAudio(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // not started yet
      }
      n.disconnect();
    }
    this.nodes.clear();
    this.segments = [];
  }

  /** Keep audio scheduled ahead of the clock. One chunk at a time; a seek or pause abandons it. */
  private async pump(): Promise<void> {
    if (this.pumping || !this.playing || !this.ctx) return;
    this.pumping = true;
    const gen = this.generation;
    const ctx = this.ctx;
    try {
      while (this.playing && gen === this.generation && this.endCtx === Infinity && this.scheduledUntil < ctx.currentTime + AHEAD_SECONDS) {
        const dir = Math.sign(this.rateNow);
        const speed = Math.abs(this.rateNow);
        const [lo, hi] = this.bounds();
        if ((dir > 0 && this.nextTick >= hi) || (dir < 0 && this.nextTick <= lo)) {
          if (!this.loop || hi <= lo) {
            this.endCtx = this.scheduledUntil;
            break;
          }
          this.nextTick = dir > 0 ? lo : hi;
        }
        const span = Math.round(CHUNK_SECONDS * speed * TICKS_PER_SECOND);
        const to = dir > 0 ? Math.min(hi, this.nextTick + span) : Math.max(lo, this.nextTick - span);
        const [a, b] = dir > 0 ? [this.nextTick, to] : [to, this.nextTick];
        const [left, right] = await renderAudio(this.o.getProject(), { start: a, end: b }, this.o.media);
        if (gen !== this.generation) return;
        const seconds = left.length / ctx.sampleRate / speed;
        // If rendering fell behind, start late rather than in the past; the clock follows the audio.
        const when = Math.max(this.scheduledUntil, ctx.currentTime + 0.02);
        if (left.length > 0) {
          const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
          buffer.copyToChannel((dir < 0 ? left.reverse() : left) as Float32Array<ArrayBuffer>, 0);
          buffer.copyToChannel((dir < 0 ? right.reverse() : right) as Float32Array<ArrayBuffer>, 1);
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          node.playbackRate.value = speed;
          node.connect(this.master as GainNode);
          node.onended = () => this.nodes.delete(node);
          node.start(when);
          this.nodes.add(node);
        }
        this.segments.push({ ctxStart: when, ctxEnd: when + seconds, tickStart: this.nextTick, tickEnd: to });
        while (this.segments.length > 64) this.segments.shift();
        this.scheduledUntil = when + seconds;
        this.nextTick = to;
      }
    } finally {
      this.pumping = false;
    }
  }

  private startFrames(): void {
    cancelAnimationFrame(this.raf);
    const loop = (): void => {
      if (!this.playing || !this.ctx) return;
      if (this.ctx.currentTime >= this.endCtx) {
        const [lo, hi] = this.bounds();
        this.position = this.rateNow > 0 ? hi : lo;
        this.rateNow = 0;
        this.stopAudio();
        this.requestFrame();
        this.emit();
        return;
      }
      this.requestFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Draw the frame under the playhead unless it is already shown. Never queues more than one. */
  private requestFrame(): void {
    const seq = this.seq;
    const end = Math.max(0, sequenceEnd(seq) - 1);
    const tick = snapToFrame(Math.min(this.playhead, end), seq.fps, 'floor');
    if (tick === this.shown && !this.renderAgain) return;
    if (this.rendering) {
      if (this.playing && tick !== this.wanted) this.stats.dropped++;
      this.wanted = tick;
      this.renderAgain = !this.playing;
      return;
    }
    this.rendering = true;
    this.renderAgain = false;
    this.wanted = tick;
    void this.o.renderer
      .renderFrame(this.o.getProject(), tick, this.quality)
      .catch(() => undefined)
      .then(() => {
        this.rendering = false;
        this.shown = tick;
        this.stats.presented++;
        if (this.playing && this.ctx) this.onPresent?.(this.ctx.currentTime, tick);
        this.emit();
        if (this.renderAgain) this.requestFrame();
      });
  }

  /** Redraw the current frame (the project or the preview quality changed). */
  refresh(): void {
    this.shown = -1;
    this.requestFrame();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  dispose(): void {
    this.rateNow = 0;
    this.stopAudio();
    cancelAnimationFrame(this.raf);
    void this.ctx?.close();
    this.ctx = null;
  }
}
