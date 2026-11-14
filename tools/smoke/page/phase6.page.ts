// Phase 6 page-side checks: every effect and transition rendered at fixed settings, stack order, speed sync.
import { setClipSpeed } from '../../../src/core/commands/clips.ts';
import { addEffect, EFFECTS, makeEffect, VIDEO_TRANSITIONS, withTransition } from '../../../src/core/effects.ts';
import { makeClip, makeProject, makeSequence, makeTrack, sequenceEnd, type Clip, type Effect, type Project } from '../../../src/core/model.ts';
import { planFrame } from '../../../src/core/render/plan.ts';
import { frameToTick, TICKS_PER_SECOND as S } from '../../../src/core/time.ts';
import { renderAudio } from '../../../src/engine/audioRender.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { hashBytes } from '../../../src/media/bytes.ts';
import { makeEngine, psnr, type TestEngine } from './setup.ts';

const W = 320;
const H = 180;
const FPS = { num: 24, den: 1 };

function videoProject(eng: TestEngine, tracks: Clip[][]): Project {
  const seq = makeSequence('seq', { width: W, height: H, fps: FPS });
  seq.tracks = tracks.map((clips, i) => ({ ...makeTrack(`V${i + 1}`, 'video', `V${i + 1}`), clips }));
  const p = makeProject(seq);
  p.media = eng.assets;
  return p;
}
const vclip = (id: string, mediaId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip =>
  makeClip({ id, kind: 'video', mediaId, start: Math.round(start * S), duration: Math.round(duration * S), ...extra });
const fx = (type: string, params: Record<string, number | string>): Effect => ({ ...makeEffect(type, 'fx-' + type), params: { ...makeEffect(type, 'x').params, ...params } });

/** Simple measurements of an RGBA frame. */
function stats(px: Uint8Array): { mean: [number, number, number]; detail: number; grey: number; lumaSpread: number } {
  const mean: [number, number, number] = [0, 0, 0];
  let detail = 0;
  let grey = 0;
  let sum = 0;
  let sq = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i] as number, px[i + 1] as number, px[i + 2] as number];
    mean[0] += r / n;
    mean[1] += g / n;
    mean[2] += b / n;
    grey += (Math.abs(r - g) + Math.abs(g - b)) / n;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    sq += y * y;
    if ((i / 4) % W !== 0) detail += Math.abs(g - (px[i - 3] as number)) / n;
  }
  return { mean, detail, grey, lumaSpread: Math.sqrt(sq / n - (sum / n) ** 2) };
}
const at = (px: Uint8Array, x: number, y: number): number[] => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
const INVERT_CUBE = 'LUT_3D_SIZE 2\n' + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`))).join('\n');

export const EFFECT_SETTINGS: Record<string, Record<string, number | string>> = {
  exposure: { stops: 1 }, contrast: { amount: 0.5 }, saturation: { amount: 0 }, temperature: { temp: 1, tint: 0 }, curves: { p2: 0.75 },
  lut: { cube: INVERT_CUBE, mix: 1 }, blur: { radius: 6 }, sharpen: { amount: 1 }, vignette: { amount: 1, size: 0.6 },
  chromaKey: { color: '#000000', tolerance: 0.3, softness: 0.1 }, flip: { horizontal: 1, vertical: 0 },
};

export async function effects(): Promise<Record<string, unknown>> {
  const eng = await makeEngine(['clip_24']);
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const tick = frameToTick(12, FPS);
  const render = async (p: Project): Promise<Uint8Array> => {
    await r.renderFrame(p, tick);
    return r.readPixels();
  };
  const base = await render(videoProject(eng, [[vclip('a', 'clip_24', 0, 2)]]));
  const baseStats = stats(base);
  const out: Record<string, unknown> = { types: EFFECTS.map((e) => e.type), base: hashBytes(base), baseStats };
  const frames: Record<string, Uint8Array> = {};
  for (const def of EFFECTS) {
    const settings = EFFECT_SETTINGS[def.type] as Record<string, number | string>;
    // The chroma key test keys out the colour of the top-left quadrant, sampled from the plain frame.
    if (def.type === 'chromaKey') settings.color = '#' + at(base, 150, 60).map((v) => v.toString(16).padStart(2, '0')).join('');
    const px = await render(videoProject(eng, [[addEffect(vclip('a', 'clip_24', 0, 2), fx(def.type, settings))]]));
    frames[def.type] = px;
    out[def.type] = { hash: hashBytes(px), stats: stats(px), changed: psnr(px, base) < 60 };
  }
  // Specific expectations per effect.
  const mirrored = new Uint8Array(base.length);
  const inverted = new Uint8Array(base.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) mirrored[(y * W + x) * 4 + c] = base[(y * W + (W - 1 - x)) * 4 + c] as number;
  for (let i = 0; i < base.length; i++) inverted[i] = i % 4 === 3 ? 255 : 255 - (base[i] as number);
  out.flipPsnr = psnr(frames.flip as Uint8Array, mirrored);
  out.lutPsnr = psnr(frames.lut as Uint8Array, inverted);
  out.keyedPixel = at(frames.chromaKey as Uint8Array, 150, 60);
  out.keptPixel = [at(frames.chromaKey as Uint8Array, 250, 150), at(base, 250, 150)];
  out.vignetteProbe = [at(frames.vignette as Uint8Array, 160, 100), at(base, 160, 100), at(frames.vignette as Uint8Array, 316, 176), at(base, 316, 176)];
  // Disabled effects do nothing.
  const off = await render(videoProject(eng, [[addEffect(vclip('a', 'clip_24', 0, 2), { ...fx('exposure', { stops: 2 }), enabled: false })]]));
  out.disabledSame = hashBytes(off) === out.base;
  // Stack order changes the result.
  const sat = fx('saturation', { amount: 0 });
  const temp = fx('temperature', { temp: 1 });
  const ab = await render(videoProject(eng, [[addEffect(addEffect(vclip('a', 'clip_24', 0, 2), sat), temp)]]));
  const ba = await render(videoProject(eng, [[addEffect(addEffect(vclip('a', 'clip_24', 0, 2), temp), sat)]]));
  out.order = { ab: hashBytes(ab), ba: hashBytes(ba), abGrey: stats(ab).grey, baGrey: stats(ba).grey };
  // An adjustment clip above applies its effects to what is beneath it.
  const adjust = makeClip({ id: 'adj', kind: 'adjust', start: 0, duration: 2 * S, effects: [fx('exposure', { stops: 1 })] });
  const viaAdjust = await render(videoProject(eng, [[vclip('a', 'clip_24', 0, 2)], [adjust]]));
  out.adjustPsnr = psnr(viaAdjust, frames.exposure as Uint8Array);
  out.adjustHash = hashBytes(viaAdjust);
  const emptyAdjust = await render(videoProject(eng, [[vclip('a', 'clip_24', 0, 2)], [{ ...adjust, effects: [] }]]));
  out.emptyAdjustSame = hashBytes(emptyAdjust) === out.base;
  // The 2D fallback draws the effects it supports.
  const flat = new Renderer(new OffscreenCanvas(1, 1), eng.media, true);
  await flat.renderFrame(videoProject(eng, [[addEffect(vclip('a', 'clip_24', 0, 2), fx('flip', { horizontal: 1 }))]]), tick);
  out.fallbackFlipPsnr = psnr(flat.readPixels(), mirrored);
  flat.dispose();
  r.dispose();
  eng.media.dispose();
  return out;
}

export async function transitions(): Promise<Record<string, unknown>> {
  const eng = await makeEngine(['clip_24', 'clip_60']);
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const render = async (p: Project, seconds: number): Promise<Uint8Array> => {
    await r.renderFrame(p, Math.round(seconds * S));
    return r.readPixels();
  };
  // a (0..1 s) then b (1..2 s); the transition runs over the first half second of b.
  const make = (type: string | null): Project =>
    videoProject(eng, [[vclip('a', 'clip_24', 0, 1), withTransition(vclip('b', 'clip_60', 1, 1, { sourceIn: S / 2 }), 'in', type, S / 2)]]);
  const plain = make(null);
  const A = await render(videoProject(eng, [[vclip('a', 'clip_24', 0, 2)]]), 1.25); // a running on into its handle
  const B = await render(plain, 1.25);
  const out: Record<string, unknown> = {};
  for (const type of VIDEO_TRANSITIONS) {
    const q = await render(make(type), 1.125);
    const mid = await render(make(type), 1.25);
    out[type] = { hashes: [hashBytes(q), hashBytes(mid)], mid: stats(mid).mean, left: psnr(mid.subarray(0, W * 4 * 10), B.subarray(0, W * 4 * 10)) };
    if (type === 'dissolve') {
      const mix = new Uint8Array(A.length);
      for (let i = 0; i < A.length; i++) mix[i] = Math.round(((A[i] as number) + (B[i] as number)) / 2);
      out.dissolvePsnr = psnr(mid, mix);
    }
    if (type === 'wipe') out.wipeCheck = [psnr(mid, B) < 40, JSON.stringify(at(mid, 40, 120)) === JSON.stringify(at(B, 40, 120)), JSON.stringify(at(mid, 280, 120)) === JSON.stringify(at(A, 280, 120))];
    if (type === 'slide') out.slideCheck = [JSON.stringify(at(mid, 40, 120)) === JSON.stringify(at(A, 40, 120)), JSON.stringify(at(mid, 200, 120)) === JSON.stringify(at(B, 40, 120))];
  }
  out.afterEqualsPlain = hashBytes(await render(make('wipe'), 1.75)) === hashBytes(await render(plain, 1.75));
  // Fade out to nothing at the end of a clip, over the layer beneath.
  const fade = videoProject(eng, [[vclip('under', 'clip_60', 0, 2)], [withTransition(vclip('top', 'clip_24', 0, 1), 'out', 'dissolve', S / 2)]]);
  const under = await render(videoProject(eng, [[vclip('under', 'clip_60', 0, 2)]]), 0.75);
  const top = await render(videoProject(eng, [[vclip('top', 'clip_24', 0, 1)]]), 0.75);
  const half = new Uint8Array(under.length);
  for (let i = 0; i < under.length; i++) half[i] = Math.round(((under[i] as number) + (top[i] as number)) / 2);
  out.fadeOutPsnr = psnr(await render(fade, 0.75), half);
  r.dispose();
  eng.media.dispose();
  return out;
}

/** After a speed change, every click in the mix still sits where the picture shows a whole source second. */
export async function speedSync(speed: [number, number], reverse: boolean, pitchKeep: boolean): Promise<{ clicks: number; worstMs: number; seconds: number }> {
  const eng = await makeEngine(['long_2h']);
  const seq = makeSequence('seq', { width: 64, height: 48, fps: FPS, sampleRate: 48000 });
  const base = { mediaId: 'long_2h', start: 0, duration: 12 * S, sourceIn: 300 * S, linkId: 'L' };
  seq.tracks = [{ ...makeTrack('V1', 'video', 'V1'), clips: [makeClip({ ...base, id: 'v', kind: 'video' })] }, { ...makeTrack('A1', 'audio', 'A1'), clips: [makeClip({ ...base, id: 'a', kind: 'audio' })] }];
  let p = makeProject(seq);
  p.media = eng.assets;
  p = setClipSpeed(p, { newId: () => 'n' }, { id: 'v', speed: { num: speed[0], den: speed[1] }, reverse, pitchKeep }).apply(p);
  const end = sequenceEnd(p.sequences[0]!);
  const [left] = await renderAudio(p, { start: 0, end }, eng.media);
  let clicks = 0;
  let worst = 0;
  const floor = pitchKeep ? 0.3 : 0.45;
  for (let n = 200; n < left.length - 200; n++) {
    const x = Math.abs(left[n] as number);
    if (x < floor) continue;
    let peak = n;
    for (let k = n; k < n + 400 && k < left.length; k++) if (Math.abs(left[k] as number) > Math.abs(left[peak] as number)) peak = k;
    const layer = planFrame(p, Math.round((peak * S) / 48000)).layers[0];
    if (layer) {
      const off = (layer.sourceTime / S) % 1;
      worst = Math.max(worst, Math.min(off, 1 - off) * 1000);
      clicks++;
    }
    n = peak + 2000;
  }
  eng.media.dispose();
  return { clicks, worstMs: worst, seconds: end / S };
}
