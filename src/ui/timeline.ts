// Timeline panel: tool buttons, track headers, and the clip canvas with pointer handling.
import { overwriteClips } from '../core/commands/range.ts';
import { beginGesture, cursorFor, type Gesture } from '../core/editor/gestures.ts';
import { hitTest, rows, tickAt, xOf, type Hit, type Metrics } from '../core/editor/layout.ts';
import { TOOLS } from '../core/editor/session.ts';
import { getMedia, type Track } from '../core/model.ts';
import { size } from '../theme/theme.ts';
import type { App } from './app.ts';
import { MEDIA_DRAG_TYPE } from './bin.ts';
import { fill, framed, h } from './dom.ts';
import { openMenu } from './menus.ts';
import { TimelinePainter } from './timelineDraw.ts';

const METRICS: Metrics = { rulerHeight: size.rulerHeight, trackHeight: size.trackHeight, edgeGrab: 6 };
const CLIP_MENU = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate', '-', 'edit.delete', 'edit.rippleDelete', '-', 'clip.split', 'clip.link', 'clip.unlink', 'clip.enable'];
const TRACK_MENU = ['edit.paste', '-', 'track.lock', 'track.mute', 'track.solo', 'track.hide', 'track.up', 'track.down', 'track.delete', '-', 'seq.addVideoTrack', 'seq.addAudioTrack', 'seq.addCaptionTrack'];

export interface TimelineStats {
  /** Duration of the last paint in milliseconds, and how many clips it drew. */
  paintMs: number;
  drawn: number;
}

