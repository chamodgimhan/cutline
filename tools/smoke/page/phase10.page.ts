// Phase 10 page-side check: the export watermark is present without a licence and absent with one.
import { planExport } from '../../../src/core/exportPlan.ts';
import { makeClip, makeProject, makeSequence, makeTrack } from '../../../src/core/model.ts';
import { TICKS_PER_SECOND as S } from '../../../src/core/time.ts';
import { stampWatermark, watermarkBox } from '../../../src/core/watermark.ts';
import { ExportQueue, type ExportItem } from '../../../src/engine/export/queue.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { hashBytes } from '../../../src/media/bytes.ts';
import { makeEngine } from './setup.ts';
import { file } from './util.ts';

export async function watermark(): Promise<Record<string, unknown>> {
  const eng = await makeEngine(['clip_24']);
  const seq = makeSequence('seq', { width: 320, height: 180, fps: { num: 24, den: 1 } });
  seq.tracks = [{ ...makeTrack('V1', 'video', 'V1'), clips: [makeClip({ id: 'v', kind: 'video', mediaId: 'clip_24', start: 0, duration: 2 * S })] }, makeTrack('A1', 'audio', 'A1')];
  const project = makeProject(seq);
  project.media = eng.assets;
  const specs = { clip_24: { kind: 'blob' as const, blob: file('clip_24') } };
  const queue = new ExportQueue(eng.media);
  const png = planExport(project, { format: 'png', preset: 'sequence', range: 'sequence', quality: 'high', name: 'frame' });
  const [clean] = queue.add(project, png, specs, { kind: 'memory' }, false, false) as [ExportItem];
  const [marked] = queue.add(project, png, specs, { kind: 'memory' }, false, true) as [ExportItem];
  const movie = planExport(project, { format: 'mp4', preset: 'sequence', range: 'sequence', quality: 'high', name: 'movie' });
  const [film] = queue.add(project, movie, specs, { kind: 'memory' }, true, true) as [ExportItem];
  await queue.idle();
  const pixels = async (bytes: Uint8Array | null): Promise<Uint8Array> => {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
    const c = new OffscreenCanvas(320, 180);
    const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    return new Uint8Array(ctx.getImageData(0, 0, 320, 180).data.buffer);
  };
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  await r.renderFrame(project, 0);
  const preview = r.readPixels();
  const expected = preview.slice();
  stampWatermark(expected, 320, 180);
  const [a, b] = [await pixels(clean.bytes), await pixels(marked.bytes)];
  const [bx, by, bw, bh] = watermarkBox(320, 180);
  let outside = 0;
  let inside = 0;
  for (let y = 0; y < 180; y++) {
    for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
      if (x >= bx && x < bx + bw && y >= by && y < by + bh) inside++;
      else outside++;
    }
  }
  r.dispose();
  eng.media.dispose();
  return {
    previewHash: hashBytes(preview), licensedHash: hashBytes(a), unlicensedHash: hashBytes(b), expectedMarkedHash: hashBytes(expected),
    changedInside: inside, changedOutside: outside, boxPixels: bw * bh, movieState: film.state, movieMismatches: film.mismatches,
  };
}
