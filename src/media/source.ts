// Random-access byte sources. Media is always read through ranges, never whole.
import { hashBytes } from './bytes.ts';

export interface ByteSource {
  readonly size: number;
  /** Read `length` bytes at `offset`. Short only at end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Thrown for any media problem the user can cause. The message is safe to show. */
export class MediaError extends Error {
  override name = 'MediaError';
  readonly code: 'corrupt' | 'unsupported' | 'missing' | 'mismatch';
  constructor(code: MediaError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export class MemorySource implements ByteSource {
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  get size(): number {
    return this.data.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.subarray(offset, Math.min(this.data.length, offset + length));
  }
}

/** Browser File/Blob. Slices are read lazily by the browser, so huge files stay on disk. */
export class BlobSource implements ByteSource {
  private readonly blob: Blob;
  constructor(blob: Blob) {
    this.blob = blob;
  }
  get size(): number {
    return this.blob.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
    } catch {
      throw new MediaError('missing', 'The file could not be read. It may have been moved, renamed or deleted.');
    }
  }
}

/** Wraps a source and counts what is read (tests assert long files are not read fully). */
export class CountingSource implements ByteSource {
  bytesRead = 0;
  reads = 0;
  private readonly inner: ByteSource;
  constructor(inner: ByteSource) {
    this.inner = inner;
  }
  get size(): number {
    return this.inner.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const out = await this.inner.read(offset, length);
    this.bytesRead += out.length;
    this.reads++;
    return out;
  }
}

const FINGERPRINT_SPAN = 65536;

/** Identity of a file's content: size plus hashes of its head and tail. Cheap for any file size. */
export async function fingerprint(source: ByteSource): Promise<string> {
  const head = await source.read(0, FINGERPRINT_SPAN);
  const tailAt = Math.max(0, source.size - FINGERPRINT_SPAN);
  const tail = tailAt > 0 ? await source.read(tailAt, FINGERPRINT_SPAN) : new Uint8Array();
  return `${source.size.toString(36)}-${hashBytes(head)}-${hashBytes(tail)}`;
}
