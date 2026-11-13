// Phase 2 page-side checks: decode, seek, cache bound, audio, worker jobs, errors.
import { rng } from '../../../src/core/testkit.ts';
import { TICKS_PER_SECOND } from '../../../src/core/time.ts';
import { AudioSource } from '../../../src/engine/audioSource.ts';
import { MediaJobs } from '../../../src/engine/mediaJobs.ts';
import { VideoSource } from '../../../src/engine/videoSource.ts';
import { mp4aEntry } from '../../../src/media/mp4/boxes.ts';
import { MemorySink, Mp4Muxer } from '../../../src/media/mp4/muxer.ts';
import { peakRange } from '../../../src/media/peaks.ts';
import { probe } from '../../../src/media/probe.ts';
import { BlobSource, MemorySource } from '../../../src/media/source.ts';
import { pcmBlock } from '../../fixtures/build.ts';
import { counterOf, displayedCounter, errorMessage, file, frameHash } from './util.ts';

const open = (name: string, cacheBytes?: number): Promise<VideoSource> =>
  VideoSource.open(new BlobSource(file(name)), { hardwareAcceleration: 'prefer-software', cacheBytes });

export interface FrameResult { index: number; hash: string; counter: number; shown: number; width: number; height: number; time: number }

/** Decode the given frames (by index) and report hash, counter and displayed size. */
export async function frames(name: string, indices: number[]): Promise<FrameResult[]> {
  const src = await open(name);
  const out: FrameResult[] = [];
  for (const index of indices) {
    const f = await src.frame(index);
    const shown = displayedCounter(f, src.track.rotation);
    out.push({ index, hash: await frameHash(f), counter: await counterOf(f), shown: shown.counter, width: shown.width, height: shown.height, time: src.timeOf(index) });
    f.close();
  }
  src.close();
  return out;
}

/** Frame index chosen for a list of source times in milliseconds (VFR mapping check). */
export async function indicesAtMs(name: string, ms: number[]): Promise<number[]> {
  const src = await open(name);
  const out = ms.map((t) => src.indexAt(Math.round((t * TICKS_PER_SECOND) / 1000)));
  src.close();
  return out;
}

/** Sequential decode of every frame, then random seeks on a fresh source: hashes must agree. */
export async function seekTest(name: string, seed: number, seeks: number): Promise<{ frames: number; mismatches: number[]; restarts: number; sequentialRestarts: number }> {
  const a = await open(name);
  const hashes: string[] = [];
  for (let i = 0; i < a.frameCount; i++) {
    const f = await a.frame(i);
    hashes.push(await frameHash(f));
    f.close();
  }
  const sequentialRestarts = a.seeks;
  a.close();
  const b = await open(name, 2 * 1024 * 1024);
  const r = rng(seed);
  const mismatches: number[] = [];
  for (let k = 0; k < seeks; k++) {
    const i = Math.floor(r() * b.frameCount);
    const f = await b.frame(i);
    if ((await frameHash(f)) !== hashes[i]) mismatches.push(i);
    f.close();
  }
  const restarts = b.seeks;
  b.close();
  return { frames: hashes.length, mismatches, restarts, sequentialRestarts };
}

/** Walk the whole clip with a tiny cache and report the most frames ever held. */
export async function cacheBound(name: string): Promise<{ max: number; limit: number }> {
  const src = await open(name, 1);
  let max = 0;
  for (let i = 0; i < src.frameCount; i++) {
    (await src.frame(i)).close();
    max = Math.max(max, src.cachedFrames);
  }
  for (let i = src.frameCount - 1; i >= 0; i -= 3) {
    (await src.frame(i)).close();
    max = Math.max(max, src.cachedFrames);
  }
  const limit = src.maxFrames;
  src.close();
  return { max, limit };
}

/** Open time and per-seek times for a file, in milliseconds. */
export async function seekTimes(name: string, indices: number[]): Promise<{ openMs: number; counters: number[]; seekMs: number[] }> {
  const t0 = performance.now();
  const src = await open(name);
  const openMs = performance.now() - t0;
  const counters: number[] = [];
  const seekMs: number[] = [];
  for (const i of indices) {
    const t = performance.now();
    const f = await src.frame(i);
    seekMs.push(performance.now() - t);
    counters.push(await counterOf(f));
    f.close();
  }
  src.close();
  return { openMs, counters, seekMs };
}

/** PCM audio read through AudioSource equals the generator's samples exactly. Returns mismatching ranges. */
export async function audioExact(name: string, sampleRate: number, channels: number, ranges: [number, number][]): Promise<string[]> {
  const src = await AudioSource.open(new BlobSource(file(name)));
  const bad: string[] = [];
  if (src.sampleRate !== sampleRate || src.channels !== channels) bad.push(`format ${src.sampleRate}/${src.channels}`);
  for (const [first, count] of ranges) {
    const got = await src.read(first, count);
    const from = Math.max(0, first);
    const n = Math.max(0, Math.min(src.frames, first + count) - from);
    const want = new Int16Array(pcmBlock(sampleRate, channels, from, n).buffer);
    for (let c = 0; c < channels; c++) {
      const ch = got[c] as Float32Array;
      for (let i = 0; i < count; i++) {
        const inside = first + i >= 0 && first + i < src.frames;
        const expected = inside ? (want[(first + i - from) * channels + c] as number) / 32768 : 0;
        if (ch[i] !== expected) {
          bad.push(`${first}+${count} ch${c} @${i}: ${ch[i]} != ${expected}`);
          i = count;
          c = channels;
        }
      }
    }
  }
  return bad;
}

