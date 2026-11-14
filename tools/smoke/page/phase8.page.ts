// Phase 8 page-side checks: export to every format, re-read the files, compare with the preview.
import { planExport, type ExportJob, type ExportSettings } from '../../../src/core/exportPlan.ts';
import { makeClip, makeProject, makeSequence, makeTrack, type Project } from '../../../src/core/model.ts';
import { frameToTick, TICKS_PER_SECOND as S } from '../../../src/core/time.ts';
import { renderAudio } from '../../../src/engine/audioRender.ts';
import { AudioSource } from '../../../src/engine/audioSource.ts';
import { supportedFormats } from '../../../src/engine/export/codecs.ts';
import { ExportQueue, type Destination, type ExportItem } from '../../../src/engine/export/queue.ts';
import { FileSink, writeErrorMessage } from '../../../src/engine/export/sink.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import type { SourceSpec } from '../../../src/engine/sourceSpec.ts';
import { VideoSource } from '../../../src/engine/videoSource.ts';
import { Mp4File } from '../../../src/media/mp4/demuxer.ts';
import { pcmToFloat, wavReader } from '../../../src/media/pcm.ts';
import { BlobSource, MemorySource } from '../../../src/media/source.ts';
import { parseWebm } from '../../webmReader.ts';
import { makeEngine, psnr, type TestEngine } from './setup.ts';
import { file } from './util.ts';

interface Setup {
  eng: TestEngine;
  project: Project;
  specs: Record<string, SourceSpec>;
  queue: ExportQueue;
}

/** A sequence with one fixture's picture and sound from time zero. */
async function setup(name: string, seconds: number, width: number, height: number, fps: number): Promise<Setup> {
  const eng = await makeEngine([name]);
  const seq = makeSequence('seq', { width, height, fps: { num: fps, den: 1 }, sampleRate: 48000, name: 'Export test' });
  const base = { mediaId: name, start: 0, duration: seconds * S, linkId: 'L' };
  seq.tracks = [{ ...makeTrack('V1', 'video', 'V1'), clips: [makeClip({ ...base, id: 'v', kind: 'video' })] }, { ...makeTrack('A1', 'audio', 'A1'), clips: [makeClip({ ...base, id: 'a', kind: 'audio' })] }];
  const project = makeProject(seq);
  project.media = eng.assets;
  return { eng, project, specs: { [name]: { kind: 'blob', blob: file(name) } }, queue: new ExportQueue(eng.media) };
}
const settings = (extra: Partial<ExportSettings>): ExportSettings => ({ format: 'mp4', preset: 'sequence', range: 'sequence', quality: 'high', name: 'out', ...extra });
const rgbaOf = (image: CanvasImageSource, w: number, h: number): Uint8Array => {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  return new Uint8Array(d.buffer);
};
async function opfs(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  return root.getDirectoryHandle(name, { create: true });
}
const names = async (dir: FileSystemDirectoryHandle): Promise<string[]> => {
  const out: string[] = [];
  for await (const key of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(key);
  return out.sort();
};
/** Position of the loudest sample near `around`. */
const clickNear = (x: Float32Array, around: number, reach = 4000): number => {
  let best = Math.max(0, around - reach);
  for (let i = best; i < Math.min(x.length, around + reach); i++) if (Math.abs(x[i] as number) > Math.abs(x[best] as number)) best = i;
  return best;
};

export interface MovieResult {
  supported: boolean;
  state?: string;
  message?: string | null;
  mismatches?: number;
  frames?: number;
  durationSeconds?: number;
  fps?: number;
  size?: number;
  psnr?: number[];
  clickAt?: number;
  audioSeconds?: number;
}

/** Export 2 s as a movie, then re-read it: frame count, duration, picture against the preview, audio sync. */
export async function movie(format: 'mp4' | 'webm'): Promise<MovieResult> {
  const { eng, project, specs, queue } = await setup('clip_24', 2, 320, 180, 24);
  const [job] = planExport(project, settings({ format })) as [ExportJob];
  if (!(await supportedFormats(job)).includes(format)) return { supported: false };
  const [item] = queue.add(project, [job], specs, { kind: 'memory' }, true) as [ExportItem];
  await queue.idle();
  if (item.state !== 'done' || !item.bytes) return { supported: true, state: item.state, message: item.message };
  const preview = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const at = [0, 7, 24, 40, 47];
  const scores: number[] = [];
  const compare = async (frame: VideoFrame, index: number): Promise<void> => {
    await preview.renderFrame(project, frameToTick(index, { num: 24, den: 1 }));
    scores.push(psnr(rgbaOf(frame, 320, 180), preview.readPixels()));
    frame.close();
  };
  let out: MovieResult;
  if (format === 'mp4') {
    const mp4 = await Mp4File.open(new MemorySource(item.bytes));
    const v = mp4.video!;
    const src = await VideoSource.open(new MemorySource(item.bytes), { hardwareAcceleration: 'prefer-software' });
    for (const i of at) await compare(await src.frame(i), i);
    src.close();
    const audio = await AudioSource.open(new MemorySource(item.bytes));
    const [left] = (await audio.read(0, audio.frames)) as [Float32Array];
    out = { supported: true, frames: v.sampleCount, durationSeconds: v.duration / v.timescale, fps: v.timescale / (v.durations[0] ?? 1), clickAt: clickNear(left, 48000), audioSeconds: audio.frames / audio.sampleRate };
  } else {
    const webm = parseWebm(item.bytes);
    const video = webm.blocks.filter((b) => b.track === 1);
    const frames: VideoFrame[] = [];
    const dec = new VideoDecoder({ output: (f) => frames.push(f), error: () => undefined });
    dec.configure({ codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 180, hardwareAcceleration: 'prefer-software', ...(webm.tracks[0]!.color ? { colorSpace: webm.tracks[0]!.color as VideoColorSpaceInit } : {}) });
    video.forEach((b, i) => dec.decode(new EncodedVideoChunk({ type: b.key ? 'key' : 'delta', timestamp: i, data: b.data })));
    await dec.flush();
    dec.close();
    for (const f of frames) {
      if (at.includes(f.timestamp)) await compare(f, f.timestamp);
      else f.close();
    }
    const track = webm.tracks.find((t) => t.type === 'audio')!;
    const pcm: Float32Array[] = [];
    const adec = new AudioDecoder({
      output: (d) => {
        const ch = new Float32Array(d.numberOfFrames);
        d.copyTo(ch, { planeIndex: 0, format: 'f32-planar' });
        pcm.push(ch);
        d.close();
      },
      error: () => undefined,
    });
    adec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: track.codecPrivate! });
    for (const b of webm.blocks.filter((x) => x.track === 2)) adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: b.timeMs * 1000, data: b.data }));
    await adec.flush();
    adec.close();
    const left = new Float32Array(pcm.reduce((n, c) => n + c.length, 0));
    pcm.reduce((o, c) => (left.set(c, o), o + c.length), 0);
    out = { supported: true, frames: video.length, durationSeconds: webm.durationMs / 1000, fps: video.length / (webm.durationMs / 1000), clickAt: clickNear(left, 48000), audioSeconds: left.length / 48000 };
  }
  preview.dispose();
  eng.media.dispose();
  return { ...out, state: item.state, mismatches: item.mismatches, size: item.size, psnr: scores };
}

