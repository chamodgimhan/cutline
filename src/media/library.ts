// Runtime side of the media pool: which assets have a readable file behind them.
// The project stores path + fingerprint; this maps asset ids to open byte sources.
import type { Id, MediaAsset } from '../core/model.ts';
import { describeMedia } from './probe.ts';
import { fingerprint, MediaError, type ByteSource } from './source.ts';

export type MediaStatus = 'online' | 'offline';

export class MediaLibrary {
  private readonly sources = new Map<Id, ByteSource>();
  private readonly listeners = new Set<() => void>();

  source(id: Id): ByteSource | undefined {
    return this.sources.get(id);
  }

  /** The source for an asset, or a MediaError saying the media is offline. */
  need(asset: MediaAsset): ByteSource {
    const s = this.sources.get(asset.id);
    if (!s) throw new MediaError('missing', `"${asset.name}" is offline. Relink it to use it again.`);
    return s;
  }

  status(id: Id): MediaStatus {
    return this.sources.has(id) ? 'online' : 'offline';
  }

  attach(id: Id, source: ByteSource): void {
    this.sources.set(id, source);
    this.emit();
  }

  detach(id: Id): void {
    if (this.sources.delete(id)) this.emit();
  }

  clear(): void {
    this.sources.clear();
    this.emit();
  }

  /** Probe a new file and bring it online. The caller adds the returned asset to the project. */
  async importSource(source: ByteSource, id: Id, name: string, path: string): Promise<MediaAsset> {
    const asset = await describeMedia(source, id, name, path);
    this.attach(id, source);
    return asset;
  }

  /**
   * Reconnect an asset to a file. The file must be the same content (fingerprint) unless
   * `force` is set, in which case it must at least be the same kind and long enough is
   * checked by the project when the returned change is applied.
   * Returns the fields to update on the asset.
   */
  async relink(asset: MediaAsset, source: ByteSource, path: string, force = false): Promise<Partial<MediaAsset>> {
    const fp = await fingerprint(source);
    if (fp === asset.fingerprint) {
      this.attach(asset.id, source);
      return { path };
    }
    if (!force) throw new MediaError('mismatch', `That file is not the same as "${asset.name}". Choose the original file, or relink anyway to replace it.`);
    const next = await describeMedia(source, asset.id, asset.name, path);
    if (next.kind !== asset.kind) throw new MediaError('mismatch', `"${asset.name}" is ${asset.kind} but the chosen file is ${next.kind}.`);
    if (asset.audio && !next.audio) throw new MediaError('mismatch', `The chosen file has no audio, but "${asset.name}" does.`);
    this.attach(asset.id, source);
    return { path, fingerprint: next.fingerprint, duration: next.duration, video: next.video, audio: next.audio };
  }

  /**
   * After opening a project: try to open every asset by path. Assets whose file is
   * missing or has different content stay offline. Returns the ids left offline.
   */
  async resolve(assets: readonly MediaAsset[], open: (asset: MediaAsset) => Promise<ByteSource | null>): Promise<Id[]> {
    const offline: Id[] = [];
    for (const asset of assets) {
      let ok = false;
      try {
        const src = await open(asset);
        if (src && (await fingerprint(src)) === asset.fingerprint) {
          this.sources.set(asset.id, src);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!ok) {
        this.sources.delete(asset.id);
        offline.push(asset.id);
      }
    }
    this.emit();
    return offline;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
