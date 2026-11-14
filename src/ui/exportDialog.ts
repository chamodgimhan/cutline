// Export dialog: settings, destination, and the queue with progress, time left and cancel.
import { EditError } from '../core/command.ts';
import { isLicensed } from '../core/license.ts';
import { FORMAT_LABELS, offlineInJobs, outputSize, planExport, PRESETS, type ExportFormat, type ExportSettings, type Quality, type RangeMode } from '../core/exportPlan.ts';
import { supportedFormats } from '../engine/export/codecs.ts';
import type { Destination, ExportItem } from '../engine/export/queue.ts';
import type { SourceSpec } from '../engine/sourceSpec.ts';
import type { App } from './app.ts';
import { fill, h } from './dom.ts';

const RANGES: [RangeMode, string][] = [['sequence', 'Whole sequence'], ['inout', 'In to out'], ['clips', 'Each selected clip (separate files)'], ['markers', 'Each marker range (separate files)']];
const clock = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Hand a finished in-memory export to the browser as a download. */
function download(item: ExportItem): void {
  if (!item.bytes) return;
  const url = URL.createObjectURL(new Blob([item.bytes as BlobPart]));
  const a = h('a', { href: url, download: item.job.fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  item.bytes = null; // the browser has it now; do not hold a second copy
}

export function openExportDialog(app: App): void {
  const s = app.session;
  const settings: ExportSettings = { format: 'mp4', preset: 'sequence', range: s.seq.inPoint !== null || s.seq.outPoint !== null ? 'inout' : 'sequence', quality: 'medium', name: s.seq.name || 'Export', width: s.seq.width, height: s.seq.height };
  const form = h('div', { class: 'inspector' });
  const list = h('div', { class: 'list', 'data-role': 'export-queue' });
  const note = h('div', { class: 'warn', role: 'alert', style: 'color:var(--c-danger)' });
  let formats: ExportFormat[] = ['png', 'wav'];

  const select = <T extends string>(label: string, options: [T, string][], value: T, set: (v: T) => void): HTMLElement[] => {
    const el = h('select', { id: `exp-${label.toLowerCase().replace(/\W+/g, '-')}`, onchange: () => {
      set(el.value as T);
      void rebuild();
    } }, ...options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
    return [h('label', { for: el.id }, label), el];
  };
  const size = (key: 'width' | 'height'): HTMLElement[] => {
    const el = h('input', { type: 'number', id: `exp-${key}`, min: 16, max: 8192, step: 2, value: String(settings[key] ?? 0), onchange: () => (settings[key] = Number(el.value)) });
    return [h('label', { for: el.id }, key === 'width' ? 'Width' : 'Height'), el];
  };

  async function rebuild(): Promise<void> {
    note.textContent = '';
    try {
      // Offer only what this machine can encode at the chosen size.
      const { width, height } = outputSize(s.project, settings);
      formats = await supportedFormats({ width, height, fps: s.seq.fps, videoBitrate: 8_000_000, sampleRate: s.seq.sampleRate });
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      note.textContent = e.message;
    }
    if (!formats.includes(settings.format)) settings.format = formats[0] as ExportFormat;
    const name = h('input', { type: 'text', id: 'exp-name', value: settings.name, onchange: () => (settings.name = name.value.trim() || 'Export') });
    fill(form,
      ...select('Format', formats.map((f): [ExportFormat, string] => [f, FORMAT_LABELS[f]]), settings.format, (v) => (settings.format = v)),
      ...select('Size', PRESETS.map((p): [string, string] => [p.id, p.label]), settings.preset, (v) => (settings.preset = v)),
      ...(settings.preset === 'custom' ? [...size('width'), ...size('height')] : []),
      ...select('Range', RANGES, settings.range, (v) => (settings.range = v)),
      ...select('Quality', [['low', 'Low (smaller file)'], ['medium', 'Medium'], ['high', 'High']] as [Quality, string][], settings.quality, (v) => (settings.quality = v)),
      h('label', { for: 'exp-name' }, 'File name'), name);
  }

  async function start(): Promise<void> {
    note.textContent = '';
    try {
      const jobs = planExport(s.project, { ...settings, clipIds: [...s.selection] });
      const offline = offlineInJobs(s.project, jobs, (id) => app.library.status(id) === 'online');
      if (offline.length) throw new EditError(`Relink this media before exporting, or the export would contain placeholders: ${offline.join(', ')}.`);
      const dest = await app.exportDestination(jobs.map((j) => j.fileName));
      if (!dest) return; // the user closed the save dialog
      const media: Record<string, SourceSpec> = {};
      for (const m of s.project.media) {
        const spec = app.spec(m);
        if (spec) media[m.id] = spec;
      }
      // Without a valid licence key the picture carries the Cutline mark.
      app.exports.add(s.project, jobs, media, dest as Destination, false, !isLicensed(app.license));
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      note.textContent = e.message;
    }
  }

  const row = (it: ExportItem): HTMLElement => {
    const pct = it.total ? Math.round((it.done / it.total) * 100) : 0;
    const status = it.state === 'running' ? `${pct}%${it.etaMs !== null ? `, about ${clock(it.etaMs)} left` : ''}` : it.state === 'failed' ? `Failed: ${it.message}` : it.state === 'done' ? `Done (${(it.size / 1048576).toFixed(1)} MB)` : it.state === 'cancelled' ? 'Cancelled' : 'Waiting';
    return h('div', { class: 'r', 'data-state': it.state },
      h('span', {}, it.job.fileName),
      h('progress', { max: 100, value: pct, 'aria-label': `Progress of ${it.job.fileName}` }),
      h('span', { role: 'status' }, status),
      it.state === 'running' || it.state === 'queued' ? h('button', { 'data-role': 'cancel', onclick: () => app.exports.cancel(it.id) }, 'Cancel') : h('span', {}));
  };
  const render = (): void => {
    for (const it of app.exports.items) if (it.state === 'done' && it.bytes) download(it);
    fill(list, ...(app.exports.items.length ? app.exports.items.map(row) : [h('div', { class: 'r' }, h('span', {}, 'Nothing is exporting.'))]));
  };
  const off = app.exports.subscribe(render);

  const back = h('div', { class: 'dialog-back', onpointerdown: (e: Event) => e.target === back && close() },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export' },
      h('h2', {}, 'Export'), h('div', {}, form, note), list,
      h('div', { class: 'foot' },
        h('button', { 'data-role': 'clear', onclick: () => app.exports.clearFinished() }, 'Clear finished'),
        h('button', { 'data-role': 'close', onclick: () => close() }, 'Close'),
        h('button', { 'data-role': 'start', class: 'on', onclick: () => void start() }, 'Export'))));
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    e.stopPropagation(); // keys typed here are not editor shortcuts
  };
  function close(): void {
    // Exports keep running in the queue; the status bar shows them.
    off();
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  }
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  render();
  void rebuild();
}
