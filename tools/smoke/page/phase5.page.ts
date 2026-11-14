// Phase 5 page-side checks: mixdown accuracy, sync after edits, cuts without clicks, meters, loudness.
import { clipAudio, dbToGain } from '../../../src/core/audio/envelope.ts';
import { moveClips, splitClips } from '../../../src/core/commands/clips.ts';
import { rippleDelete } from '../../../src/core/commands/range.ts';
import { rippleTrim, slipClip, trimClip } from '../../../src/core/commands/trim.ts';
import { EditError } from '../../../src/core/command.ts';
import { checkInvariants } from '../../../src/core/invariants.ts';
import { makeKey } from '../../../src/core/keyframes.ts';
import { clipEnd, makeClip, makeProject, makeSequence, makeTrack, sequenceEnd, type Clip, type Project } from '../../../src/core/model.ts';
import { planFrame } from '../../../src/core/render/plan.ts';
import { idSource, rng } from '../../../src/core/testkit.ts';
import { frameTicks, TICKS_PER_SECOND as S, tickToSample } from '../../../src/core/time.ts';
import { measureLoudness, renderAudio } from '../../../src/engine/audioRender.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { Transport } from '../../../src/engine/transport.ts';
import { App } from '../../../src/ui/app.ts';
import { normaliseSelection } from '../../../src/ui/audioActions.ts';
import { pcmBlock } from '../../fixtures/build.ts';
import { makeEngine } from './setup.ts';
import { file } from './util.ts';

const R = 48000;
const aclip = (id: string, start: number, duration: number, sourceIn: number, audio: Partial<NonNullable<Clip['audio']>> = {}, mediaId = 'clip_24'): Clip =>
  makeClip({ id, kind: 'audio', mediaId, start: Math.round(start * S), duration: Math.round(duration * S), sourceIn: Math.round(sourceIn * S), audio: { gain: audio.gain ?? 0, fadeIn: Math.round((audio.fadeIn ?? 0) * S), fadeOut: Math.round((audio.fadeOut ?? 0) * S) } });

function audioProject(tracks: { clips: Clip[]; volume?: number; pan?: number }[], media: Project['media']): Project {
  const seq = makeSequence('seq', { sampleRate: R });
  seq.tracks = tracks.map((t, i) => ({ ...makeTrack(`A${i + 1}`, 'audio', `A${i + 1}`), clips: t.clips, volume: t.volume ?? 0, pan: t.pan ?? 0 }));
  const p = makeProject(seq);
  p.media = media;
  return p;
}

/** Fades in `aclip` are given in seconds. */
/** Mixdown of a project with gain, keyframed gain, fades, a cut and two tracks against an independent calculation. */
export async function mixdown(): Promise<{ worstLsb: number; samples: number; cutLsb: number; panRight: number; panLeft: number }> {
  const eng = await makeEngine(['clip_24']);
  const keyed = { keys: [makeKey(0, 0), makeKey(S / 2, -20)] };
  const p = audioProject([
    { clips: [aclip('a', 0, 1, 0, { gain: -6, fadeIn: 0.25 }), aclip('b', 1, 1, 1, { gain: -6, fadeOut: 0.1 })] }, // b continues a: a cut in continuous material
    { clips: [aclip('c', 0.5, 1, 0.25, { gain: keyed })], volume: -3 },
  ], eng.assets);
  const [left] = await renderAudio(p, { start: 0, end: 2 * S }, eng.media);
  const src = new Int16Array(pcmBlock(R, 2, 0, 2 * R).buffer);
  let worst = 0;
  let cut = 0;
  for (let n = 0; n < left.length; n++) {
    let want = 0;
    for (const track of p.sequences[0]!.tracks) {
      for (const c of track.clips) {
        const shape = clipAudio(p, c, R);
        if (n < shape.from || n >= shape.to) continue;
        const s = tickToSample(c.sourceIn, R) + (n - shape.start);
        want += ((src[s * 2] ?? 0) / 32768) * shape.gainAt(n) * dbToGain(track.volume);
      }
    }
    const d = Math.abs((left[n] as number) - want) * 32768;
    worst = Math.max(worst, d);
    if (Math.abs(n - R) < 100) cut = Math.max(cut, d);
  }
  const panned = audioProject([{ clips: [aclip('a', 0, 1, 0.2)], pan: -1 }], eng.assets);
  const [pl, pr] = await renderAudio(panned, { start: S / 4, end: S / 2 }, eng.media);
  eng.media.dispose();
  const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return { worstLsb: worst, samples: left.length, cutLsb: cut, panRight: peak(pr), panLeft: peak(pl) };
}

