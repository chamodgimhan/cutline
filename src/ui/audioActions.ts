// Audio actions that need the engine: loudness measurement, normalise, audio scrub toggle.
import { normaliseGain } from '../core/audio/loudness.ts';
import { EditError } from '../core/command.ts';
import { updateClips } from '../core/commands/clips.ts';
import type { Action } from '../core/editor/actions.ts';
import { sequenceEnd, type Param } from '../core/model.ts';
import { measureClipLoudness, measureLoudness } from '../engine/audioRender.ts';
import type { App } from './app.ts';

const addDb = (p: Param, db: number): Param => (typeof p === 'number' ? p + db : { keys: p.keys.map((k) => ({ ...k, v: k.v + db })) });
const show = (lufs: number): string => (Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : 'silent');

/** Set the gain of each selected audio clip so its own loudness lands on `target` LUFS. One undo step. */
export async function normaliseSelection(app: App, target: number): Promise<void> {
  const s = app.session;
  const clips = s.selectedClips().filter((h) => h.clip.audio);
  if (clips.length === 0) throw new EditError('Select an audio clip first.');
  const change = new Map<string, number>();
  for (const { clip } of clips) {
    // The clip's current gain is part of what we replace, so measure the bare source.
    const measured = await measureClipLoudness(s.project, clip.id, app.media);
    if (Number.isFinite(measured)) change.set(clip.id, normaliseGain(measured, target) - (typeof clip.audio?.gain === 'number' ? clip.audio.gain : 0));
  }
  if (change.size === 0) throw new EditError('The selected audio is silent, so there is nothing to normalise.');
  s.run(() => updateClips(s.project, s.ctx, [...change.keys()], (c) => (c.audio ? { ...c, audio: { ...c.audio, gain: addDb(c.audio.gain, change.get(c.id) ?? 0) } } : c), `Normalise to ${target} LUFS`));
}

export function audioActions(app: App): Action[] {
  const later = (job: () => Promise<void>) => (): void => {
    job().catch((e: unknown) => {
      if (!(e instanceof EditError)) throw e;
      app.session.notify(e.message);
    });
  };
  return [
    ...[-14, -16, -23].map((target): Action => ({ id: `audio.normalise${-target}`, label: `Normalise to ${target} LUFS`, menu: 'Clip', keys: [], run: later(() => normaliseSelection(app, target)) })),
    {
      id: 'audio.measure', label: 'Measure Sequence Loudness', menu: 'Sequence', keys: [],
      run: later(async () => {
        const s = app.session;
        const start = s.seq.inPoint ?? 0;
        const end = s.seq.outPoint ?? sequenceEnd(s.seq);
        if (end <= start) throw new EditError('The sequence is empty.');
        s.notify(`Integrated loudness: ${show(await measureLoudness(s.project, { start, end }, app.media))}`);
      }),
    },
    {
      id: 'play.audioScrub', label: 'Audio Scrub', menu: 'Playback', keys: ['Shift+S'],
      run: () => {
        app.program.transport.scrubAudio = app.source.transport.scrubAudio = !app.program.transport.scrubAudio;
        app.session.emit();
      },
      checked: () => app.program.transport.scrubAudio,
    },
  ];
}
