// .cutline project files: JSON with a schema version, migrated forward on load.
import { checkInvariants } from './invariants.ts';
import { makeClip, makeSequence, makeTrack, type Clip, type MediaAsset, type Project, type Sequence, type Track } from './model.ts';

export const SCHEMA_VERSION = 2;
export const FILE_EXTENSION = '.cutline';

/** Thrown for any file that cannot be opened. The message is safe to show to the user. */
export class ProjectFileError extends Error {
  override name = 'ProjectFileError';
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/**
 * v1 (pre-release): one sequence, flat media entries, clips as {media, start, in, out},
 * tracks with `type`. v2: sequences array, nested video/audio info, clips with
 * duration/sourceIn/speed and property groups.
 */
function migrate1to2(doc: Json): Json {
  const seq = obj(doc.sequence);
  const media = arr(doc.media).map((raw): MediaAsset => {
    const m = obj(raw);
    const hasVideo = num(m.width) > 0;
    const hasAudio = m.hasAudio === true;
    return {
      id: str(m.id), name: str(m.name), path: str(m.path), fingerprint: str(m.fingerprint), kind: hasVideo ? 'video' : 'audio', duration: num(m.duration),
      video: hasVideo ? { width: num(m.width), height: num(m.height), fps: { num: num(m.fpsNum, 30), den: num(m.fpsDen, 1) }, rotation: 0, vfr: false } : null,
      audio: hasAudio ? { sampleRate: num(m.sampleRate, 48000), channels: num(m.channels, 2) } : null,
    };
  });
  const tracks = arr(seq.tracks).map((raw): Track => {
    const t = obj(raw);
    const kind = t.type === 'audio' ? 'audio' : 'video';
    const track = makeTrack(str(t.id), kind, str(t.name, kind === 'audio' ? 'A' : 'V'));
    track.locked = t.locked === true;
    track.muted = t.muted === true;
    track.clips = arr(t.clips).map((rc): Clip => {
      const c = obj(rc);
      return makeClip({ id: str(c.id), kind, mediaId: str(c.media) || null, start: num(c.start), duration: num(c.out) - num(c.in), sourceIn: num(c.in), name: str(c.name) });
    });
    return track;
  });
  const sequence = makeSequence(str(seq.id, 'seq1'), {
    name: str(seq.name, 'Sequence 1'), width: num(seq.width, 1920), height: num(seq.height, 1080),
    fps: { num: num(seq.fpsNum, 30), den: num(seq.fpsDen, 1) }, sampleRate: num(seq.sampleRate, 48000), tracks,
    markers: arr(seq.markers).map((rm) => {
      const m = obj(rm);
      return { id: str(m.id), time: num(m.time), duration: 0, name: str(m.name), color: 'marker' };
    }),
  });
  const project: Project = { name: str(doc.name, 'Untitled'), media, sequences: [sequence], activeSequenceId: sequence.id };
  return { app: 'cutline', schema: 2, project };
}

const MIGRATIONS: Record<number, (doc: Json) => Json> = { 1: migrate1to2 };

/** Fill in any field a file lacks with its default, so older v2 files keep loading as fields are added. */
function normalize(raw: unknown): Project {
  const p = obj(raw);
  const sequences = arr(p.sequences).map((rs): Sequence => {
    const s = obj(rs);
    const tracks = arr(s.tracks).map((rt): Track => {
      const t = obj(rt);
      const kind = t.kind === 'audio' || t.kind === 'caption' ? t.kind : 'video';
      const base = makeTrack(str(t.id), kind, str(t.name));
      const clips = arr(t.clips).map((rc) => {
        const c = obj(rc) as unknown as Clip;
        return makeClip({ ...c, id: str(c.id), kind: c.kind, start: num(c.start, NaN), duration: num(c.duration, NaN) });
      });
      return { ...base, ...(t as unknown as Partial<Track>), id: base.id, kind, clips };
    });
    const base = makeSequence(str(s.id));
    return { ...base, ...(s as unknown as Partial<Sequence>), id: base.id, tracks, markers: arr(s.markers) as Sequence['markers'] };
  });
  return { name: str(p.name, 'Untitled'), media: arr(p.media) as MediaAsset[], sequences, activeSequenceId: str(p.activeSequenceId) };
}

export function serializeProject(p: Project): string {
  return JSON.stringify({ app: 'cutline', schema: SCHEMA_VERSION, project: p });
}

/** Parse and validate a project file, migrating older versions. Throws ProjectFileError. */
export function parseProject(text: string): Project {
  let doc: Json;
  try {
    doc = obj(JSON.parse(text));
  } catch {
    throw new ProjectFileError('This file is not a Cutline project (it could not be read as project data).');
  }
  if (doc.app !== 'cutline') throw new ProjectFileError('This file is not a Cutline project.');
  let version = num(doc.schema ?? doc.version, NaN);
  if (!Number.isInteger(version) || version < 1) throw new ProjectFileError('This project file has no valid version number.');
  if (version > SCHEMA_VERSION) throw new ProjectFileError('This project was saved by a newer version of Cutline. Update Cutline to open it.');
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new ProjectFileError(`This project uses an old format (version ${version}) that can no longer be converted.`);
    doc = step(doc);
    version++;
  }
  let project: Project;
  let errors: string[];
  try {
    project = normalize(doc.project);
    errors = checkInvariants(project);
  } catch {
    throw new ProjectFileError('This project file is damaged and could not be opened.');
  }
  if (errors.length) throw new ProjectFileError(`This project file is damaged and could not be opened (${errors[0]}).`);
  return project;
}
