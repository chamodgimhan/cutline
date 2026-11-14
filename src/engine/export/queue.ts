// Export queue (main thread): runs jobs one at a time in a worker, feeds it audio, reports progress.
import { eta, type ExportJob } from '../../core/exportPlan.ts';
import type { Id, Project } from '../../core/model.ts';
import { renderAudio } from '../audioRender.ts';
import type { MediaSources } from '../mediaSources.ts';
import type { SourceSpec } from '../sourceSpec.ts';
import type { FromWorker, ToWorker } from './exportWorker.ts';

export type Destination = { kind: 'memory' } | { kind: 'file'; handle: FileSystemFileHandle } | { kind: 'folder'; dir: FileSystemDirectoryHandle };

export interface ExportItem {
  id: number;
  job: ExportJob;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  /** Milliseconds left, when known. */
  etaMs: number | null;
  message: string | null;
  /** The file's bytes when exported to memory. */
  bytes: Uint8Array | null;
  size: number;
  /** Frames whose encoder input differed from renderFrame (only counted with `verify`). */
  mismatches: number;
}

interface Entry {
  item: ExportItem;
  project: Project;
  media: Record<Id, SourceSpec>;
  dest: Destination;
  verify: boolean;
  watermark: boolean;
}

export class ExportQueue {
  readonly items: ExportItem[] = [];
  private readonly entries = new Map<number, Entry>();
  private readonly media: MediaSources;
  private readonly listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private running: number | null = null;
  private nextId = 1;

  /** `media` is used to mix audio for the worker. */
  constructor(media: MediaSources) {
    this.media = media;
  }

  /** Queue jobs. Each keeps the project as it was when queued, so later edits do not change the export. */
  add(project: Project, jobs: readonly ExportJob[], media: Record<Id, SourceSpec>, dest: Destination, verify = false, watermark = false): ExportItem[] {
    const added = jobs.map((job) => {
      const item: ExportItem = { id: this.nextId++, job, state: 'queued', done: 0, total: job.frameCount, etaMs: null, message: null, bytes: null, size: 0, mismatches: 0 };
      this.items.push(item);
      this.entries.set(item.id, { item, project, media, dest, verify, watermark });
      return item;
    });
    this.emit();
    void this.next();
    return added;
  }

  /** Resolves when the queue is empty. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.running === null && !this.items.some((i) => i.state === 'queued')) {
          this.listeners.delete(check);
          resolve();
        }
      };
      this.listeners.add(check);
      check();
    });
  }

  cancel(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.item.state === 'queued') {
      e.item.state = 'cancelled';
      this.emit();
    } else if (e.item.state === 'running') this.worker?.postMessage({ type: 'cancel' } satisfies ToWorker);
  }

  /** Forget finished items (and free any bytes they hold). */
  clearFinished(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i] as ExportItem;
      if (it.state === 'queued' || it.state === 'running') continue;
      this.items.splice(i, 1);
      this.entries.delete(it.id);
    }
    this.emit();
  }

  private async target(e: Entry): Promise<FileSystemFileHandle | null> {
    if (e.dest.kind === 'file') return e.dest.handle;
    if (e.dest.kind === 'folder') return e.dest.dir.getFileHandle(e.item.job.fileName, { create: true });
    return null;
  }

  /** A cancelled or failed export must leave no partial file behind. */
  private async discard(e: Entry, handle: FileSystemFileHandle | null): Promise<void> {
    try {
      if (e.dest.kind === 'folder') await e.dest.dir.removeEntry(e.item.job.fileName);
      else if (handle) await (handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove?.();
    } catch {
      // already gone
    }
  }

  private async next(): Promise<void> {
    if (this.running !== null) return;
    const e = [...this.entries.values()].find((x) => x.item.state === 'queued');
    if (!e) return this.emit();
    const item = e.item;
    this.running = item.id;
    item.state = 'running';
    const started = performance.now();
    this.emit();
    let handle: FileSystemFileHandle | null = null;
    const finish = async (state: ExportItem['state'], message: string | null): Promise<void> => {
      item.state = state;
      item.message = message;
      item.etaMs = null;
      if (state !== 'done') await this.discard(e, handle);
      this.worker?.terminate();
      this.worker = null;
      this.running = null;
      this.emit();
      void this.next();
    };
    try {
      handle = await this.target(e);
    } catch {
      return finish('failed', 'The export file could not be created in that location.');
    }
    const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onerror = () => void finish('failed', 'The export stopped because of an error.');
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'progress') {
        item.done = m.done;
        item.total = m.total;
        item.etaMs = eta(m.done, m.total, performance.now() - started);
        this.emit();
      } else if (m.type === 'needAudio') {
        void renderAudio(e.project, { start: m.start, end: m.end }, this.media).then(
          ([left, right]) => worker.postMessage({ type: 'audio', seq: m.seq, left, right } satisfies ToWorker, [left.buffer, right.buffer]),
          () => worker.postMessage({ type: 'audio', seq: m.seq, left: new Float32Array(0), right: new Float32Array(0) } satisfies ToWorker),
        );
      } else if (m.type === 'done') {
        item.bytes = m.bytes;
        item.size = m.size;
        item.mismatches = m.mismatches;
        item.done = item.total;
        void finish('done', null);
      } else if (m.type === 'failed') void finish('failed', m.message);
      else void finish('cancelled', null);
    };
    worker.postMessage({ type: 'start', job: item.job, project: e.project, media: e.media, handle, verify: e.verify, watermark: e.watermark } satisfies ToWorker);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
