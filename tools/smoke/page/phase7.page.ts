// Phase 7 page-side checks: titles and burned-in captions rendered to pixels.
import { captionStyle } from '../../../src/core/captions.ts';
import { makeKey } from '../../../src/core/keyframes.ts';
import { defaultTextProps, defaultVideoProps, makeClip, makeProject, makeSequence, makeTrack, type Clip, type Project, type TextProps } from '../../../src/core/model.ts';
import { TICKS_PER_SECOND as S } from '../../../src/core/time.ts';
import { Renderer } from '../../../src/engine/renderer.ts';
import { hashBytes } from '../../../src/media/bytes.ts';
import { App } from '../../../src/ui/app.ts';
import { captionActions } from '../../../src/ui/textUi.ts';
import { makeEngine } from './setup.ts';

const W = 640;
const H = 360;

/** Bounding box of the pixels that differ between two frames, as fractions of the frame. Null when identical. */
function changedBox(a: Uint8Array, b: Uint8Array, w: number, h: number): [number, number, number, number] | null {
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs((a[i] as number) - (b[i] as number)) + Math.abs((a[i + 1] as number) - (b[i + 1] as number)) + Math.abs((a[i + 2] as number) - (b[i + 2] as number)) > 12) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h];
}

export async function titles(): Promise<Record<string, { hash: string; box: number[] | null }>> {
  const eng = await makeEngine(['clip_24']);
  const r = new Renderer(new OffscreenCanvas(1, 1), eng.media);
  const base = makeClip({ id: 'v', kind: 'video', mediaId: 'clip_24', start: 0, duration: 2 * S });
  const build = (title: Clip | null, caption: Clip | null, hidden = false): Project => {
    const seq = makeSequence('seq', { width: W, height: H, fps: { num: 24, den: 1 } });
    seq.tracks = [{ ...makeTrack('V1', 'video', 'V1'), clips: [base] }, { ...makeTrack('V2', 'video', 'V2'), clips: title ? [title] : [] }, { ...makeTrack('C1', 'caption', 'C1'), hidden, clips: caption ? [caption] : [] }];
    const p = makeProject(seq);
    p.media = eng.assets;
    return p;
  };
  const text = (props: Partial<TextProps>, extra: Partial<Clip> = {}): Clip => makeClip({ id: 't', kind: 'text', start: 0, duration: 2 * S, text: { ...defaultTextProps('Cutline Title'), size: 40, ...props }, ...extra });
  const cue = (t: string): Clip => makeClip({ id: 'c', kind: 'caption', start: 0, duration: 2 * S, text: { ...captionStyle(), size: 24, text: t } });
  const render = async (p: Project, scale: 1 | 0.5 = 1, at = S / 2): Promise<Uint8Array> => {
    await r.renderFrame(p, at, scale);
    return r.readPixels();
  };
  const out: Record<string, { hash: string; box: number[] | null }> = {};
  const shot = async (name: string, p: Project, scale: 1 | 0.5 = 1, at = S / 2): Promise<void> => {
    const px = await render(p, scale, at);
    const bare = await render(build(null, null), scale, at); // the same moment without any text
    out[name] = { hash: hashBytes(px), box: changedBox(px, bare, W * scale, H * scale) };
  };
  await shot('plain', build(null, null));
  await shot('title.default', build(text({}), null));
  await shot('title.topLeft', build(text({ align: 'left', valign: 'top', font: 'Roboto Slab', weight: 700 }), null));
  await shot('title.bottomRight', build(text({ align: 'right', valign: 'bottom', font: 'Roboto Mono', margin: 0.1 }), null));
  await shot('title.styled', build(text({ color: '#ffd400', strokeColor: '#000000', strokeWidth: 3, shadowColor: '#000000c0', shadowBlur: 6, shadowX: 4, shadowY: 4, boxColor: '#20304080', boxPadding: 16 }), null));
  await shot('title.wrapped', build(text({ text: 'A long title that has to wrap onto several lines to stay inside the safe margins of the frame', size: 48 }), null));
  // Animation through keyframes: the title fades and grows.
  const moving = text({}, { video: { ...defaultVideoProps(), opacity: { keys: [makeKey(0, 0), makeKey(S, 1)] }, scale: { keys: [makeKey(0, 0.5), makeKey(S, 1.5)] } } });
  await shot('title.animated.early', build(moving, null), 1, S / 4);
  await shot('title.animated.late', build(moving, null), 1, S);
  await shot('caption.burnedIn', build(null, cue('A burned-in caption\non two lines')));
  await shot('caption.half', build(null, cue('A burned-in caption\non two lines')), 0.5);
  await shot('caption.hiddenTrack', build(null, cue('Not burned in'), true));
  await shot('caption.overTitle', build(text({ valign: 'top' }), cue('Both at once')));
  r.dispose();
  eng.media.dispose();
  return out;
}

/** The speech-to-text control exists only when a provider is configured. */
export function speechControl(): { without: boolean; with: boolean } {
  const app = new App();
  const ids = (list: { id: string }[]): boolean => list.some((a) => a.id === 'caption.transcribe');
  return { without: ids(captionActions(app, null)), with: ids(captionActions(app, { name: 'Test', transcribe: async () => [] })) };
}