/** Encode the fixture audio to AAC, mux it, and decode it back through the compressed path. */
export async function aacRoundTrip(): Promise<{ supported: boolean; clickAt?: number; toneRms?: number; frames?: number }> {
  const config: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
  if (typeof AudioEncoder === 'undefined' || !(await AudioEncoder.isConfigSupported(config)).supported) return { supported: false };
  const total = 96000;
  const sink = new MemorySink();
  const mux = new Mp4Muxer(sink, { faststart: true });
  const packets: { data: Uint8Array; duration: number }[] = [];
  let asc: Uint8Array | null = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !asc) asc = new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, duration: Math.round(((chunk.duration ?? 21333) * 48000) / 1e6) });
    },
    error: (e) => {
      throw e;
    },
  });
  enc.configure(config);
  const pcm = new Int16Array(pcmBlock(48000, 2, 0, total).buffer);
  for (let at = 0; at < total; at += 4800) {
    enc.encode(new AudioData({ format: 's16', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 4800, timestamp: Math.round((at * 1e6) / 48000), data: pcm.slice(at * 2, (at + 4800) * 2).buffer as ArrayBuffer }));
  }
  await enc.flush();
  enc.close();
  if (!asc) return { supported: false };
  const track = mux.addTrack({ kind: 'audio', timescale: 48000, sampleEntry: mp4aEntry(2, 48000, asc, 192000) });
  for (const p of packets) mux.addSample(track, p.data, p.duration);
  mux.finish();
  const src = await AudioSource.open(new MemorySource(sink.bytes()));
  const [left] = (await src.read(0, total)) as [Float32Array];
  // The click at exactly one second should come back within a codec delay of its position.
  let clickAt = 0;
  for (let i = 40000; i < 56000; i++) if (Math.abs(left[i] as number) > Math.abs(left[clickAt] as number)) clickAt = i;
  let sum = 0;
  for (let i = 20000; i < 30000; i++) sum += (left[i] as number) ** 2;
  return { supported: true, clickAt, toneRms: Math.sqrt(sum / 10000), frames: src.frames };
}

/** Worker-built peaks and thumbnails, and their caching. */
export async function jobs(name: string): Promise<Record<string, unknown>> {
  const j = new MediaJobs();
  const spec = { kind: 'blob' as const, blob: file(name) };
  const t0 = performance.now();
  const peaks = await j.peaks('fp-' + name, spec);
  const peaksMs = performance.now() - t0;
  const again = await j.peaks('fp-' + name, spec);
  const thumb = await j.thumb('fp-' + name, spec, TICKS_PER_SECOND + 1000, 48);
  const same = (await j.thumb('fp-' + name, spec, TICKS_PER_SECOND + 2000, 48)) === thumb;
  const out = {
    buckets: peaks.min.length, rate: peaks.rate, clickPeak: peakRange(peaks, 100, 101).max, tonePeak: peakRange(peaks, 50, 51).max, toneMin: peakRange(peaks, 50, 51).min,
    cachedEqual: again.min.length === peaks.min.length && again.max.every((v, i) => v === peaks.max[i]), cacheBytes: j.peakCacheBytes,
    thumbW: thumb.width, thumbH: thumb.height, thumbCached: same && j.thumbNow('fp-' + name, TICKS_PER_SECOND, 48) === thumb, peaksMs,
    missing: await errorMessage(j.thumb('fp-none', { kind: 'blob', blob: new Blob([new Uint8Array(64)]) }, 0, 48)),
  };
  j.dispose();
  return out;
}

/** Plain messages for files that cannot be used. */
export async function errors(): Promise<Record<string, string>> {
  const good = new Uint8Array(await file('clip_24').arrayBuffer());
  const patch = (find: string, put: string): Uint8Array => {
    const out = good.slice();
    const at = new TextDecoder('latin1').decode(out).indexOf(find, 40); // skip the brand list in ftyp
    for (let i = 0; i < put.length; i++) out[at + i] = put.charCodeAt(i);
    return out;
  };
  const badProfile = good.slice();
  const avcC = new TextDecoder('latin1').decode(badProfile).indexOf('avcC');
  badProfile[avcC + 5] = 0xf7; // profile_idc no decoder knows
  return {
    corruptProbe: await errorMessage(probe(new BlobSource(file('corrupt')))),
    corruptVideo: await errorMessage(VideoSource.open(new BlobSource(file('corrupt')))),
    corruptAudio: await errorMessage(AudioSource.open(new BlobSource(file('corrupt')))),
    unknownCodec: await errorMessage(probe(new MemorySource(patch('avc1', 'zzzz')))),
    undecodable: await errorMessage(VideoSource.open(new MemorySource(badProfile))),
  };
}
