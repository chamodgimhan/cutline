// Media bin: import by picker or drag-and-drop, thumbnails, offline state and relink, drag to the timeline.
import { EditError } from '../core/command.ts';
import { removeMedia } from '../core/commands/tracks.ts';
import type { MediaAsset } from '../core/model.ts';
import { formatTimecode, TICKS_PER_SECOND } from '../core/time.ts';
import type { App } from './app.ts';
import { fill, framed, h } from './dom.ts';

export const MEDIA_DRAG_TYPE = 'application/x-cutline-media';
const ACCEPT = 'video/*,audio/*,image/*,.mov,.mp4,.m4v,.m4a,.wav';

function describe(m: MediaAsset): string {
  const parts: string[] = [];
  if (m.kind !== 'image') parts.push(formatTimecode(m.duration, m.video?.fps ?? { num: 30, den: 1 }));
  if (m.video) parts.push(`${m.video.width}x${m.video.height}`);
  if (m.video && m.kind === 'video') parts.push(`${(m.video.fps.num / m.video.fps.den).toFixed(2)} fps${m.video.vfr ? ' (variable)' : ''}`);
  if (m.audio) parts.push(`${m.audio.sampleRate / 1000} kHz`);
  return parts.join(' · ');
}

export function binPanel(app: App): { body: HTMLElement; header: HTMLElement[] } {
  const picker = h('input', { type: 'file', multiple: true, accept: ACCEPT, style: 'display:none', 'data-role': 'import', onchange: () => {
    void app.importFiles([...(picker.files ?? [])]);
    picker.value = '';
  } });
  const relinker = h('input', { type: 'file', accept: ACCEPT, style: 'display:none', 'data-role': 'relink' });
  const list = h('div', { class: 'bin' });
  let shown = '';

  const thumb = (m: MediaAsset): HTMLElement => {
    const spec = app.spec(m);
    if (!spec || !m.video || m.kind !== 'video') return h('div', { class: 'ph' });
    const canvas = h('canvas', { width: 128, height: 72 });
    void app.jobs.thumb(m.fingerprint, spec, Math.min(m.duration - 1, TICKS_PER_SECOND), 72).then((bmp) => {
      const ctx = canvas.getContext('2d');
      const w = Math.min(128, (bmp.width * 72) / bmp.height);
      ctx?.drawImage(bmp, (128 - w) / 2, 0, w, 72);
    }, () => undefined);
    return canvas;
  };

  const item = (m: MediaAsset): HTMLElement => {
    const offline = app.library.status(m.id) === 'offline';
    const relink = (): void => {
      relinker.onchange = () => {
        const f = relinker.files?.[0];
        relinker.value = '';
        if (!f) return;
        void app.relink(m.id, f).then((ok) => {
          // Not the original file: let the user decide to replace it anyway.
          if (!ok && app.session.message?.includes('relink anyway') && confirm(`${app.session.message}\n\nRelink "${m.name}" to "${f.name}" anyway?`)) void app.relink(m.id, f, true);
        });
      };
      relinker.click();
    };
    return h(
      'div',
      {
        class: `item${offline ? ' offline' : ''}${app.session.source.mediaId === m.id ? ' sel' : ''}`, draggable: 'true', tabindex: '0', 'data-media': m.id,
        title: 'Double-click to open in the source monitor; drag to the timeline',
        ondragstart: (e: DragEvent) => e.dataTransfer?.setData(MEDIA_DRAG_TYPE, m.id),
        ondblclick: () => app.openSource(m.id),
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && app.openSource(m.id),
      },
      thumb(m),
      h('div', {}, h('strong', {}, m.name), h('small', {}, offline ? 'Media offline' : describe(m))),
      h('div', {},
        offline && h('button', { onclick: relink, title: 'Choose the file for this media' }, 'Relink'),
        h('button', { 'aria-label': `Remove ${m.name}`, title: 'Remove from project', onclick: () => {
          try {
            app.session.history.execute(removeMedia(app.session.project, app.session.ctx, m.id));
          } catch (e) {
            if (!(e instanceof EditError)) throw e;
            app.session.notify(e.message);
          }
        } }, '×')),
    );
  };

  const render = framed(() => {
    const media = app.session.project.media;
    const sig = media.map((m) => `${m.id}:${m.fingerprint}:${app.library.status(m.id)}`).join('|') + '#' + app.session.source.mediaId;
    if (sig === shown) return;
    shown = sig;
    fill(list, ...(media.length ? media.map(item) : [h('div', { class: 'empty' }, 'Import media or drop files here.')]));
  });
  app.session.subscribe(render);
  render();

  const body = h(
    'div',
    {
      style: 'min-height:100%',
      ondragover: (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        list.classList.add('over');
      },
      ondragleave: () => list.classList.remove('over'),
      ondrop: (e: DragEvent) => {
        list.classList.remove('over');
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        void app.importFiles(files);
      },
    },
    list, picker, relinker,
  );
  return { body, header: [h('button', { onclick: () => picker.click(), title: 'Import media files' }, 'Import')] };
}
