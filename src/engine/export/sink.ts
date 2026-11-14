// Where export bytes go: straight to a file on disk, or into memory when no file handle is available.
import { MemorySink, type Mp4Sink } from '../../media/mp4/muxer.ts';

export interface ExportSink extends Mp4Sink {
  /** Wait until everything written so far is on its way to disk. Rejects if a write failed. */
  flush(): Promise<void>;
  /** Finish the file. Returns its bytes for a memory sink, null for a file. */
  close(): Promise<Uint8Array | null>;
  /** Give up: nothing is kept. */
  abort(): Promise<void>;
  readonly size: number;
}

/** Streams to a FileSystemFileHandle. The browser writes to a swap file until close(), so an aborted export leaves the target untouched. */
export class FileSink implements ExportSink {
  private readonly stream: Promise<FileSystemWritableFileStream>;
  private chain: Promise<void> = Promise.resolve();
  private failed: unknown = null;
  size = 0;

  constructor(handle: FileSystemFileHandle) {
    this.stream = handle.createWritable();
  }

  private queue(op: (s: FileSystemWritableFileStream) => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        await op(await this.stream);
      } catch (e) {
        this.failed = e;
      }
    });
  }

  write(data: Uint8Array): void {
    const copy = data.slice();
    this.size += copy.length;
    this.queue((s) => s.write(copy as Uint8Array<ArrayBuffer>));
  }

  patch(position: number, data: Uint8Array): void {
    const copy = data.slice();
    const end = this.size;
    this.queue(async (s) => {
      await s.write({ type: 'write', position, data: copy as Uint8Array<ArrayBuffer> });
      await s.seek(end);
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.failed) throw this.failed;
  }

  async close(): Promise<null> {
    await this.flush();
    await (await this.stream).close();
    return null;
  }

  async abort(): Promise<void> {
    await this.chain.catch(() => undefined);
    await (await this.stream).abort().catch(() => undefined);
  }
}

export class MemoryExportSink implements ExportSink {
  private readonly inner = new MemorySink();
  size = 0;
  write(data: Uint8Array): void {
    this.size += data.length;
    this.inner.write(data);
  }
  patch(position: number, data: Uint8Array): void {
    this.inner.patch(position, data);
  }
  async flush(): Promise<void> {}
  async close(): Promise<Uint8Array> {
    return this.inner.bytes();
  }
  async abort(): Promise<void> {}
}

/** Plain message for a failed write. */
export function writeErrorMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'QuotaExceededError') return 'There is not enough disk space to finish the export.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Cutline is not allowed to write to that location. Choose another folder.';
  if (name === 'NotFoundError') return 'The export file or its folder was moved or deleted while exporting.';
  return 'The export file could not be written.';
}