export function timelinePanel(app: App): { body: HTMLElement; stats: TimelineStats; paintNow: () => void } {
  const s = app.session;
  const canvas = h('canvas', { tabindex: '0', 'aria-label': 'Timeline', 'data-role': 'timeline' });
  const heads = h('div', { class: 'heads' });
  const stats: TimelineStats = { paintMs: 0, drawn: 0 };
  let gesture: Gesture | null = null;
  let headSig = '';

  const paintNow = (): void => {
    const t0 = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    s.view.width = w;
    // Follow the playhead during playback.
    if (app.program.transport.playing && !gesture) {
      const x = xOf(s.playhead, s.view);
      if (x > w - 30 || x < 0) s.view.scrollX = Math.max(0, s.view.scrollX + x - 60);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stats.drawn = painter.paint(ctx, w, hgt, gesture);
    syncHeads();
    stats.paintMs = performance.now() - t0;
  };
  const redraw = framed(paintNow);
  const painter = new TimelinePainter(app, METRICS, redraw);

  const flag = (track: Track, label: string, action: string, on: boolean, title: string): HTMLElement =>
    h('button', { 'aria-pressed': String(on), title, 'data-flag': action, onclick: (e: Event) => {
      e.stopPropagation();
      s.activeTrackId = track.id;
      app.run(action);
    } }, label);

  function syncHeads(): void {
    const list = rows(s.seq, METRICS);
    const sig = list.map((r) => `${r.track.id}${r.track.name}${+r.track.locked}${+r.track.muted}${+r.track.solo}${+r.track.hidden}`).join('|') + s.activeTrackId;
    if (sig !== headSig) {
      headSig = sig;
      fill(heads, ...list.map((r) => {
        const t = r.track;
        return h(
          'div',
          {
            class: `head${t.id === s.activeTrackId ? ' active' : ''}`, 'data-track': t.id, 'data-y': r.y,
            onclick: () => {
              s.activeTrackId = t.id;
              s.emit();
            },
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              s.activeTrackId = t.id;
              openMenu(app, e.clientX, e.clientY, TRACK_MENU);
            },
          },
          h('strong', {}, t.name),
          h('div', { class: 'flags' },
            flag(t, 'Lock', 'track.lock', t.locked, 'Lock track'),
            t.kind === 'audio' ? flag(t, 'M', 'track.mute', t.muted, 'Mute') : flag(t, 'Hide', 'track.hide', t.hidden, 'Hide track'),
            t.kind === 'audio' && flag(t, 'S', 'track.solo', t.solo, 'Solo')),
        );
      }));
    }
    for (const el of heads.children) (el as HTMLElement).style.top = `${METRICS.rulerHeight + Number((el as HTMLElement).dataset.y) - s.view.scrollY}px`;
  }

  const hitAt = (e: MouseEvent): Hit => {
    const r = canvas.getBoundingClientRect();
    return hitTest(s.seq, s.view, e.clientX - r.left, e.clientY - r.top, METRICS);
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    s.focus = 'timeline';
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    gesture = beginGesture(s, hitAt(e), { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey }, METRICS);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const hit = hitAt(e);
    if (gesture) gesture.move(hit);
    else canvas.style.cursor = cursorFor(s, hit);
    redraw();
  });
  const finish = (cancel: boolean): void => {
    if (!gesture) return;
    if (cancel) gesture.cancel();
    else gesture.end();
    gesture = null;
    redraw();
  };
  canvas.addEventListener('pointerup', () => finish(false));
  canvas.addEventListener('pointercancel', () => finish(true));
  window.addEventListener('keydown', (e) => e.key === 'Escape' && finish(true));
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = hitAt(e);
    if (hit.trackId) s.activeTrackId = hit.trackId;
    if (hit.clip && !s.selection.has(hit.clip.id)) s.select([hit.clip.id]);
    openMenu(app, e.clientX, e.clientY, hit.clip ? CLIP_MENU : TRACK_MENU, canvas);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) s.setZoom(s.view.pxPerSecond * (e.deltaY < 0 ? 1.2 : 1 / 1.2), tickAt(e.clientX - r.left, s.view));
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) s.view.scrollX = Math.max(0, s.view.scrollX + (e.deltaX || e.deltaY));
    else s.view.scrollY = Math.max(0, Math.min(Math.max(0, rows(s.seq, METRICS).length * METRICS.trackHeight - 60), s.view.scrollY + e.deltaY));
    redraw();
  }, { passive: false });

  // Drop a media file from the bin: it overwrites at the drop point on the track under the pointer.
  canvas.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes(MEDIA_DRAG_TYPE)) e.preventDefault();
  });
  canvas.addEventListener('drop', (e) => {
    const asset = getMedia(s.project, e.dataTransfer?.getData(MEDIA_DRAG_TYPE) ?? null);
    if (!asset) return;
    e.preventDefault();
    const hit = hitAt(e);
    const track = s.seq.tracks.find((t) => t.id === hit.trackId);
    s.run(() => {
      const items = s.clipsFromMedia(asset, { inPoint: null, outPoint: null }, track?.kind === 'video' ? track.id : undefined);
      const cmd = overwriteClips(s.project, s.ctx, { at: s.toFrame(hit.tick), items });
      queueMicrotask(() => s.select(items.map((it) => it.clip.id)));
      return cmd;
    });
  });

  const tools = h('div', { class: 'tools', role: 'toolbar', 'aria-label': 'Tools' },
    ...TOOLS.map((tool) => h('button', { 'data-tool': tool, title: `${tool[0]?.toUpperCase()}${tool.slice(1)} tool (${app.shortcuts.keysFor(`tool.${tool}`)[0] ?? ''})`, onclick: () => app.run(`tool.${tool}`) }, tool.slice(0, 2).toUpperCase())),
    h('button', { 'data-role': 'snap', title: 'Snapping (N)', onclick: () => app.run('view.snapping') }, 'SN'));
  const syncTools = (): void => {
    for (const b of tools.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tool ? b.dataset.tool === s.tool : s.snapping));
  };
  s.subscribe(() => {
    syncTools();
    redraw();
  });
  new ResizeObserver(redraw).observe(canvas);
  syncTools();
  return { body: h('div', { class: 'timeline' }, tools, heads, h('div', { class: 'lanes' }, canvas)), stats, paintNow };
}
