// Phase 3 page-side checks: compositor output, fallback, scrub budget.
import { makeClip, makeProject, makeSequence, makeTrack } from '../../../src/core/model.ts';
import { frameToTick, TICKS_PER_SECOND } from '../../../src/core/time.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { hashBytes } from '../../../src/media/bytes.ts';
import { readCounter } from '../../fixtures/frame.ts';
import { RENDER_FPS, renderProject } from '../../fixtures/renderProject.ts';
import { makeEngine, psnr } from './setup.ts';

export interface RenderResult { frame: number; hash: string; half: string; counter: number; fallbackPsnr: number; size: number }

/** Render the fixture project at fixed frames with GL (full and half size) and with the 2D fallback. */
export async function renderCheck(frames: number[]): Promise<{ backend: string; fallback: string; results: RenderResult[] }> {
  const eng = await makeEngine(['clip_24', 'rotated', 'clip_60']);
  const project = renderProject(eng.assets);
  const gl = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const flat = new Renderer(new OffscreenCanvas(1, 1), eng.media, true);
  const results: RenderResult[] = [];
  for (const frame of frames) {
    const tick = frameToTick(frame, { num: RENDER_FPS, den: 1 });
    await gl.renderFrame(project, tick);
    const px = gl.readPixels();
    await gl.renderFrame(project, tick, 0.5);
    const half = gl.readPixels();
    await flat.renderFrame(project, tick);
    results.push({
      frame, hash: hashBytes(px), half: hashBytes(half), size: px.length + half.length,
      counter: readCounter(640, (x, y) => (px[(y * 640 + x) * 4] as number) > 128),
      fallbackPsnr: psnr(px, flat.readPixels()),
    });
  }
  const out = { backend: gl.compositor.backend, fallback: flat.compositor.backend, results };
  gl.dispose();
  flat.dispose();
  eng.media.dispose();
  return out;
}

/** Offline media renders as a flat placeholder instead of failing. Returns the centre pixel. */
export async function offlinePixel(): Promise<number[]> {
  const eng = await makeEngine(['clip_24', 'rotated', 'clip_60']);
  const project = renderProject(eng.assets);
  eng.library.detach('clip_24');
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  await r.renderFrame(project, frameToTick(22, { num: RENDER_FPS, den: 1 }));
  const px = r.readPixels();
  const at = (300 * 640 + 20) * 4;
  r.dispose();
  eng.media.dispose();
  return [px[at] as number, px[at + 1] as number, px[at + 2] as number];
}

/** Time from asking for a frame to having it drawn, for random positions in a 1080p sequence. */
export async function scrub(frames: number[]): Promise<{ ms: number[]; counters: number[] }> {
  const eng = await makeEngine(['hd_1080']);
  const seq = makeSequence('seq', { width: 1920, height: 1080, fps: { num: 30, den: 1 } });
  const track = makeTrack('V1', 'video', 'V1');
  track.clips = [makeClip({ id: 'c', kind: 'video', mediaId: 'hd_1080', start: 0, duration: 2 * TICKS_PER_SECOND })];
  seq.tracks = [track];
  const project = makeProject(seq);
  project.media = eng.assets;
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  await r.renderFrame(project, 0); // warm up: open the file, compile shaders
  const ms: number[] = [];
  const counters: number[] = [];
  for (const f of frames) {
    const t0 = performance.now();
    await r.renderFrame(project, frameToTick(f, seq.fps));
    ms.push(performance.now() - t0);
    const px = r.readPixels();
    counters.push(readCounter(1920, (x, y) => (px[(y * 1920 + x) * 4] as number) > 128));
  }
  r.dispose();
  eng.media.dispose();
  return { ms, counters };
}
