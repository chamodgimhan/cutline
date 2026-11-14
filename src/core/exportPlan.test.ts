import { describe, expect, it } from 'vitest';
import { parseWebm } from '../../tools/webmReader.ts';
import { MemorySink } from '../media/mp4/muxer.ts';
import { pcmToFloat, wavReader } from '../media/pcm.ts';
import { MemorySource } from '../media/source.ts';
import { floatToPcm16, wavHeader } from '../media/wav.ts';
import { WebmMuxer } from '../media/webm/muxer.ts';
import { captionStyle } from './captions.ts';
import { eta, jobFrameTick, offlineInJobs, outputSize, planExport, PRESETS, type ExportSettings } from './exportPlan.ts';
import { defaultTextProps, defaultVideoProps } from './model.ts';
import { applyAffine, planFrame, viewWindow } from './render/plan.ts';
import { project } from './testkit.ts';
import { frameTicks } from './time.ts';

const F = frameTicks({ num: 30, den: 1 });
const settings = (extra: Partial<ExportSettings> = {}): ExportSettings => ({ format: 'mp4', preset: 'sequence', range: 'sequence', quality: 'medium', name: 'My Film', ...extra });
const base = () => project({ V1: [['a', 0, 60 * F], ['b', 90 * F, 30 * F]], A1: [['x', 0, 60 * F]] }, 1000 * F);

describe('export planning', () => {
  it('offers the required presets and sizes them, always even', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['sequence', '1080p', '4k', 'vertical', 'square', 'custom']);
    const p = base();
    expect(outputSize(p, settings())).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(p, settings({ preset: '4k' }))).toEqual({ width: 3840, height: 2160 });
    expect(outputSize(p, settings({ preset: 'vertical' }))).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(p, settings({ preset: 'square' }))).toEqual({ width: 1080, height: 1080 });
    expect(outputSize(p, settings({ preset: 'custom', width: 641, height: 359 }))).toEqual({ width: 642, height: 360 });
    expect(() => outputSize(p, settings({ preset: 'custom', width: 4, height: 4 }))).toThrow(/between 16 and 8192/);
    expect(() => outputSize(p, settings({ preset: 'nope' }))).toThrow(/Unknown/);
  });

  it('plans the whole sequence and the in/out range', () => {
    const p = base();
    const [job] = planExport(p, settings());
    expect(job).toMatchObject({ fileName: 'My Film.mp4', start: 0, end: 120 * F, frameCount: 120, width: 1920, height: 1080, sampleRate: 48000 });
    expect(jobFrameTick(job!, 7)).toBe(7 * F);
    p.sequences[0]!.inPoint = 30 * F;
    p.sequences[0]!.outPoint = 45 * F;
    expect(planExport(p, settings({ range: 'inout', format: 'webm' }))[0]).toMatchObject({ fileName: 'My Film.webm', start: 30 * F, end: 45 * F, frameCount: 15 });
    p.sequences[0]!.outPoint = 9999 * F; // an out point past the end stops at the end
    expect(planExport(p, settings({ range: 'inout' }))[0]!.end).toBe(120 * F);
    expect(() => planExport(base(), settings({ range: 'inout' }))).toThrow(/in or out point/);
    expect(planExport(p, settings({ format: 'png' }))[0]).toMatchObject({ fileName: 'My Film.png', frameCount: 1 });
  });

  it('plans one file per selected clip (linked picture and sound count once) and per marker range', () => {
    const p = base();
    const jobs = planExport(p, settings({ range: 'clips', clipIds: ['a', 'x', 'b'] }));
    expect(jobs.map((j) => [j.fileName, j.start / F, j.end / F])).toEqual([['My Film - clip 01.mp4', 0, 60], ['My Film - clip 02.mp4', 90, 120]]);
    expect(() => planExport(p, settings({ range: 'clips', clipIds: [] }))).toThrow(/Select the clips/);
    p.sequences[0]!.markers = [
      { id: 'm1', time: 0, duration: 10 * F, name: 'Intro', color: 'marker' }, { id: 'm2', time: 20 * F, duration: 0, name: 'point', color: 'marker' },
      { id: 'm3', time: 30 * F, duration: 10 * F, name: 'Intro', color: 'marker' }, { id: 'm4', time: 50 * F, duration: 10 * F, name: 'a/b:c?', color: 'marker' },
    ];
    expect(planExport(p, settings({ range: 'markers' })).map((j) => j.fileName)).toEqual(['My Film - Intro.mp4', 'My Film - Intro (2).mp4', 'My Film - a_b_c_.mp4']);
    expect(() => planExport(base(), settings({ range: 'markers' }))).toThrow(/markers that span a range/);
  });

  it('scales bitrate with size and quality, and reports offline media and time left', () => {
    const p = base();
    const [low] = planExport(p, settings({ quality: 'low' }));
    const [high] = planExport(p, settings({ quality: 'high' }));
    expect(high!.videoBitrate).toBeGreaterThan(low!.videoBitrate * 4);
    expect(planExport(p, settings({ preset: '4k', quality: 'high' }))[0]!.videoBitrate).toBeLessThanOrEqual(80_000_000);
    expect(offlineInJobs(p, planExport(p, settings()), () => false)).toEqual(['m']);
    expect(offlineInJobs(p, planExport(p, settings()), () => true)).toEqual([]);
    expect([eta(0, 100, 5000), eta(25, 100, 1000), eta(100, 100, 4000), eta(1, 100, 100)]).toEqual([null, 3000, 0, null]);
  });
});

