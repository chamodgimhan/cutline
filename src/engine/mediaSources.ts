// Open decoders per media asset, shared by the renderer and the audio mixer.
import type { Id, MediaAsset } from '../core/model.ts';
import type { MediaLibrary } from '../media/library.ts';
import type { ByteSource } from '../media/source.ts';
import { AudioSource } from './audioSource.ts';
import { VideoSource, type VideoSourceOptions } from './videoSource.ts';

/** Memory bound: at most this many video decoders open, each caching at most this many bytes of frames. */
export const MAX_OPEN_VIDEOS = 6;
const VIDEO_CACHE_BYTES = 64 * 1024 * 1024;

export class MediaSources {
  private readonly library: MediaLibrary;
  private readonly options: VideoSourceOptions;
  private readonly videos = new Map<Id, { from: ByteSource; source: Promise<VideoSource> }>();
  private readonly audios = new Map<Id, { from: ByteSource; source: Promise<AudioSource> }>();
  private readonly images = new Map<Id, { from: ByteSource; source: Promise<ImageBitmap> }>();

  constructor(library: MediaLibrary, options: VideoSourceOptions = {}) {
    this.library = library;
    this.options = options;
  }

  private get<T>(cache: Map<Id, { from: ByteSource; source: Promise<T> }>, asset: MediaAsset, open: (s: ByteSource) => Promise<T>, drop: (v: T) => void): Promise<T> | null {
    const from = this.library.source(asset.id);
    const hit = cache.get(asset.id);
    // A relinked or offline asset invalidates whatever was open for it.
    if (hit && hit.from !== from) {
      cache.delete(asset.id);
      void hit.source.then(drop, () => undefined);
    } else if (hit) return hit.source;
    if (!from) return null;
    const source = open(from);
    // A failed open stays cached, so a file that cannot be decoded is not re-opened for every frame.
    source.catch(() => undefined);
    cache.set(asset.id, { from, source });
    return source;
  }

  /** Decoder for an asset's video, or null when the asset is offline. */
  video(asset: MediaAsset): Promise<VideoSource> | null {
    const hit = this.videos.get(asset.id);
    if (hit) {
      this.videos.delete(asset.id); // most recently used goes last
      this.videos.set(asset.id, hit);
    }
    const out = this.get(this.videos, asset, (s) => VideoSource.open(s, { cacheBytes: VIDEO_CACHE_BYTES, ...this.options }), (v) => v.close());
    // Each open decoder holds frames in memory: keep only the most recently used ones open.
    for (const [id, old] of this.videos) {
      if (this.videos.size <= MAX_OPEN_VIDEOS) break;
      this.videos.delete(id);
      void old.source.then((v) => v.close(), () => undefined);
    }
    return out;
  }

  audio(asset: MediaAsset): Promise<AudioSource> | null {
    return this.get(this.audios, asset, (s) => AudioSource.open(s), () => undefined);
  }

  image(asset: MediaAsset): Promise<ImageBitmap> | null {
    return this.get(this.images, asset, async (s) => createImageBitmap(new Blob([(await s.read(0, s.size)) as BlobPart])), (b) => b.close());
  }

  /** Close everything (project closed). */
  dispose(): void {
    for (const v of this.videos.values()) void v.source.then((s) => s.close(), () => undefined);
    for (const i of this.images.values()) void i.source.then((b) => b.close(), () => undefined);
    this.videos.clear();
    this.audios.clear();
    this.images.clear();
  }
}
