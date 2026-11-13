// Worker: waveform peaks and thumbnails, off the main thread.
import type { Tick } from '../core/time.ts';
import { encodePeaks, PeakBuilder } from '../media/peaks.ts';
import { AudioSource } from './audioSource.ts';
import { drawRotated } from './draw2d.ts';
import { openSpec, type SourceSpec } from './sourceSpec.ts';
import { VideoSource } from './videoSource.ts';

export type WorkerRequest =
  | { id: number; op: 'peaks'; spec: SourceSpec }
  | { id: number; op: 'thumb'; key: string; spec: SourceSpec; tick: Tick; height: number }
  | { id: number; op: 'forget'; key: string };

export type WorkerReply =
  | { id: number; ok: true; peaks?: Uint8Array; bitmap?: ImageBitmap }
  | { id: number; ok: false; code: string; message: string };

const MAX_OPEN = 4;
const videos = new Map<string, Promise<VideoSource>>();

function video(key: string, spec: SourceSpec): Promise<VideoSource> {
  let v = videos.get(key);
  if (v) videos.delete(key);
  else v = VideoSource.open(openSpec(spec), { cacheBytes: 4 * 1024 * 1024 });
  videos.set(key, v);
  for (const [k, old] of videos) {
    if (videos.size <= MAX_OPEN) break;
    videos.delete(k);
    void old.then((s) => s.close(), () => undefined);
  }
  return v;
}

async function peaks(spec: SourceSpec): Promise<Uint8Array> {
  const audio = await AudioSource.open(openSpec(spec));
  const builder = new PeakBuilder(audio.sampleRate);
  const block = audio.sampleRate * 4;
  for (let at = 0; at < audio.frames; at += block) builder.push(await audio.read(at, Math.min(block, audio.frames - at)));
  return encodePeaks(builder.finish());
}

async function thumb(key: string, spec: SourceSpec, tick: Tick, height: number): Promise<ImageBitmap> {
  const src = await video(key, spec);
  const frame = await src.frame(src.keyIndexAt(tick));
  try {
    const rot = src.track.rotation;
    const swap = rot === 90 || rot === 270;
    const aspect = swap ? src.track.height / src.track.width : src.track.width / src.track.height;
    const w = Math.max(2, Math.round(height * aspect));
    const canvas = new OffscreenCanvas(w, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    drawRotated(ctx, frame, frame.displayWidth, frame.displayHeight, rot, w, height);
    return canvas.transferToImageBitmap();
  } finally {
    frame.close();
  }
}

const post = (reply: WorkerReply, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const req = e.data;
  void (async () => {
    try {
      if (req.op === 'peaks') {
        const bytes = await peaks(req.spec);
        post({ id: req.id, ok: true, peaks: bytes }, [bytes.buffer]);
      } else if (req.op === 'thumb') {
        const bitmap = await thumb(req.key, req.spec, req.tick, req.height);
        post({ id: req.id, ok: true, bitmap }, [bitmap]);
      } else {
        const v = videos.get(req.key);
        videos.delete(req.key);
        void v?.then((s) => s.close(), () => undefined);
        post({ id: req.id, ok: true });
      }
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'error';
      post({ id: req.id, ok: false, code, message: err instanceof Error ? err.message : 'The media could not be processed.' });
    }
  })();
};
