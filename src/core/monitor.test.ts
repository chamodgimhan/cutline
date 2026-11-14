import { describe, expect, it } from 'vitest';
import { checkInvariants } from './invariants.ts';
import { sourceProject, STILL_DURATION } from './monitor.ts';
import { planFrame } from './render/plan.ts';
import { testMedia } from './testkit.ts';

describe('sourceProject', () => {
  it('wraps a video in a sequence of its own size and rate, with linked audio', () => {
    const m = testMedia('m', 1000);
    m.video = { ...m.video!, fps: { num: 30000, den: 1001 } };
    const p = sourceProject(m);
    expect(checkInvariants(p)).toEqual([]);
    expect(p.sequences[0]).toMatchObject({ width: 320, height: 180, fps: { num: 30000, den: 1001 }, sampleRate: 48000 });
    expect(p.sequences[0]!.tracks.map((t) => [t.kind, t.clips[0]!.duration, t.clips[0]!.linkId])).toEqual([['video', 1000, 'source'], ['audio', 1000, 'source']]);
    const layer = planFrame(p, 500).layers[0]!;
    expect(layer).toMatchObject({ mediaId: 'm', sourceTime: 500 });
    expect(layer.matrix.map((v) => Math.round(v) + 0)).toEqual([320, 0, 0, 180, 0, 0]); // fills the frame exactly
  });

  it('shows rotated video upright, audio-only files without a picture, and stills for a fixed time', () => {
    const turned = testMedia('m', 1000);
    turned.video = { ...turned.video!, rotation: 90 };
    expect(sourceProject(turned).sequences[0]).toMatchObject({ width: 180, height: 320 });
    const audio = sourceProject(testMedia('a', 700, 'audio'));
    expect(audio.sequences[0]!.tracks.map((t) => t.kind)).toEqual(['audio']);
    const still = sourceProject(testMedia('i', 0, 'image'));
    expect(checkInvariants(still)).toEqual([]);
    expect(still.sequences[0]!.tracks[0]!.clips[0]!.duration).toBe(STILL_DURATION);
    expect(planFrame(still, STILL_DURATION - 1).layers[0]!.sourceTime).toBe(0);
  });
});
