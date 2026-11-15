// Phase 3 page-side playback checks: audio mix, audio-clock sync, transport controls.
import { makeClip, makeProject, makeSequence, makeTrack, type Project } from '../../../src/core/model.ts';
import { frameTicks, frameToTick, TICKS_PER_SECOND as S, tickToFrame } from '../../../src/core/time.ts';
import { renderAudio } from '../../../src/engine/audioRender.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { Transport } from '../../../src/engine/transport.ts';
import { pcmBlock } from '../../fixtures/build.ts';
import { readCounter } from '../../fixtures/frame.ts';
import { makeEngine, type TestEngine } from './setup.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the condition holds (the first play also opens the audio file, so start-up time varies). */
async function until(ok: () => boolean, timeoutMs = 4000): Promise<boolean> {
  for (const t0 = performance.now(); performance.now() - t0 < timeoutMs; await sleep(20)) if (ok()) return true;
  return ok();
}

/** One video clip and its audio from a fixture, starting at zero. */
function simpleProject(eng: TestEngine, name: string, seconds: number, fps: number, width: number, height: number): Project {
  const seq = makeSequence('seq', { width, height, fps: { num: fps, den: 1 }, sampleRate: 48000 });
  const v = makeTrack('V1', 'video', 'V1');
  const a = makeTrack('A1', 'audio', 'A1');
  v.clips = [makeClip({ id: 'v', kind: 'video', mediaId: name, start: 0, duration: seconds * S, linkId: 'L' })];
  a.clips = [makeClip({ id: 'a', kind: 'audio', mediaId: name, start: 0, duration: seconds * S, linkId: 'L' })];
  seq.tracks = [v, a];
  const p = makeProject(seq);
  p.media = eng.assets;
  return p;
}

/** renderAudio against the generator's samples: exactness, chunking, offsets, mute and solo. */
export async function audioMix(): Promise<Record<string, number>> {
  const eng = await makeEngine(['clip_24']);
  const p = simpleProject(eng, 'clip_24', 2, 30, 320, 180);
  const want = new Int16Array(pcmBlock(48000, 2, 0, 96000).buffer);
  // Clip edges carry a 64-sample fade (the automatic edit crossfade), so exactness is checked away from them.
  const maxDiff = (got: Float32Array, ch: number, offset = 0, scale = 1, from = 0, to = got.length): number => {
    let m = 0;
    for (let i = from; i < to; i++) m = Math.max(m, Math.abs((got[i] as number) - (((want[(i + offset) * 2 + ch] as number) / 32768) * scale)));
    return m;
  };
  const whole = await renderAudio(p, { start: 0, end: 2 * S }, eng.media);
  const first = await renderAudio(p, { start: 0, end: (S * 7) / 10 }, eng.media);
  const second = await renderAudio(p, { start: (S * 7) / 10, end: 2 * S }, eng.media);
  // A second copy of the clip on another track, half a second in: the mix is the sum.
  const a2 = makeTrack('A2', 'audio', 'A2');
  a2.clips = [makeClip({ id: 'b', kind: 'audio', mediaId: 'clip_24', start: S / 2, duration: S, sourceIn: 0 })];
  const two: Project = { ...p, sequences: [{ ...p.sequences[0]!, tracks: [...p.sequences[0]!.tracks, a2] }] };
  const sum = await renderAudio(two, { start: S / 2, end: S }, eng.media);
  let sumDiff = 0;
  for (let i = 64; i < sum[0].length; i++) sumDiff = Math.max(sumDiff, Math.abs((sum[0][i] as number) - ((want[(i + 24000) * 2] as number) + (want[i * 2] as number)) / 32768));
  const withTrack = (change: (i: number) => object): Project => ({ ...two, sequences: [{ ...two.sequences[0]!, tracks: two.sequences[0]!.tracks.map((t, i) => ({ ...t, ...change(i) })) }] });
  const muted = await renderAudio(withTrack((i) => (i === 2 ? { muted: true } : {})), { start: S / 2, end: S }, eng.media);
  const solo = await renderAudio(withTrack((i) => (i === 2 ? { solo: true } : {})), { start: S / 2, end: S }, eng.media);
  eng.library.detach('clip_24');
  const offline = await renderAudio(p, { start: 0, end: S / 10 }, eng.media);
  eng.media.dispose();
  return {
    length: whole[0].length, left: maxDiff(whole[0], 0, 0, 1, 64, 96000 - 64), right: maxDiff(whole[1], 1, 0, 1, 64, 96000 - 64),
    chunkLeft: Math.max(maxDiff(first[0], 0, 0, 1, 64), maxDiff(second[0], 0, first[0].length, 1, 0, second[0].length - 64)), chunkLength: first[0].length + second[0].length,
    sum: sumDiff, muted: maxDiff(muted[0], 0, 24000), solo: maxDiff(solo[0], 0, 0, 1, 64),
    offline: offline[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0), empty: (await renderAudio(p, { start: S, end: S }, eng.media))[0].length,
  };
}

export interface SyncResult {
  seconds: number;
  presented: number;
  dropped: number;
  /** For each click heard: timeline position minus the whole second it belongs to, in milliseconds. */
  clickErrorMs: number[];
  /** For each frame drawn: how far the audio had moved past that frame's start when it appeared, in frames. */
  lagFrames: number[];
  counterOk: boolean;
  endSecond: number;
}

/**
 * Play the first `seconds` of the long fixture and compare three clocks: the audio actually
 * coming out (clicks heard through an analyser), the transport's timeline, and the frames drawn.
 */
