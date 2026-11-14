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
  private readonly live = new Set<VideoSource>();

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
    const drop = (v: VideoSource): void => {
      this.live.delete(v);
      v.close();
    };
    const out = this.get(this.videos, asset, async (s) => {
      const v = await VideoSource.open(s, { cacheBytes: VIDEO_CACHE_BYTES, ...this.options });
      this.live.add(v);
      return v;
    }, drop);
    // Each open decoder holds frames in memory: keep only the most recently used ones open.
    for (const [id, old] of this.videos) {
      if (this.videos.size <= MAX_OPEN_VIDEOS) break;
      this.videos.delete(id);
      void old.source.then(drop, () => undefined);
    }
    return out;
  }

  audio(asset: MediaAsset): Promise<AudioSource> | null {
    return this.get(this.audios, asset, (s) => AudioSource.open(s), () => undefined);
  }

  image(asset: MediaAsset): Promise<ImageBitmap> | null {
    return this.get(this.images, asset, async (s) => createImageBitmap(new Blob([(await s.read(0, s.size)) as BlobPart])), (b) => b.close());
  }

  /** How much decoded video is held right now, against the limits. */
  stats(): { openVideos: number; frames: number; bytes: number; maxOpen: number; maxBytes: number } {
    let frames = 0;
    let bytes = 0;
    for (const v of this.live) {
      frames += v.cachedFrames;
      bytes += v.cachedFrames * v.track.width * v.track.height * 1.5;
    }
    return { openVideos: this.live.size, frames, bytes, maxOpen: MAX_OPEN_VIDEOS, maxBytes: MAX_OPEN_VIDEOS * VIDEO_CACHE_BYTES };
  }

  /** Close everything (project closed). */
  dispose(): void {
    this.live.clear();
    for (const v of this.videos.values()) void v.source.then((s) => s.close(), () => undefined);
    for (const i of this.images.values()) void i.source.then((b) => b.close(), () => undefined);
    this.videos.clear();
    this.audios.clear();
    this.images.clear();
  }
}
