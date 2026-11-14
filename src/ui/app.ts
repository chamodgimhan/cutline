// Application hub: owns the session and the engine, routes actions and keys, builds the window.
import { ACTIONS, type Action } from '../core/editor/actions.ts';
import { Session } from '../core/editor/session.ts';
import { comboOf, isTypingTarget, ShortcutMap, type Overrides } from '../core/editor/shortcuts.ts';
import { EditError } from '../core/command.ts';
import { addMedia, updateMedia } from '../core/commands/tracks.ts';
import { getMedia, makeProject, makeSequence, makeTrack, type Id, type MediaAsset, type Project } from '../core/model.ts';
import { sourceProject } from '../core/monitor.ts';
import { importMedia } from '../engine/importMedia.ts';
import { MediaJobs } from '../engine/mediaJobs.ts';
import { MediaSources } from '../engine/mediaSources.ts';
import { Renderer } from '../engine/renderer.ts';
import type { SourceSpec } from '../engine/sourceSpec.ts';
import { Transport } from '../engine/transport.ts';
import { MediaLibrary } from '../media/library.ts';
import { BlobSource, MediaError } from '../media/source.ts';
import { load, save } from './dom.ts';

export function newProject(): Project {
  const seq = makeSequence('seq1');
  seq.tracks = [makeTrack('v1', 'video', 'V1'), makeTrack('v2', 'video', 'V2'), makeTrack('a1', 'audio', 'A1'), makeTrack('a2', 'audio', 'A2')];
  return makeProject(seq);
}

export interface MonitorEngine {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  transport: Transport;
}

export class App {
  readonly session: Session;
  readonly library = new MediaLibrary();
  readonly media: MediaSources;
  readonly jobs = new MediaJobs();
  readonly shortcuts: ShortcutMap;
  readonly program: MonitorEngine;
  readonly source: MonitorEngine;
  /** Every action: the core registry plus ones that need the window (dialogs), which the UI adds. */
  readonly actions: Action[] = [...ACTIONS];
  /** Id of the last action run, however it was triggered. */
  lastAction: string | null = null;
  private readonly blobs = new Map<Id, Blob>();
  private sourceProj: { id: Id; project: Project } | null = null;

  constructor(project: Project = newProject()) {
    this.media = new MediaSources(this.library);
    this.session = new Session(project);
    this.program = this.engine(() => this.session.project);
    this.source = this.engine(() => this.sourceProjectNow());
    this.session.clock = this.program.transport;
    this.shortcuts = new ShortcutMap(this.actions, load<Overrides>('cutline.shortcuts', {}));
    this.program.transport.subscribe(() => this.session.emit());
    this.source.transport.subscribe(() => {
      this.session.source.playhead = this.source.transport.playhead;
      this.session.emit();
    });
    this.library.subscribe(() => {
      this.program.transport.refresh();
      this.session.emit();
    });
  }

  private engine(getProject: () => Project): MonitorEngine {
    const canvas = document.createElement('canvas');
    const renderer = new Renderer(canvas, this.media);
    return { canvas, renderer, transport: new Transport({ getProject, renderer, media: this.media }) };
  }

  sourceProjectNow(): Project {
    const asset = getMedia(this.session.project, this.session.source.mediaId);
    if (!asset) return newProject();
    if (this.sourceProj?.id !== asset.id || this.sourceProj.project.media[0] !== asset) this.sourceProj = { id: asset.id, project: sourceProject(asset) };
    return this.sourceProj.project;
  }

  /** Show a media file in the source monitor. */
  openSource(mediaId: Id): void {
    this.source.transport.pause();
    this.session.source = { mediaId, inPoint: null, outPoint: null, playhead: 0 };
    this.session.focus = 'source';
    this.source.transport.seek(0);
    this.source.transport.refresh();
    this.session.emit();
  }

  /** Run an action by id. Playback actions go to the source monitor while it has focus. */
  run(id: string): void {
    const action = this.actions.find((a) => a.id === id);
    if (!action) return;
    this.lastAction = id;
    let target: Session = this.session;
    if (this.session.focus === 'source' && id.startsWith('play.')) {
      const proj = this.sourceProjectNow();
      target = Object.create(this.session, { clock: { value: this.source.transport, writable: true }, project: { get: () => proj }, seq: { get: () => proj.sequences[0] } }) as Session;
    }
    try {
      action.run(target);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      this.session.notify(e.message);
    }
  }

  /** Global key handler. Returns true when the key ran an action. */
  key(e: KeyboardEvent): boolean {
    if (isTypingTarget(e.target as HTMLElement | null)) return false;
    const combo = comboOf(e);
    const id = combo && this.shortcuts.actionFor(combo);
    if (!id) return false;
    e.preventDefault();
    this.run(id);
    return true;
  }

  saveShortcuts(): void {
    save('cutline.shortcuts', this.shortcuts.toJSON());
  }

  /** Where the worker can read a media file from, or null when it is offline. */
  spec(asset: MediaAsset): SourceSpec | null {
    const blob = this.blobs.get(asset.id);
    return blob && this.library.status(asset.id) === 'online' ? { kind: 'blob', blob } : null;
  }

  /** Import files chosen in the picker or dropped on the bin. Each failure is reported; the rest still import. */
  async importFiles(files: readonly File[]): Promise<void> {
    const assets: MediaAsset[] = [];
    const problems: string[] = [];
    for (const file of files) {
      const id = this.session.newId();
      try {
        const path = (file as File & { path?: string }).path || file.name;
        assets.push(await importMedia(this.library, this.media, new BlobSource(file), id, file.name, path));
        this.blobs.set(id, file);
      } catch (e) {
        if (!(e instanceof MediaError)) throw e;
        problems.push(`${file.name}: ${e.message}`);
      }
    }
    if (assets.length) this.session.run(() => addMedia(this.session.project, this.session.ctx, assets));
    if (problems.length) this.session.notify(problems.join(' '));
  }

  /** Reconnect an offline asset to a chosen file. A different file is refused unless `force`. */
  async relink(mediaId: Id, file: File, force = false): Promise<boolean> {
    const asset = getMedia(this.session.project, mediaId);
    if (!asset) return false;
    try {
      const path = (file as File & { path?: string }).path || file.name;
      const change = await this.library.relink(asset, new BlobSource(file), path, force);
      try {
        this.session.history.execute(updateMedia(this.session.project, this.session.ctx, mediaId, change));
      } catch (e) {
        this.library.detach(mediaId); // the project refused the file (too short for its clips): stay offline
        throw e;
      }
      this.blobs.set(mediaId, file);
      return true;
    } catch (e) {
      if (!(e instanceof MediaError) && !(e instanceof EditError)) throw e;
      this.session.notify(e.message);
      return false;
    }
  }
}
