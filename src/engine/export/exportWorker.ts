// Export worker: renders every frame with the same Renderer the preview uses, encodes, and muxes to a sink.
// Audio is mixed on the main thread (Web Audio does not exist in workers) and sent here to be encoded.
import { jobFrameTick, type ExportJob } from '../../core/exportPlan.ts';
import { getSequence, type Id, type Project } from '../../core/model.ts';
import { viewWindow } from '../../core/render/plan.ts';
import { TICKS_PER_SECOND, tickToSample, type Tick } from '../../core/time.ts';
import { stampWatermark } from '../../core/watermark.ts';
import { MediaLibrary } from '../../media/library.ts';
import { concatBytes } from '../../media/bytes.ts';
import { DEFAULT_COLOR, type ColorInfo } from '../../media/color.ts';
import { avcC as avcCBox, colr, mp4aEntry, visualEntry } from '../../media/mp4/boxes.ts';
import { Mp4Muxer } from '../../media/mp4/muxer.ts';
import { MediaError } from '../../media/source.ts';
import { floatToPcm16, wavHeader } from '../../media/wav.ts';
import { rgbaToI420 } from '../../media/yuv.ts';
import { WebmMuxer } from '../../media/webm/muxer.ts';
import { MediaSources } from '../mediaSources.ts';
import { Renderer } from '../renderer.ts';
import { openSpec, type SourceSpec } from '../sourceSpec.ts';
import { audioConfig, QUANTIZER, videoConfig } from './codecs.ts';
import { FileSink, MemoryExportSink, writeErrorMessage, type ExportSink } from './sink.ts';

export type ToWorker =
  | { type: 'start'; job: ExportJob; project: Project; media: Record<Id, SourceSpec>; handle: FileSystemFileHandle | null; verify: boolean; watermark: boolean }
  | { type: 'audio'; seq: number; left: Float32Array; right: Float32Array }
  | { type: 'cancel' };

export type FromWorker =
  | { type: 'progress'; done: number; total: number }
  | { type: 'needAudio'; seq: number; start: Tick; end: Tick }
  | { type: 'done'; bytes: Uint8Array | null; size: number; frames: number; mismatches: number }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' };

const CANCEL = Symbol('cancelled');
let cancelled = false;
let audioSeq = 0;
const audioWaiters = new Map<number, (channels: [Float32Array, Float32Array]) => void>();
const post = (m: FromWorker, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);
const stop = (): void => {
  if (cancelled) throw CANCEL;
};

function requestAudio(start: Tick, end: Tick): Promise<[Float32Array, Float32Array]> {
  const seq = ++audioSeq;
  return new Promise((resolve) => {
    audioWaiters.set(seq, resolve);
    post({ type: 'needAudio', seq, start, end });
  });
}

interface Encoded {
  data: Uint8Array;
  ts: number; // microseconds
  key: boolean;
  duration: number; // microseconds
}
const bytesOf = (d: AllowSharedBufferSource): Uint8Array => (d instanceof ArrayBuffer || d instanceof SharedArrayBuffer ? new Uint8Array(d as ArrayBuffer) : new Uint8Array(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength)).slice();

