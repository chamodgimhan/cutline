// ByteSource over a file on disk, for node tests and tools.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ByteSource } from '../src/media/source.ts';

export class NodeFileSource implements ByteSource {
  readonly size: number;
  private readonly fd: number;
  constructor(file: string) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const n = Math.max(0, Math.min(length, this.size - offset));
    const buf = new Uint8Array(n);
    fs.readSync(this.fd, buf, 0, n, offset);
    return buf;
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixturePath = (name: string): string => path.join(ROOT, 'fixtures/out', name);
