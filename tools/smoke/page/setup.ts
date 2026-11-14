// Page-side engine setup shared by smoke suites: fixtures imported into a library under their own names.
import type { MediaAsset } from '../../../src/core/model.ts';
import { MediaSources } from '../../../src/engine/mediaSources.ts';
import { MediaLibrary } from '../../../src/media/library.ts';
import { BlobSource } from '../../../src/media/source.ts';
import { file } from './util.ts';

export interface TestEngine {
  library: MediaLibrary;
  media: MediaSources;
  assets: MediaAsset[];
}

export async function makeEngine(names: string[]): Promise<TestEngine> {
  const library = new MediaLibrary();
  const assets: MediaAsset[] = [];
  for (const name of names) assets.push(await library.importSource(new BlobSource(file(name)), name, name + '.mp4', '/fixtures/' + name + '.mp4'));
  return { library, media: new MediaSources(library, { hardwareAcceleration: 'prefer-software' }), assets };
}

/** Peak signal-to-noise ratio between two RGBA buffers, in dB (alpha ignored). */
export function psnr(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = (a[i + c] as number) - (b[i + c] as number);
      sum += d * d;
      n++;
    }
  }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / n));
}
