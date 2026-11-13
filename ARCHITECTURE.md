# Cutline architecture

## Folder map
- `src/theme/theme.ts`: every colour, spacing step, type size. UI reads CSS variables from `themeCssVariables()`.
- `src/core/`: pure editing logic (model, time, commands, history, snapping, project file). No DOM, no node, no UI imports (lint-enforced).
- `src/media/`: container code, pure TS. `bytes.ts` (ByteWriter, BitWriter, BitReader, hashBytes), `mp4/boxes.ts`, `mp4/muxer.ts`.
- `src/media/` also: `source.ts` (ByteSource, MediaError, fingerprint), `mp4/parse.ts` + `mp4/demuxer.ts` (Mp4File, sampleAtTime, keyBefore), `pcm.ts`, `probe.ts`, `library.ts` (MediaLibrary: online/offline, relink), `peaks.ts` (PeakBuilder, ByteCache).
- `src/engine/`: browser only. `videoSource.ts` (frame(index)/frameAt(tick), caller closes frames), `audioSource.ts` (read(first, count) floats), `mediaWorker.ts` + `mediaJobs.ts` (peaks, thumbs), `sourceSpec.ts`, `draw2d.ts`.
- `src/ui/`: panels and tools. Not yet created.
- `tools/fixtures/`: test media generator (never shipped). `h264pcm.ts` lossless H.264 (I_PCM + P_Skip), `frame.ts` test picture + counter reader, `build.ts` specs, `generate.ts` CLI.
- `tools/smoke/`: headless Chrome suites (playwright-core + system Chrome). `run.ts` CLI, `server.ts` (Vite dev server + harness page), `phaseN.ts` node side, `page/phaseN.page.ts` page side exposed as `window.T`.
- `fixtures/manifest.json`: committed sizes, sha256 and frame hashes. `fixtures/out/` is generated and git-ignored.

## Conventions
- TypeScript strict, erasable syntax only (no enums, no parameter properties); imports carry the `.ts` extension so node runs sources directly.
- Tests sit next to sources as `*.test.ts` (vitest, node environment).
- `npm run verify` = tsc + eslint + vitest. `npm run fixtures -- --check` regenerates all fixtures and compares to the manifest. `npm run smoke [suite]` runs browser suites.
- Frame hashes use `hashBytes` (16 hex chars) over visible I420 bytes (Y, U, V packed).

## Fixtures
- Video: H.264 baseline, lossless, BT.709 limited range, counter top-left (6 digits, 5x7 font, scale = width/80), bar moving `2*scale` px per frame in the lower half, quadrant chroma tints.
- Audio: s16le PCM in `ipcm`, 1 kHz tone (L 8000, R 4000 amplitude), one-sample click of 30000 on each whole second.
- `long_2h`: 64x48, 24 fps, mono 16 kHz, moov at end, 465 MB.

## Data model (`src/core/model.ts`)
- `Project { name, media[], sequences[], activeSequenceId }`; `Sequence { width, height, fps: Rational, sampleRate, tracks[], markers[], inPoint, outPoint }`.
- `Track { kind: video|audio|caption, locked, muted, solo, hidden, volume, pan, clips[] }`. Clips sorted by start, never overlapping. Later video tracks draw on top.
- `Clip { kind: video|audio|text|adjust|caption, mediaId, start, duration, sourceIn, speed: Rational, reverse, freeze, linkId, video, audio, text, effects[], transitionIn/Out }`. Source out is derived (`clipSourceOut`). A caption cue is a `caption` clip, so cues ripple with every edit.
- `Param = number | { keys: Keyframe[] }`; keyframe times are relative to clip start.
- All times are integer ticks (`time.ts`, 705,600,000/s). `mulDiv` (BigInt) for every scaled conversion.

## Core modules (`src/core/`)
- `command.ts`: `Op` (before/after primitive), `Command { apply(project), invert() }`, `EditError` (user-safe message).
- `draft.ts`: `Draft` scratch copy of a sequence; edit functions mutate it, `build(label)` diffs to a Command and validates with `checkInvariants`. Refuses locked tracks.
- `clipmath.ts`: resizeHead/resizeTail/splitClipAt/headRoom/tailRoom/slipRange (speed, reverse, freeze aware).
- `commands/clips.ts` (add, remove, move, split, update, link), `commands/trim.ts` (trim, rippleTrim, roll, slip, slide), `commands/range.ts` (insert, overwrite, lift, extract, rippleDelete), `commands/tracks.ts` (tracks, markers, sequence, media, project). Signature: `(project, ctx: {newId, seqId?}, args) => Command`.
- `history.ts`: `History` (execute, undo, redo, groups, dirty, jumpTo, subscribe). `snap.ts`: pure snapping. `projectFile.ts`: `.cutline` JSON, schema 2, migrations, `normalize` fills defaults.
- `invariants.ts`, `fuzz.ts` (random projects/commands), `testkit.ts`, `testrun.ts` (test helpers).

## Edit rules
- Move and overwrite replace what they land on. Ripple edits shift later clips on every unlocked track; a left shift is clamped by clips in the way. Linked clips follow unless `linked: false`; a linked partner on a locked track blocks the edit.