export async function sync(seconds: number, fixture = 'long_2h', fps = 24, width = 64, height = 48, rate = 1): Promise<SyncResult> {
  const eng = await makeEngine([fixture]);
  const project = simpleProject(eng, fixture, Math.ceil(seconds * Math.abs(rate)) + 30, fps, width, height);
  const renderer = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const t = new Transport({ getProject: () => project, renderer, media: eng.media });
  const { context, output } = t.audio();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  output.connect(analyser);
  const buf = new Float32Array(2048);
  const clicks: number[] = [];
  let lastClick = -1;
  const poll = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const now = context.currentTime;
    let at = -1;
    for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i] as number) > 0.5 && (at < 0 || Math.abs(buf[i] as number) > Math.abs(buf[at] as number))) at = i;
    if (at < 0) return;
    const when = now - (buf.length - at) / context.sampleRate;
    if (when - lastClick < 0.3 / Math.abs(rate)) return;
    lastClick = when;
    clicks.push(t.tickAt(when));
  }, 8);
  const lag: number[] = [];
  const ft = frameTicks(project.sequences[0]!.fps);
  // Compare with the audio being heard: the graph clock minus the output latency.
  t.onPresent = (ctxTime, frameTick) => lag.push((t.tickAt(ctxTime - (context.outputLatency || 0)) - frameTick) / ft);
  t.play(rate);
  await sleep(seconds * 1000);
  const shown = t.playhead;
  t.pause();
  await sleep(300);
  clearInterval(poll);
  const px = renderer.readPixels();
  // The counter is laid out for the source size; when the sequence is larger, read the scaled-up picture.
  const src = project.media[0]?.video?.width ?? width;
  const k = width / src;
  const counter = readCounter(src, (x, y) => (px[(Math.floor((y + 0.5) * k) * width + Math.floor((x + 0.5) * k)) * 4] as number) > 128);
  const out: SyncResult = {
    seconds, presented: t.stats.presented, dropped: t.stats.dropped, lagFrames: lag,
    clickErrorMs: clicks.map((tick) => ((tick / S - Math.round(tick / S)) * 1000)),
    counterOk: counter === tickToFrame(t.playhead, project.sequences[0]!.fps), endSecond: shown / S,
  };
  t.dispose();
  renderer.dispose();
  eng.media.dispose();
  return out;
}

/** Transport controls: seek, step, J/K/L, loop, end of sequence, preview quality. */
export async function controls(): Promise<Record<string, unknown>> {
  const eng = await makeEngine(['clip_60']);
  const base = simpleProject(eng, 'clip_60', 2, 60, 320, 180);
  let project = base;
  const canvas = new OffscreenCanvas(1, 1);
  const renderer = new Renderer(canvas, eng.media);
  const t = new Transport({ getProject: () => project, renderer, media: eng.media });
  const fps = base.sequences[0]!.fps;
  const frame = (): number => tickToFrame(t.playhead, fps);
  const counter = (): number => {
    const px = renderer.readPixels();
    const w = canvas.width;
    return readCounter(w, (x, y) => (px[(y * w + x) * 4] as number) > 128);
  };
  const out: Record<string, unknown> = {};
  let events = 0;
  t.subscribe(() => events++);

  t.seek(frameToTick(30, fps));
  await sleep(250);
  out.seek = [frame(), counter(), t.playing];
  t.step(1);
  await sleep(200);
  t.step(-3);
  await sleep(200);
  out.step = [frame(), counter()];
  t.quality = 0.5;
  t.refresh();
  await sleep(200);
  out.half = [canvas.width, canvas.height, counter()];
  t.quality = 1;

  // L, L: forward at 1x then 2x. K stops on a frame. J: reverse.
  t.seek(0);
  t.shuttle(1);
  const r1 = t.rate;
  t.shuttle(1);
  const r2 = t.rate;
  const moved = await until(() => frame() > 30);
  t.shuttle(0);
  await sleep(200);
  out.shuttle = [r1, r2, t.playing, moved, frame() === counter()];
  t.seek(frameToTick(100, fps));
  const before = frame();
  t.shuttle(-1);
  const rj = t.rate;
  await until(() => frame() < 90);
  const during = frame();
  t.shuttle(-1);
  const rj2 = t.rate;
  t.pause();
  await sleep(200);
  out.reverse = [rj, rj2, during < before && during > 40 && frame() <= during, frame() === counter()];

  // Plays to the end and stops there.
  t.seek(frameToTick(100, fps));
  t.play();
  await sleep(1200);
  out.end = [t.playing, t.playhead === 2 * S, counter()];
  // Play from the end restarts from the beginning.
  t.play();
  await sleep(300);
  out.restart = [t.playing, frame() < 40];
  t.pause();

  // Loop between in and out: the playhead stays inside the range.
  project = { ...base, sequences: [{ ...base.sequences[0]!, inPoint: frameToTick(30, fps), outPoint: frameToTick(60, fps) }] };
  t.loop = true;
  t.seek(frameToTick(50, fps));
  t.play();
  const seen: number[] = [];
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    seen.push(frame());
  }
  out.loop = [t.playing, Math.min(...seen) >= 30, Math.max(...seen) <= 60, seen.some((f, i) => i > 0 && f < (seen[i - 1] as number))];
  t.pause();
  out.events = events > 10;
  t.dispose();
  renderer.dispose();
  eng.media.dispose();
  return out;
}
