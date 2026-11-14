// Phase 9 page-side check: decoded-video caches stay inside their limits however much is scrubbed.
import { makeClip, makeProject, makeSequence, makeTrack } from '../../../src/core/model.ts';
import { rng } from '../../../src/core/testkit.ts';
import { TICKS_PER_SECOND as S } from '../../../src/core/time.ts';
import { MediaJobs } from '../../../src/engine/mediaJobs.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { makeEngine } from './setup.ts';
import { file } from './util.ts';

export async function cacheSoak(frames: number): Promise<Record<string, number>> {
  const names = ['clip_24', 'clip_25', 'clip_2997', 'clip_60', 'vfr', 'rotated', 'hd_1080', 'long_2h'];
  const eng = await makeEngine(names);
  const seq = makeSequence('seq', { width: 320, height: 180, fps: { num: 30, den: 1 } });
  // Two tracks so two different files are decoded for every frame, eight files in rotation.
  seq.tracks = [0, 1].map((t) => ({
    ...makeTrack(`V${t + 1}`, 'video', `V${t + 1}`),
    clips: names.map((n, i) => makeClip({ id: `${t}-${i}`, kind: 'video', mediaId: names[(i + t * 3) % names.length] as string, start: i * S, duration: S })),
  }));
  const project = makeProject(seq);
  project.media = eng.assets;
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const rand = rng(99);
  let maxOpen = 0;
  let maxBytes = 0;
  let maxFrames = 0;
  let limitOpen = 0;
  let limitBytes = 0;
  for (let i = 0; i < frames; i++) {
    await r.renderFrame(project, Math.floor(rand() * names.length * 30) * (S / 30));
    const st = eng.media.stats();
    maxOpen = Math.max(maxOpen, st.openVideos);
    maxBytes = Math.max(maxBytes, st.bytes);
    maxFrames = Math.max(maxFrames, st.frames);
    limitOpen = st.maxOpen;
    limitBytes = st.maxBytes;
  }
  // Thumbnails and waveform peaks have their own bounded caches.
  const jobs = new MediaJobs(4096);
  for (let i = 0; i < 40; i++) await jobs.thumb('fp-long', { kind: 'blob', blob: file('long_2h') }, i * 97 * S, 36);
  for (const n of ['clip_24', 'clip_25', 'clip_60']) await jobs.peaks('fp-' + n, { kind: 'blob', blob: file(n) });
  const out = { maxOpen, limitOpen, maxBytes, limitBytes, maxFrames, thumbs: jobs.thumbCount, peakBytes: jobs.peakCacheBytes, peakLimit: 4096 };
  jobs.dispose();
  r.dispose();
  eng.media.dispose();
  return out;
}