/** PNG frame and WAV audio are exact; a different output shape uses the per-clip reframe. */
export async function stills(): Promise<Record<string, unknown>> {
  const { eng, project, specs, queue } = await setup('clip_24', 2, 320, 180, 24);
  project.sequences[0]!.inPoint = S / 2;
  const [png] = queue.add(project, planExport(project, settings({ format: 'png', range: 'inout' })), specs, { kind: 'memory' }) as [ExportItem];
  const [wav] = queue.add(project, planExport(project, settings({ format: 'wav' })), specs, { kind: 'memory' }) as [ExportItem];
  const tall = settings({ format: 'png', preset: 'custom', width: 180, height: 320 });
  const [centre] = queue.add(project, planExport(project, tall), specs, { kind: 'memory' }) as [ExportItem];
  const panned: Project = { ...project, sequences: [{ ...project.sequences[0]!, tracks: project.sequences[0]!.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, reframe: { x: -1, y: 0, scale: 1 } })) })) }] };
  const [left] = queue.add(panned, planExport(panned, tall), specs, { kind: 'memory' }) as [ExportItem];
  await queue.idle();
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  await r.renderFrame(project, S / 2);
  const bmp = await createImageBitmap(new Blob([png.bytes as BlobPart], { type: 'image/png' }));
  const pngPsnr = psnr(rgbaOf(bmp, 320, 180), r.readPixels());
  const reader = await wavReader(new MemorySource(wav.bytes as Uint8Array));
  const [wl] = pcmToFloat(await reader.read(0, reader.frames), reader.format, 2) as [Float32Array];
  const [ml] = await renderAudio(project, { start: 0, end: 2 * S }, eng.media);
  let worst = 0;
  for (let i = 0; i < ml.length; i++) worst = Math.max(worst, Math.abs((wl[i] as number) - (ml[i] as number)) * 32768);
  const tallBmp = await createImageBitmap(new Blob([centre.bytes as BlobPart]));
  const leftBmp = await createImageBitmap(new Blob([left.bytes as BlobPart]));
  // The counter is at the top-left of the source: panning fully left brings it into the vertical frame.
  await r.renderFrame(project, 0, 320 / 180, undefined, { width: 180, height: 320 });
  const out = {
    states: [png.state, wav.state, centre.state, left.state], pngSize: [bmp.width, bmp.height], pngPsnr, wavFrames: reader.frames, wavWorstLsb: worst,
    tallSize: [tallBmp.width, tallBmp.height], tallMatchesPreview: psnr(rgbaOf(tallBmp, 180, 320), r.readPixels()), reframeChanged: psnr(rgbaOf(tallBmp, 180, 320), rgbaOf(leftBmp, 180, 320)) < 30,
    formats: await supportedFormats({ width: 320, height: 180, fps: { num: 24, den: 1 }, videoBitrate: 1e6, sampleRate: 48000 }),
    impossible: await supportedFormats({ width: 32000, height: 32000, fps: { num: 24, den: 1 }, videoBitrate: 1e6, sampleRate: 48000 }),
  };
  r.dispose();
  eng.media.dispose();
  return out;
}