describe('exporting to another shape', () => {
  it('shows the centre of the sequence, covering the new shape', () => {
    const seq = { width: 1920, height: 1080 };
    expect(viewWindow(seq)).toEqual({ width: 1920, height: 1080, x: 0, y: 0 });
    expect(viewWindow(seq, { width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080, x: 0, y: 0 });
    expect(viewWindow(seq, { width: 1080, height: 1920 })).toEqual({ width: 607.5, height: 1080, x: 656.25, y: 0 });
    expect(viewWindow(seq, { width: 1080, height: 1080 })).toEqual({ width: 1080, height: 1080, x: 420, y: 0 });
  });

  it('places clips in the window, with per-clip reframing', () => {
    const p = project({ V1: [['a', 0, 10]], V2: [['b', 0, 10, 0, { reframe: { x: 1, y: 0, scale: 1 } }]], V3: [['c', 0, 10, 0, { reframe: { x: 0, y: 0, scale: 2 } }]] });
    p.sequences[0] = { ...p.sequences[0]!, width: 1920, height: 1080 };
    const plan = planFrame(p, 0, undefined, { width: 1080, height: 1920 });
    expect([plan.width, plan.height]).toEqual([607.5, 1080]);
    const span = (i: number): number[] => [applyAffine(plan.layers[i]!.matrix, 0, 0)[0], applyAffine(plan.layers[i]!.matrix, 1, 1)[0]];
    expect(span(0)).toEqual([-656.25, 1263.75]); // centred: equal amounts cropped each side
    expect(span(1)).toEqual([-1312.5, 607.5]); // panned fully: the right edge of the picture meets the right edge of the frame
    expect(span(2)).toEqual([-1616.25, 2223.75]); // zoomed 2x about the centre
    // The plain plan is untouched.
    expect(planFrame(p, 0).layers[0]!.matrix.map((v) => v + 0)).toEqual([1920, 0, 0, 1080, 0, 0]);
  });

  it('lays titles and captions out for the new shape instead of cropping them', () => {
    const p = project({ V1: [['t', 0, 10, 0, { kind: 'text', mediaId: null, video: defaultVideoProps(), text: defaultTextProps('Title') }]], C1: [['c', 0, 10, 0, { text: { ...captionStyle(), text: 'Cue' } }]] });
    p.sequences[0] = { ...p.sequences[0]!, width: 1920, height: 1080 };
    const plan = planFrame(p, 0, undefined, { width: 1080, height: 1920 });
    expect(plan.layers.map((l) => l.matrix.map((v) => Math.round(v * 100) / 100 + 0))).toEqual([[607.5, 0, 0, 1080, 0, 0], [607.5, 0, 0, 1080, 0, 0]]);
  });
});

describe('WebM muxer', () => {
  it('writes a file the reader parses back: tracks, key frames, times, payloads, duration', () => {
    const sink = new MemorySink();
    const m = new WebmMuxer(sink);
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01]); // OpusHead, 2 channels, pre-skip 312
    const v = m.addVideoTrack({ codec: 'V_VP9', width: 640, height: 360 });
    const a = m.addAudioTrack({ sampleRate: 48000, channels: 2, opusHead: head });
    for (let i = 0; i < 90; i++) {
      m.addFrame(v, new Uint8Array([i, 1, 2, 3]), (i * 1000) / 30, i % 30 === 0);
      if (i % 3 === 0) m.addFrame(a, new Uint8Array([200 + (i % 50)]), i * 33, true);
    }
    m.finish(3000);
    const f = parseWebm(sink.bytes());
    expect(f.docType).toBe('webm');
    expect(f.durationMs).toBe(3000);
    expect(f.tracks.map((t) => [t.number, t.type, t.codecId, t.width, t.height, t.sampleRate, t.channels])).toEqual([[1, 'video', 'V_VP9', 640, 360, 0, 0], [2, 'audio', 'A_OPUS', 0, 0, 48000, 2]]);
    expect(f.tracks[1]!.codecPrivate).toEqual(head);
    const video = f.blocks.filter((b) => b.track === v);
    expect(video).toHaveLength(90);
    expect(video.map((b) => b.key).filter(Boolean)).toHaveLength(3);
    expect(video[31]).toMatchObject({ timeMs: 1033, key: false });
    expect([...video[89]!.data]).toEqual([89, 1, 2, 3]);
    expect(f.blocks.filter((b) => b.track === a)).toHaveLength(30);
    expect(f.blocks.filter((b) => b.track === a).every((b) => b.key)).toBe(true);
  });

  it('starts a new cluster before block times overflow 16 bits', () => {
    const sink = new MemorySink();
    const m = new WebmMuxer(sink);
    const a = m.addAudioTrack({ sampleRate: 48000, channels: 1, opusHead: new Uint8Array(19) });
    for (let i = 0; i < 100; i++) m.addFrame(a, new Uint8Array([i]), i * 1000, true);
    m.finish(0);
    const f = parseWebm(sink.bytes());
    expect(f.blocks.map((b) => b.timeMs)).toEqual(Array.from({ length: 100 }, (_, i) => i * 1000));
    expect(f.durationMs).toBe(99000);
  });
});

describe('WAV writer', () => {
  it('writes a header and samples the WAV reader reads back', async () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const right = Float32Array.from([0.25, 0, 0, 0, 0, -2]);
    const body = floatToPcm16([left, right]);
    const file = new Uint8Array(44 + body.length);
    file.set(wavHeader(44100, 2, 6));
    file.set(body, 44);
    const r = await wavReader(new MemorySource(file));
    expect(r).toMatchObject({ sampleRate: 44100, channels: 2, frames: 6 });
    const [l, rr] = pcmToFloat(await r.read(0, 6), r.format, 2);
    expect([...l!].map((x) => Math.round(x * 32768))).toEqual([0, 16384, -16383, 32767, -32767, 32767]); // scaled by 32767 and clipped at full scale
    expect(Math.round(rr![0]! * 32768)).toBe(8192);
  });
});
