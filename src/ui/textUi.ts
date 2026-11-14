// Title and caption UI: inspector fields for text, and caption file import/export actions.
import { captionStyle, importCues, parseCaptions, serialiseSrt, serialiseVtt, trackCues, type SpeechProvider } from '../core/captions.ts';
import { EditError } from '../core/command.ts';
import { updateClips } from '../core/commands/clips.ts';
import { addTrack } from '../core/commands/tracks.ts';
import type { Action } from '../core/editor/actions.ts';
import { sequenceEnd, type Clip, type TextProps } from '../core/model.ts';
import { renderAudio } from '../engine/audioRender.ts';
import { FONTS } from '../engine/text.ts';
import { parseHex } from '../theme/theme.ts';
import type { App } from './app.ts';
import { h } from './dom.ts';

/** Offer text as a file to save. */
export function saveTextFile(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Inspector fields for a text or caption clip. */
export function textFields(app: App, c: Clip): HTMLElement[] {
  const s = app.session;
  const t = c.text;
  if (!t) return [];
  const set = (change: Partial<TextProps>, label = 'Edit text'): void => void s.run(() => updateClips(s.project, s.ctx, [c.id], (clip) => (clip.text ? { ...clip, text: { ...clip.text, ...change } } : clip), label));
  const row = (label: string, control: HTMLElement): HTMLElement[] => {
    control.id = `insp-text-${label.replace(/\W+/g, '-').toLowerCase()}`;
    return [h('label', { for: control.id }, label), control];
  };
  const num = (key: keyof TextProps, min: number, max: number, step = 1, scale = 1): HTMLInputElement => {
    const el = h('input', { type: 'number', min: min * scale, max: max * scale, step, value: String(Math.round((t[key] as number) * scale * 100) / 100), onchange: () => {
      const v = Number(el.value) / scale;
      if (Number.isFinite(v)) set({ [key]: Math.min(max, Math.max(min, v)) });
    } });
    return el;
  };
  const colour = (key: keyof TextProps): HTMLInputElement => {
    const el = h('input', { type: 'text', value: t[key] as string, title: 'Colour as #rrggbb, or #rrggbbaa with transparency', onchange: () => {
      try {
        parseHex(el.value.trim());
        set({ [key]: el.value.trim().toLowerCase() });
      } catch {
        s.notify('Write the colour as #rrggbb or #rrggbbaa, for example #ffffff or #00000080.');
      }
    } });
    return el;
  };
  const pick = <K extends keyof TextProps>(key: K, options: readonly (string | number)[]): HTMLSelectElement => {
    const el = h('select', { onchange: () => set({ [key]: typeof t[key] === 'number' ? Number(el.value) : el.value }) }, ...options.map((o) => h('option', { value: String(o), selected: o === t[key] }, String(o))));
    return el;
  };
  const text = h('textarea', { rows: 3, value: t.text, 'aria-label': 'Text', style: 'width:100%;resize:vertical;background:var(--c-bg2);color:inherit;border:1px solid var(--c-line);border-radius:var(--z-radius);font:inherit', onchange: () => set({ text: text.value }) });
  const out = [
    h('h3', {}, c.kind === 'caption' ? 'Caption' : 'Title'), ...row('Text', text),
    ...row('Font', pick('font', FONTS)), ...row('Size', num('size', 6, 600)), ...row('Weight', pick('weight', [400, 700])),
    ...row('Colour', colour('color')), ...row('Align', pick('align', ['left', 'center', 'right'])), ...row('Vertical', pick('valign', ['top', 'middle', 'bottom'])),
    ...row('Safe margin %', num('margin', 0, 0.4, 1, 100)),
    ...row('Stroke colour', colour('strokeColor')), ...row('Stroke width', num('strokeWidth', 0, 40)),
    ...row('Shadow colour', colour('shadowColor')), ...row('Shadow blur', num('shadowBlur', 0, 100)), ...row('Shadow X', num('shadowX', -200, 200)), ...row('Shadow Y', num('shadowY', -200, 200)),
    ...row('Box colour', colour('boxColor')), ...row('Box padding', num('boxPadding', 0, 200)),
  ];
  if (c.kind === 'caption') {
    out.push(h('label', {}, 'Style'), h('button', { 'data-role': 'style-all', title: 'Give every caption on this track this look', onclick: () => {
      const track = s.seq.tracks.find((tr) => tr.clips.some((x) => x.id === c.id));
      if (track) void s.run(() => updateClips(s.project, s.ctx, track.clips.map((x) => x.id), (clip) => (clip.text ? { ...clip, text: { ...t, text: clip.text.text } } : clip), 'Style all captions'));
    } }, 'Apply to all on track'));
  }
  return out;
}

/** The caption track that actions act on: the active one, or the first. */
function captionTrack(app: App): string {
  const s = app.session;
  const track = s.seq.tracks.find((t) => t.kind === 'caption' && t.id === s.activeTrackId) ?? s.seq.tracks.find((t) => t.kind === 'caption');
  if (!track) throw new EditError('There is no caption track yet. Add a caption first.');
  return track.id;
}

export function captionActions(app: App, speech: SpeechProvider | null): Action[] {
  const s = app.session;
  const picker = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt', style: 'display:none', 'data-role': 'caption-import', onchange: () => {
    const f = picker.files?.[0];
    picker.value = '';
    if (f) void f.text().then((text) => importText(text));
  } });
  document.body.append(picker);
  const importText = (text: string): void => {
    try {
      const cues = parseCaptions(text);
      s.history.group('Import captions', () => {
        if (!s.seq.tracks.some((t) => t.kind === 'caption')) s.history.execute(addTrack(s.project, s.ctx, { kind: 'caption' }));
        s.history.execute(importCues(s.project, s.ctx, captionTrack(app), cues, captionStyle()));
      });
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      s.notify(e.message);
    }
  };
  const exportAs = (ext: 'srt' | 'vtt') => (): void => {
    const cues = trackCues(s.project, captionTrack(app));
    if (cues.length === 0) throw new EditError('The caption track is empty.');
    saveTextFile(`${s.seq.name || 'captions'}.${ext}`, ext === 'srt' ? serialiseSrt(cues) : serialiseVtt(cues), ext === 'vtt' ? 'text/vtt' : 'application/x-subrip');
  };
  const actions: Action[] = [
    { id: 'caption.import', label: 'Import Captions (SRT, VTT)…', menu: 'Titles', keys: [], run: () => picker.click() },
    { id: 'caption.exportSrt', label: 'Export Captions as SRT', menu: 'Titles', keys: [], run: exportAs('srt') },
    { id: 'caption.exportVtt', label: 'Export Captions as WebVTT', menu: 'Titles', keys: [], run: exportAs('vtt') },
    {
      id: 'caption.burnIn', label: 'Burn Captions into Picture', menu: 'Titles', keys: [],
      run: () => {
        s.activeTrackId = captionTrack(app);
        app.run('track.hide');
      },
      checked: () => s.seq.tracks.some((t) => t.kind === 'caption' && !t.hidden),
    },
  ];
  // Speech-to-text exists only when a provider has been configured; otherwise there is no control for it at all.
  if (speech) {
    actions.push({ id: 'caption.transcribe', label: `Transcribe with ${speech.name}`, menu: 'Titles', keys: [], run: () => {
      void renderAudio(s.project, { start: 0, end: sequenceEnd(s.seq) }, app.media)
        .then((channels) => speech.transcribe({ sampleRate: s.seq.sampleRate, channels }))
        .then((cues) => importText(serialiseVtt(cues)), () => s.notify('Transcription failed.'));
    } });
  }
  return Object.assign(actions, { importText });
}
