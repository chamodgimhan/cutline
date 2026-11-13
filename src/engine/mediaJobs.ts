// Main-thread front for the media worker: cached waveform peaks and thumbnails.
import { TICKS_PER_SECOND, type Tick } from '../core/time.ts';
import { ByteCache, decodePeaks, type Peaks } from '../media/peaks.ts';
import { MediaError } from '../media/source.ts';
import type { WorkerReply, WorkerRequest } from './mediaWorker.ts';
import type { SourceSpec } from './sourceSpec.ts';

type Pending = { resolve: (r: WorkerReply & { ok: true }) => void; reject: (e: Error) => void };
type Ask = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

const MAX_THUMBS = 1500;

export class MediaJobs {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly peakCache: ByteCache;
  private readonly peakJobs = new Map<string, Promise<Peaks>>();
  private readonly thumbs = new Map<string, ImageBitmap>();
  private readonly thumbJobs = new Map<string, Promise<ImageBitmap>>();

  constructor(peakCacheBytes = 64 * 1024 * 1024) {
    this.peakCache = new ByteCache(peakCacheBytes);
  }

  private ask(req: Ask): Promise<WorkerReply & { ok: true }> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./mediaWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data);
        else p.reject(new MediaError(e.data.code === 'unsupported' || e.data.code === 'missing' ? e.data.code : 'corrupt', e.data.message));
      };
      this.worker.onerror = () => {
        for (const p of this.pending.values()) p.reject(new MediaError('corrupt', 'The media could not be processed.'));
        this.pending.clear();
      };
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.worker as Worker).postMessage({ ...req, id });
    });
  }

  /** Waveform peaks for a file, keyed by its fingerprint. Computed once, then cached. */
  peaks(fingerprint: string, spec: SourceSpec): Promise<Peaks> {
    const cached = this.peakCache.get(fingerprint);
    const hit = cached && decodePeaks(cached);
    if (hit) return Promise.resolve(hit);
    let job = this.peakJobs.get(fingerprint);
    if (!job) {
      job = this.ask({ op: 'peaks', spec })
        .then((r) => {
          const bytes = r.peaks as Uint8Array;
          const peaks = decodePeaks(bytes);
          if (!peaks) throw new MediaError('corrupt', 'The waveform could not be built.');
          this.peakCache.set(fingerprint, bytes);
          return peaks;
        })
        .finally(() => this.peakJobs.delete(fingerprint));
      this.peakJobs.set(fingerprint, job);
    }
    return job;
  }

  /** Already-built thumbnail for this second of the file, if any (for synchronous drawing). */
  thumbNow(fingerprint: string, tick: Tick, height: number): ImageBitmap | undefined {
    return this.thumbs.get(`${fingerprint}:${height}:${Math.floor(tick / TICKS_PER_SECOND)}`);
  }

  /** Thumbnail of the key frame at or before `tick`, `height` pixels tall. One per second of source is kept. */
  thumb(fingerprint: string, spec: SourceSpec, tick: Tick, height: number): Promise<ImageBitmap> {
    const key = `${fingerprint}:${height}:${Math.floor(tick / TICKS_PER_SECOND)}`;
    const hit = this.thumbs.get(key);
    if (hit) {
      this.thumbs.delete(key);
      this.thumbs.set(key, hit);
      return Promise.resolve(hit);
    }
    let job = this.thumbJobs.get(key);
    if (!job) {
      job = this.ask({ op: 'thumb', key: fingerprint, spec, tick, height })
        .then((r) => {
          const bitmap = r.bitmap as ImageBitmap;
          this.thumbs.set(key, bitmap);
          for (const [k, old] of this.thumbs) {
            if (this.thumbs.size <= MAX_THUMBS) break;
            this.thumbs.delete(k);
            old.close();
          }
          return bitmap;
        })
        .finally(() => this.thumbJobs.delete(key));
      this.thumbJobs.set(key, job);
    }
    return job;
  }

  get thumbCount(): number {
    return this.thumbs.size;
  }
  get peakCacheBytes(): number {
    return this.peakCache.bytes;
  }

  /** Release the worker's decoder for a file that is no longer used. */
  forget(fingerprint: string): void {
    if (this.worker) void this.ask({ op: 'forget', key: fingerprint }).catch(() => undefined);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new MediaError('missing', 'Cancelled.'));
    this.pending.clear();
    for (const b of this.thumbs.values()) b.close();
    this.thumbs.clear();
  }
}
