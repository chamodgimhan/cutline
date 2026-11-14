// Export planning: presets, what range each output file covers, and the exact frame times.
import { EditError } from './command.ts';
import { clipEnd, getSequence, sequenceEnd, type Id, type Project } from './model.ts';
import { frameToTick, tickToFrame, type Rational, type Tick } from './time.ts';

export type ExportFormat = 'mp4' | 'webm' | 'png' | 'wav';
export const FORMAT_LABELS: Record<ExportFormat, string> = { mp4: 'MP4 (H.264 + AAC)', webm: 'WebM (VP9 + Opus)', png: 'PNG frame', wav: 'WAV audio' };

export interface Preset {
  id: string;
  label: string;
  /** Null = the sequence's own size. */
  size: { width: number; height: number } | null;
}

export const PRESETS: readonly Preset[] = [
  { id: 'sequence', label: 'Same as sequence', size: null },
  { id: '1080p', label: '1080p (1920 x 1080)', size: { width: 1920, height: 1080 } },
  { id: '4k', label: '4K (3840 x 2160)', size: { width: 3840, height: 2160 } },
  { id: 'vertical', label: 'Vertical (1080 x 1920)', size: { width: 1080, height: 1920 } },
  { id: 'square', label: 'Square (1080 x 1080)', size: { width: 1080, height: 1080 } },
  { id: 'custom', label: 'Custom size', size: null },
];

export type RangeMode = 'sequence' | 'inout' | 'clips' | 'markers';
export type Quality = 'low' | 'medium' | 'high';
const BITS_PER_PIXEL: Record<Quality, number> = { low: 0.05, medium: 0.12, high: 0.3 };

export interface ExportSettings {
  format: ExportFormat;
  preset: string;
  /** Used when preset is 'custom'. */
  width?: number;
  height?: number;
  range: RangeMode;
  quality: Quality;
  /** Base file name, without extension. */
  name: string;
  /** Clip ids for range 'clips'. */
  clipIds?: readonly Id[];
}

export interface ExportJob {
  /** File name with extension. */
  fileName: string;
  format: ExportFormat;
  start: Tick;
  end: Tick;
  width: number;
  height: number;
  fps: Rational;
  sampleRate: number;
  videoBitrate: number;
  audioBitrate: number;
  frameCount: number;
  quality: Quality;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
/** A file name with nothing a file system rejects. */
const safeName = (s: string): string => [...s].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch)).join('').trim() || 'export';

/** Output size for a preset. Video encoders need even dimensions. */
export function outputSize(project: Project, s: ExportSettings): { width: number; height: number } {
  const seq = getSequence(project);
  const preset = PRESETS.find((p) => p.id === s.preset);
  if (!preset) throw new EditError('Unknown export preset.');
  const size = s.preset === 'custom' ? { width: s.width ?? 0, height: s.height ?? 0 } : (preset.size ?? { width: seq.width, height: seq.height });
  if (!(size.width >= 16 && size.height >= 16 && size.width <= 8192 && size.height <= 8192)) throw new EditError('The export size must be between 16 and 8192 pixels each way.');
  return { width: even(size.width), height: even(size.height) };
}

/** Tick of output frame `index` of a job. Preview and export render the same ticks. */
export const jobFrameTick = (job: Pick<ExportJob, 'start' | 'fps'>, index: number): Tick => job.start + frameToTick(index, job.fps);

/**
 * The files an export will write. One job for the whole sequence or the in/out range;
 * one per selected clip or per marker range for batch clipping.
 */
export function planExport(project: Project, s: ExportSettings): ExportJob[] {
  const seq = getSequence(project);
  const { width, height } = outputSize(project, s);
  const end = sequenceEnd(seq);
  let ranges: { start: Tick; end: Tick; label: string }[];
  if (s.range === 'sequence') ranges = [{ start: 0, end, label: '' }];
  else if (s.range === 'inout') {
    if (seq.inPoint === null && seq.outPoint === null) throw new EditError('Set an in or out point first, or export the whole sequence.');
    ranges = [{ start: seq.inPoint ?? 0, end: Math.min(seq.outPoint ?? end, end), label: '' }];
  } else if (s.range === 'clips') {
    const ids = new Set(s.clipIds ?? []);
    const spans = new Map<string, { start: Tick; end: Tick }>();
    // Linked picture and sound are one clip to the user: one file per distinct time span.
    for (const t of seq.tracks) for (const c of t.clips) if (ids.has(c.id)) spans.set(`${c.start}:${clipEnd(c)}`, { start: c.start, end: clipEnd(c) });
    ranges = [...spans.values()].sort((a, b) => a.start - b.start).map((r, i) => ({ ...r, label: `clip ${String(i + 1).padStart(2, '0')}` }));
    if (ranges.length === 0) throw new EditError('Select the clips to export first.');
  } else {
    ranges = seq.markers.filter((m) => m.duration > 0).map((m, i) => ({ start: m.time, end: Math.min(m.time + m.duration, end), label: m.name.trim() || `marker ${String(i + 1).padStart(2, '0')}` }));
    if (ranges.length === 0) throw new EditError('Add markers that span a range first (give a marker a duration).');
  }
  const used = new Set<string>();
  return ranges.map((r) => {
    if (r.end <= r.start) throw new EditError('There is nothing to export in that range.');
    const frameCount = s.format === 'png' ? 1 : Math.max(1, tickToFrame(r.end - r.start, seq.fps, 'ceil'));
    let base = safeName(r.label ? `${s.name} - ${r.label}` : s.name);
    for (let n = 2; used.has(base.toLowerCase()); n++) base = `${safeName(r.label ? `${s.name} - ${r.label}` : s.name)} (${n})`;
    used.add(base.toLowerCase());
    const fpsValue = seq.fps.num / seq.fps.den;
    return {
      fileName: `${base}.${s.format}`, format: s.format, start: r.start, end: s.format === 'png' ? r.start + frameToTick(1, seq.fps) : r.end, width, height, fps: seq.fps,
      sampleRate: seq.sampleRate, frameCount, quality: s.quality,
      videoBitrate: Math.round(Math.min(80_000_000, Math.max(300_000, width * height * fpsValue * BITS_PER_PIXEL[s.quality]))),
      audioBitrate: s.quality === 'low' ? 128_000 : 192_000,
    };
  });
}

/** Media used by the ranges of these jobs that is offline: exporting would bake placeholders into the file. */
export function offlineInJobs(project: Project, jobs: readonly ExportJob[], isOnline: (mediaId: Id) => boolean): string[] {
  const seq = getSequence(project);
  const names = new Set<string>();
  for (const t of seq.tracks) {
    if ((t.kind === 'video' && t.hidden) || (t.kind === 'audio' && t.muted)) continue;
    for (const c of t.clips) {
      if (!c.mediaId || !c.enabled || isOnline(c.mediaId) || !jobs.some((j) => c.start < j.end && clipEnd(c) > j.start)) continue;
      names.add(project.media.find((m) => m.id === c.mediaId)?.name ?? c.mediaId);
    }
  }
  return [...names];
}

/** Estimated time left, from progress so far. Null until there is enough to go on. */
export function eta(done: number, total: number, elapsedMs: number): number | null {
  if (done <= 0 || elapsedMs < 500 || total <= done) return total <= done ? 0 : null;
  return (elapsedMs / done) * (total - done);
}
