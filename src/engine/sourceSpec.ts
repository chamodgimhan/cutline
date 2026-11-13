// Serialisable description of where media bytes come from, so workers can open the same file.
import { BlobSource, MediaError, type ByteSource } from '../media/source.ts';

export type SourceSpec = { kind: 'blob'; blob: Blob } | { kind: 'url'; url: string; size: number };

/** Range reads over a URL (the desktop app serves local files through its own protocol). */
export class UrlSource implements ByteSource {
  readonly size: number;
  private readonly url: string;
  constructor(url: string, size: number) {
    this.url = url;
    this.size = size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length) - 1;
    if (end < offset) return new Uint8Array();
    try {
      const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` } });
      if (!res.ok) throw new Error(String(res.status));
      const data = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range sends the whole file; cut out the part asked for.
      return res.status === 206 ? data : data.subarray(offset, end + 1);
    } catch {
      throw new MediaError('missing', 'The file could not be read. It may have been moved, renamed or deleted.');
    }
  }
}

export const openSpec = (spec: SourceSpec): ByteSource => (spec.kind === 'blob' ? new BlobSource(spec.blob) : new UrlSource(spec.url, spec.size));