/** Largest sample-to-sample step around cuts into silence, out of silence, and between unrelated material. */
export async function cuts(): Promise<{ maxStep: number; rawStep: number; toneSlope: number }> {
  const eng = await makeEngine(['clip_24']);
  // Source offsets chosen so each cut lands on a tone peak: the worst case for a click.
  const p = audioProject([{ clips: [aclip('a', 0.1, 0.4, 0.10025), aclip('b', 0.7, 0.3, 0.30025), aclip('c', 1.0, 0.4, 0.50075)] }], eng.assets);
  const [left] = await renderAudio(p, { start: 0, end: (3 * S) / 2 }, eng.media);
  let maxStep = 0;
  for (let n = 1; n < left.length; n++) maxStep = Math.max(maxStep, Math.abs((left[n] as number) - (left[n - 1] as number)));
  eng.media.dispose();
  return { maxStep, rawStep: 8000 / 32768, toneSlope: (8000 / 32768) * 2 * Math.PI * (1000 / R) };
}

/**
 * Fifty linked edits on a one-minute clip with picture and sound, then: every click in the
 * mix must sit where the picture shows the start of a whole source second.
 */
export async function editsKeepSync(seed: number): Promise<{ edits: number; clicks: number; worstMs: number; expected: number; clips: number; invalid: string[] }> {
  const eng = await makeEngine(['long_2h']);
  const fps = { num: 24, den: 1 };
  const F = frameTicks(fps);
  const seq = makeSequence('seq', { width: 64, height: 48, fps, sampleRate: R });
  const v = makeTrack('V1', 'video', 'V1');
  const a = makeTrack('A1', 'audio', 'A1');
  v.clips = [makeClip({ id: 'v', kind: 'video', mediaId: 'long_2h', start: 0, duration: 60 * S, sourceIn: 100 * S, linkId: 'L' })];
  a.clips = [makeClip({ id: 'a', kind: 'audio', mediaId: 'long_2h', start: 0, duration: 60 * S, sourceIn: 100 * S, linkId: 'L' })];
  seq.tracks = [v, a];
  let p = makeProject(seq);
  p.media = eng.assets;
  const r = rng(seed);
  const ctx = { newId: idSource('e') };
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  let edits = 0;
  for (let guard = 0; edits < 50 && guard < 2000; guard++) {
    const clips = p.sequences[0]!.tracks[0]!.clips;
    const c = clips[int(0, clips.length - 1)] as Clip;
    const at = c.start + int(1, Math.max(1, Math.floor(c.duration / F) - 1)) * F;
    const edge = r() < 0.5 ? 'in' : 'out';
    try {
      const cmd = [
        () => splitClips(p, ctx, { at, ids: [c.id] }),
        () => moveClips(p, ctx, { ids: [c.id], delta: int(-48, 48) * F }),
        () => trimClip(p, ctx, { id: c.id, edge, to: (edge === 'in' ? c.start : clipEnd(c)) + int(-8, 8) * F, minDuration: F }),
        () => rippleTrim(p, ctx, { id: c.id, edge, to: (edge === 'in' ? c.start : clipEnd(c)) + int(-8, 8) * F, minDuration: F }),
        () => slipClip(p, ctx, { id: c.id, by: int(-48, 48) * F }),
        () => (clips.length > 12 ? rippleDelete(p, ctx, [c.id]) : splitClips(p, ctx, { at, ids: [c.id] })),
      ][int(0, 5)]!();
      if (cmd.isEmpty) continue;
      p = cmd.apply(p);
      edits++;
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
    }
  }
  const end = sequenceEnd(p.sequences[0]!);
  const [left] = await renderAudio(p, { start: 0, end }, eng.media);
  // Clicks: local maxima well above the tone.
  let clicks = 0;
  let worst = 0;
  for (let n = 1; n < left.length - 1; n++) {
    const x = Math.abs(left[n] as number);
    if (x < 0.5 || x < Math.abs(left[n - 1] as number) || x <= Math.abs(left[n + 1] as number)) continue;
    const layer = planFrame(p, Math.round((n * S) / R)).layers[0];
    if (!layer) continue;
    const off = ((layer.sourceTime + (n * S) / R - Math.round((n * S) / R)) / S) % 1;
    worst = Math.max(worst, Math.min(off, 1 - off) * 1000);
    clicks++;
    n += 100;
  }
  // How many clicks the picture says there should be: whole source seconds shown, away from clip edges.
  let expected = 0;
  for (const c of p.sequences[0]!.tracks[1]!.clips) {
    for (let s = Math.ceil(c.sourceIn / S); s * S < c.sourceIn + c.duration; s++) {
      const t = c.start + (s * S - c.sourceIn);
      if (t - c.start > S / 100 && clipEnd(c) - t > S / 100) expected++;
    }
  }
  eng.media.dispose();
  return { edits, clicks, worstMs: worst, expected, clips: p.sequences[0]!.tracks[0]!.clips.length, invalid: checkInvariants(p) };
}