async function exportMovie(job: ExportJob, project: Project, renderer: Renderer, sink: ExportSink, verify: boolean, watermark: boolean): Promise<number> {
  const vcfg = await videoConfig(job.format, job);
  const acfg = await audioConfig(job.format, job.sampleRate, job.audioBitrate);
  if (!vcfg || !acfg) throw new MediaError('unsupported', `This computer cannot encode ${job.format === 'mp4' ? 'MP4 (H.264 and AAC)' : 'WebM (VP9 and Opus)'} at this size.`);
  const seq = getSequence(project);
  const view = { width: job.width, height: job.height };
  const scale = job.width / viewWindow(seq, view).width;
  const vQ: Encoded[] = [];
  const aQ: Encoded[] = [];
  let vDesc: Uint8Array | null = null;
  let aDesc: Uint8Array | null = null;
  const vColor: ColorInfo = DEFAULT_COLOR;
  let failure: unknown = null;
  type Mux = { video(e: Encoded, index: number): void; audio(e: Encoded): void; finish(): void };
  // Held in an object because it is assigned inside callbacks.
  const out: { mux: Mux | null } = { mux: null };
  let videoIndex = 0;
  let last: 'v' | 'a' = 'v';

  const makeMux = (): Mux | null => {
    if (job.format === 'mp4') {
      if (!vDesc || !aDesc) return null;
      // WebCodecs hands over a complete avcC record: split out its parameter sets for our box writer.
      const d = vDesc;
      const spsLen = (d[6]! << 8) | d[7]!;
      const sps = d.subarray(8, 8 + spsLen);
      const ppsLen = (d[9 + spsLen]! << 8) | d[10 + spsLen]!;
      const pps = d.subarray(11 + spsLen, 11 + spsLen + ppsLen);
      const m = new Mp4Muxer(sink);
      const v = m.addTrack({ kind: 'video', timescale: job.fps.num, width: job.width, height: job.height, sampleEntry: visualEntry('avc1', job.width, job.height, concatBytes([avcCBox(sps, pps), colr(vColor)])) });
      const a = m.addTrack({ kind: 'audio', timescale: job.sampleRate, sampleEntry: mp4aEntry(2, job.sampleRate, aDesc, job.audioBitrate) });
      return {
        // Presentation time minus decode time, should the encoder ever reorder frames.
        video: (e, i) => m.addSample(v, e.data, job.fps.den, e.key, Math.max(0, Math.round((e.ts * job.fps.num) / 1e6) - i * job.fps.den)),
        audio: (e) => m.addSample(a, e.data, Math.max(1, Math.round((e.duration * job.sampleRate) / 1e6)) || 1024),
        finish: () => m.finish(),
      };
    }
    if (!aDesc || vQ.length === 0) return null;
    const m = new WebmMuxer(sink);
    const v = m.addVideoTrack({ codec: 'V_VP9', width: job.width, height: job.height, color: vColor });
    const a = m.addAudioTrack({ sampleRate: job.sampleRate, channels: 2, opusHead: aDesc });
    return { video: (e) => m.addFrame(v, e.data, e.ts / 1000, e.key), audio: (e) => m.addFrame(a, e.data, e.ts / 1000, true), finish: () => m.finish((job.frameCount * 1000 * job.fps.den) / job.fps.num) };
  };

  /** Write encoded data in time order. Until the end, something of each kind must be waiting so the order is known. */
  const pump = (final: boolean): void => {
    out.mux ??= makeMux();
    const mux = out.mux;
    if (!mux) return;
    while (final ? vQ.length || aQ.length : vQ.length && aQ.length) {
      const [v, a] = [vQ[0], aQ[0]];
      // Stay on one track for up to half a second at a time, so the file is not chopped into tiny pieces.
      const pickVideo = !a ? true : !v ? false : last === 'v' ? v.ts <= a.ts + 500_000 : v.ts < a.ts - 500_000;
      if (pickVideo) mux.video(vQ.shift() as Encoded, videoIndex++);
      else mux.audio(aQ.shift() as Encoded);
      last = pickVideo ? 'v' : 'a';
    }
  };

  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc && !vDesc) vDesc = bytesOf(desc);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      vQ.push({ data, ts: chunk.timestamp, key: chunk.type === 'key', duration: chunk.duration ?? 0 });
    },
    error: (e) => (failure = e),
  });
  const aenc = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc && !aDesc) aDesc = bytesOf(desc);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      aQ.push({ data, ts: chunk.timestamp, key: true, duration: chunk.duration ?? 0 });
    },
    error: (e) => (failure = e),
  });
  venc.configure(vcfg);
  aenc.configure(acfg);
  const q = QUANTIZER[job.format === 'mp4' ? 'mp4' : 'webm'][job.quality];
  const quant = vcfg.bitrateMode === 'quantizer' ? (job.format === 'mp4' ? { avc: { quantizer: q } } : { vp9: { quantizer: q } }) : {};
  const fps = job.fps.num / job.fps.den;
  const perSecond = Math.max(1, Math.round(fps));
  const frameMicros = (i: number): number => Math.round((i * 1e6 * job.fps.den) / job.fps.num);
  let audioDone = job.start;
  let audioFrames = 0;
  let mismatches = 0;
  try {
    for (let i = 0; i < job.frameCount; i++) {
      stop();
      if (failure) throw failure;
      await renderer.renderFrame(project, jobFrameTick(job, i), scale, undefined, view);
      // Convert to YUV ourselves (see yuv.ts): the encoder then gets, and the file is labelled as, BT.709 limited range.
      const rgba = renderer.readPixels();
      if (watermark) stampWatermark(rgba, job.width, job.height);
      const yuv = rgbaToI420(rgba, job.width, job.height);
      const frame = new VideoFrame(yuv, { format: 'I420', codedWidth: job.width, codedHeight: job.height, timestamp: frameMicros(i), duration: frameMicros(i + 1) - frameMicros(i), colorSpace: DEFAULT_COLOR as VideoColorSpaceInit });
      if (verify) {
        // What the encoder is handed must be exactly renderFrame's pixels (in their YUV form), read back from the frame itself.
        const given = new Uint8Array(frame.allocationSize());
        await frame.copyTo(given);
        const again = renderer.readPixels();
        if (watermark) stampWatermark(again, job.width, job.height);
        const drawn = rgbaToI420(again, job.width, job.height);
        if (frame.format !== 'I420' || given.length !== drawn.length || given.some((b, k) => b !== drawn[k])) mismatches++;
      }
      venc.encode(frame, { keyFrame: i % (perSecond * 2) === 0, ...quant });
      frame.close();
      while (venc.encodeQueueSize > 6 && !failure) await new Promise((r) => setTimeout(r, 2));
      if ((i + 1) % perSecond === 0 || i === job.frameCount - 1) {
        // Audio for the frames just rendered.
        const until = i === job.frameCount - 1 ? job.end : Math.min(job.end, jobFrameTick(job, i + 1));
        if (until > audioDone) {
          const [left, right] = await requestAudio(audioDone, until);
          stop();
          if (left.length > 0) {
            const data = new Float32Array(left.length * 2);
            data.set(left);
            data.set(right, left.length);
            aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: job.sampleRate, numberOfFrames: left.length, numberOfChannels: 2, timestamp: Math.round((audioFrames * 1e6) / job.sampleRate), data }));
            audioFrames += left.length;
          }
          audioDone = until;
        }
        pump(false);
        await sink.flush();
        post({ type: 'progress', done: i + 1, total: job.frameCount });
      }
    }
    await venc.flush();
    await aenc.flush();
    if (failure) throw failure;
    pump(true);
    if (!out.mux) throw new MediaError('unsupported', 'The encoder produced no output.');
    out.mux.finish();
  } finally {
    if (venc.state !== 'closed') venc.close();
    if (aenc.state !== 'closed') aenc.close();
  }
  return mismatches;
}