/** Cancel mid-export: nothing is left on disk. Also failures: a folder that cannot be written, a full disk. */
export async function cancelAndFail(): Promise<Record<string, unknown>> {
  const { eng, project, specs, queue } = await setup('long_2h', 120, 64, 48, 24);
  const dir = await opfs('cancel-test');
  const jobs = planExport(project, settings({}));
  const [item] = queue.add(project, jobs, specs, { kind: 'folder', dir }) as [ExportItem];
  const [waiting] = queue.add(project, planExport(project, settings({ name: 'second' })), specs, { kind: 'folder', dir }) as [ExportItem];
  await new Promise<void>((resolve) => {
    const off = queue.subscribe(() => {
      if (item.done > 0) {
        off();
        resolve();
      }
    });
  });
  const during = await names(dir);
  queue.cancel(waiting.id);
  queue.cancel(item.id);
  await queue.idle();
  const afterCancel = await names(dir);
  // A destination that refuses to create the file.
  const broken = { getFileHandle: () => Promise.reject(new DOMException('no', 'NotAllowedError')), removeEntry: () => Promise.resolve() } as unknown as FileSystemDirectoryHandle;
  const [refused] = queue.add(project, jobs, specs, { kind: 'folder', dir: broken }) as [ExportItem];
  await queue.idle();
  // A disk that fills up while writing.
  const full = { createWritable: async () => ({ write: () => Promise.reject(new DOMException('full', 'QuotaExceededError')), seek: async () => undefined, close: async () => undefined, abort: async () => undefined }) } as unknown as FileSystemFileHandle;
  const sink = new FileSink(full);
  sink.write(new Uint8Array(10));
  const fullMessage = await sink.flush().then(() => 'no error', (e: unknown) => writeErrorMessage(e));
  eng.media.dispose();
  return {
    during, afterCancel, states: [item.state, waiting.state, refused.state], refusedMessage: refused.message, fullMessage,
    projectIntact: project.sequences[0]!.tracks[0]!.clips.length === 1,
  };
}

/** Ten minutes of sequence streamed to disk: the page's memory must not grow with the length of the export. */
export async function longExport(seconds: number): Promise<Record<string, number | string | null>> {
  const { eng, project, specs, queue } = await setup('long_2h', seconds, 64, 48, 24);
  const dir = await opfs('long-test');
  const mem = (): number => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  const samples: number[] = [];
  const [item] = queue.add(project, planExport(project, settings({ quality: 'medium' })), specs, { kind: 'folder', dir }) as [ExportItem];
  const t0 = performance.now();
  const off = queue.subscribe(() => {
    if (item.done % 1200 === 0 && item.done > 0 && samples.length < item.done / 1200) samples.push(mem());
  });
  await queue.idle();
  off();
  const ms = performance.now() - t0;
  let frames = 0;
  let duration = 0;
  let size = 0;
  if (item.state === 'done') {
    const f = await (await dir.getFileHandle(item.job.fileName)).getFile();
    size = f.size;
    const mp4 = await Mp4File.open(new BlobSource(f));
    frames = mp4.video?.sampleCount ?? 0;
    duration = (mp4.video?.duration ?? 0) / (mp4.video?.timescale ?? 1);
  }
  eng.media.dispose();
  return { state: item.state, message: item.message, ms, frames, duration, size, heapFirst: samples[0] ?? 0, heapLast: samples[samples.length - 1] ?? 0, heapMax: Math.max(0, ...samples), bytesHeld: item.bytes?.length ?? 0 };
}

/** Batch clipping: twenty marker ranges become twenty valid files. */
export async function batch(): Promise<{ files: string[]; valid: number; states: string[]; frames: number[] }> {
  const { eng, project, specs, queue } = await setup('long_2h', 60, 64, 48, 24);
  project.sequences[0]!.markers = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, time: i * 2 * S, duration: S / 2, name: `Part ${String(i + 1).padStart(2, '0')}`, color: 'marker' }));
  const dir = await opfs('batch-test');
  const items = queue.add(project, planExport(project, settings({ range: 'markers', quality: 'medium', name: 'Clip' })), specs, { kind: 'folder', dir });
  await queue.idle();
  const files = await names(dir);
  const frames: number[] = [];
  let valid = 0;
  for (const name of files) {
    const mp4 = await Mp4File.open(new BlobSource(await (await dir.getFileHandle(name)).getFile()));
    frames.push(mp4.video?.sampleCount ?? 0);
    if (mp4.video && mp4.audio && mp4.video.sampleCount === 12) valid++;
  }
  eng.media.dispose();
  return { files, valid, states: items.map((i) => i.state), frames };
}

export type { Destination };