/** Meter readings during playback against the peak computed from the same range of the mix. */
export async function meters(): Promise<{ meter: [number, number]; computed: [number, number]; scrubs: number; scrubsOff: number }> {
  const eng = await makeEngine(['clip_24']);
  const p = audioProject([{ clips: [aclip('a', 0, 2, 0, { gain: -4 })], volume: -2 }], eng.assets);
  const t = new Transport({ getProject: () => p, renderer: new Renderer(new OffscreenCanvas(1, 1), eng.media), media: eng.media });
  const meter: [number, number] = [0, 0];
  let last: number | null = null;
  let heardUntil = 0;
  t.play();
  for (const t0 = performance.now(); performance.now() - t0 < 1400; await new Promise((res) => setTimeout(res, 16))) {
    const now = t.audioTime;
    if (now !== null && last !== null) {
      const pk = t.peaksBetween(last, now);
      meter[0] = Math.max(meter[0], pk[0]);
      meter[1] = Math.max(meter[1], pk[1]);
      heardUntil = t.tickAt(now);
    }
    last = now;
  }
  t.pause();
  const [l, r] = await renderAudio(p, { start: 0, end: heardUntil }, eng.media);
  const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  // Audio scrub: moving the playhead while paused plays a burst; turned off, it does not.
  t.seek(S / 2);
  t.seek(S);
  await new Promise((res) => setTimeout(res, 300));
  const scrubs = t.scrubs;
  t.scrubAudio = false;
  t.seek(S / 4);
  await new Promise((res) => setTimeout(res, 200));
  const out = { meter, computed: [peak(l), peak(r)] as [number, number], scrubs, scrubsOff: t.scrubs - scrubs };
  t.dispose();
  eng.media.dispose();
  return out;
}

/** Integrated loudness of the fixture, and normalise bringing a clip to its target. */
export async function loudness(): Promise<{ fixture: number; before: number; after: number; gain: number; undo: string | null }> {
  const eng = await makeEngine(['clip_24']);
  const fixture = await measureLoudness(audioProject([{ clips: [aclip('a', 0, 2, 0)] }], eng.assets), { start: 0, end: 2 * S }, eng.media);
  eng.media.dispose();
  const app = new App();
  await app.importFiles([file('clip_24')]);
  const s = app.session;
  const id = s.project.media[0]!.id;
  const clip = makeClip({ id: 'n', kind: 'audio', mediaId: id, start: 0, duration: 2 * S, audio: { gain: -9, fadeIn: 0, fadeOut: 0 } });
  s.history.reset({ ...s.project, sequences: [{ ...s.seq, tracks: s.seq.tracks.map((t) => (t.id === 'a1' ? { ...t, clips: [clip] } : t)) }] });
  const before = await measureLoudness(s.project, { start: 0, end: 2 * S }, app.media);
  s.select(['n']);
  await normaliseSelection(app, -16);
  const after = await measureLoudness(s.project, { start: 0, end: 2 * S }, app.media);
  const gain = s.seq.tracks.find((t) => t.id === 'a1')!.clips[0]!.audio!.gain as number;
  return { fixture, before, after, gain, undo: s.history.undoLabel };
}
