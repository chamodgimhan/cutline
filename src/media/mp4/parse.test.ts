import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../../core/invariants.ts';
import { project } from '../../core/testkit.ts';
import { ByteWriter } from '../bytes.ts';
import { analyseFrameRate, probe } from '../probe.ts';
import { MediaError, MemorySource } from '../source.ts';
import { box, fullBox, ftyp, mp4aEntry, visualEntry } from './boxes.ts';
import type { Mp4Track } from './demuxer.ts';
import { parseSampleEntry } from './parse.ts';

const stsd = (entry: Uint8Array): Uint8Array => new ByteWriter().u32(0).u32(1).bytes(entry).finish();
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

describe('codec strings from sample entries', () => {
  it('builds the HEVC string from an hvcC record', () => {
    // Main profile, main tier, level 3.1 (93), compatibility 0x60000000, constraint byte B0.
    const hvcC = box('hvcC', bytes(1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0));
    const e = parseSampleEntry(stsd(visualEntry('hvc1', 1920, 1080, hvcC)), 'vide');
    expect(e).toMatchObject({ codec: 'hvc1.1.6.L93.B0', width: 1920, height: 1080 });
    expect(e.description?.[12]).toBe(93);
  });

  it('builds VP9 and AV1 strings', () => {
    const vpcC = fullBox('vpcC', 1, 0, bytes(0, 31, 0x80, 1, 1, 1, 0, 0));
    expect(parseSampleEntry(stsd(visualEntry('vp09', 640, 360, vpcC)), 'vide').codec).toBe('vp09.00.31.08');
    const av1C = box('av1C', bytes(0x81, 0x08, 0x0c, 0));
    expect(parseSampleEntry(stsd(visualEntry('av01', 640, 360, av1C)), 'vide').codec).toBe('av01.0.08M.08');
  });

  it('reads AAC object type, channels and rate from esds, and flags MP3-in-MP4', () => {
    const aac = parseSampleEntry(stsd(mp4aEntry(2, 44100, bytes(0x12, 0x10))), 'soun');
    expect(aac).toMatchObject({ codec: 'mp4a.40.2', channels: 2, sampleRate: 44100 });
    expect([...(aac.description ?? [])]).toEqual([0x12, 0x10]);
    const heAac = parseSampleEntry(stsd(mp4aEntry(2, 48000, bytes(0x2b, 0x92, 0x08, 0))), 'soun');
    expect(heAac.codec).toBe('mp4a.40.5');
  });

  it('reports unknown formats without throwing', () => {
    expect(parseSampleEntry(stsd(visualEntry('apch', 1920, 1080, new Uint8Array())), 'vide').codec).toBe('unknown:apch');
    expect(() => parseSampleEntry(new Uint8Array(8), 'vide')).toThrow(MediaError);
  });
});

describe('frame rate analysis', () => {
  const track = (timescale: number, durations: number[]): Mp4Track => ({ timescale, durations: Uint32Array.from(durations) }) as Mp4Track;

  it('treats one-unit timestamp jitter as constant frame rate', () => {
    // 30 fps stored in milliseconds: 33, 33, 34 repeating.
    const d = Array.from({ length: 90 }, (_, i) => (i % 3 === 2 ? 34 : 33));
    expect(analyseFrameRate(track(1000, d))).toEqual({ fps: { num: 30, den: 1 }, vfr: false });
  });

  it('ignores a filler duration on the last sample, and flags real variation', () => {
    expect(analyseFrameRate(track(30000, [1001, 1001, 1001, 5]))).toEqual({ fps: { num: 30000, den: 1001 }, vfr: false });
    expect(analyseFrameRate(track(1000, [33, 17, 50, 33, 67, 16, 34, 50, 33])).vfr).toBe(true);
    expect(analyseFrameRate(track(1000, []))).toEqual({ fps: { num: 30, den: 1 }, vfr: false });
  });
});

describe('unsupported containers and damaged project media', () => {
  it('says so for a fragmented MP4', async () => {
    const file = new ByteWriter().bytes(ftyp()).bytes(box('moov', fullBox('mvhd', 0, 0, new Uint8Array(96)), box('mvex'))).finish();
    await expect(probe(new MemorySource(file))).rejects.toThrow(/fragmented MP4/);
  });

  it('rejects a project whose media entry is malformed', () => {
    const p = project({ V1: [['a', 0, 10]] });
    expect(checkInvariants(p)).toEqual([]);
    expect(checkInvariants({ ...p, media: [{ ...p.media[0]!, kind: 'hologram' as 'video' }] })[0]).toMatch(/malformed/);
    expect(checkInvariants({ ...p, media: [{ ...p.media[0]!, video: null }] })[0]).toMatch(/bad video info/);
  });
});