async function exportWav(job: ExportJob, sink: ExportSink): Promise<void> {
  const frames = tickToSample(job.end, job.sampleRate) - tickToSample(job.start, job.sampleRate);
  sink.write(wavHeader(job.sampleRate, 2, frames));
  const step = 5 * TICKS_PER_SECOND;
  for (let t = job.start; t < job.end; t += step) {
    stop();
    sink.write(floatToPcm16(await requestAudio(t, Math.min(job.end, t + step))));
    await sink.flush();
    post({ type: 'progress', done: Math.min(job.end, t + step) - job.start, total: job.end - job.start });
  }
}

async function run(m: Extract<ToWorker, { type: 'start' }>): Promise<void> {
  const { job, project } = m;
  const sink: ExportSink = m.handle ? new FileSink(m.handle) : new MemoryExportSink();
  const library = new MediaLibrary();
  for (const [id, spec] of Object.entries(m.media)) library.attach(id, openSpec(spec));
  const media = new MediaSources(library);
  const canvas = new OffscreenCanvas(job.width, job.height);
  let renderer: Renderer | null = null;
  try {
    let mismatches = 0;
    if (job.format === 'wav') await exportWav(job, sink);
    else {
      renderer = new Renderer(canvas, media);
      if (job.format === 'png') {
        const view = { width: job.width, height: job.height };
        await renderer.renderFrame(project, job.start, job.width / viewWindow(getSequence(project), view).width, undefined, view);
        // PNG from the same pixels a movie frame would get (so the watermark, when there is one, is identical).
        const rgba = renderer.readPixels();
        if (m.watermark) stampWatermark(rgba, job.width, job.height);
        const flat = new OffscreenCanvas(job.width, job.height);
        (flat.getContext('2d') as OffscreenCanvasRenderingContext2D).putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), job.width, job.height), 0, 0);
        sink.write(new Uint8Array(await (await flat.convertToBlob({ type: 'image/png' })).arrayBuffer()));
      } else mismatches = await exportMovie(job, project, renderer, sink, m.verify, m.watermark);
    }
    stop();
    const bytes = await sink.close();
    post({ type: 'done', bytes, size: sink.size, frames: job.frameCount, mismatches }, bytes ? [bytes.buffer] : []);
  } catch (e) {
    await sink.abort();
    if (e === CANCEL) post({ type: 'cancelled' });
    else if (e instanceof MediaError) post({ type: 'failed', message: e.message });
    else if (e instanceof DOMException && ['QuotaExceededError', 'NotAllowedError', 'SecurityError', 'NotFoundError'].includes(e.name)) post({ type: 'failed', message: writeErrorMessage(e) });
    else post({ type: 'failed', message: `The export stopped because of an error (${e instanceof Error ? e.message : String(e)}).` });
  } finally {
    renderer?.dispose();
    media.dispose();
  }
}

self.onmessage = (e: MessageEvent<ToWorker>): void => {
  const m = e.data;
  if (m.type === 'start') void run(m);
  else if (m.type === 'cancel') {
    cancelled = true;
    // Unblock a wait for audio so the cancel is noticed at once.
    for (const resolve of audioWaiters.values()) resolve([new Float32Array(0), new Float32Array(0)]);
    audioWaiters.clear();
  } else {
    audioWaiters.get(m.seq)?.([m.left, m.right]);
    audioWaiters.delete(m.seq);
  }
};
