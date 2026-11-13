# Cutline progress

## Phase
Phase 2: Media import and decode (starting)

## Done
- Setup: CLAUDE.md, SPEC.md, git.
- Phase 0: scaffold, verify, theme, fixture generator (9 fixtures, byte-identical), phase0 smoke (lossless decode in Chrome).
- Phase 1: time, model, commands (27 kinds), history, snapping, project file + v1 migration. 100 unit tests; property test 10,000 sequences x 12 steps green.

## Next step
Phase 2 step 1: `src/media/mp4/demuxer.ts` (pure TS, range-read source, sample tables, edit lists, rotation, VFR detection) with node tests against fixtures. Then probe, WebCodecs decoder with bounded cache (`src/engine/`), PCM/WebCodecs audio decode, thumbnails/peaks worker, media library with fingerprint + relink, phase2 smoke.

## Environment (Phase 0)
- Installed: node 22.22.1, npm 11.12.1, git 2.53, Python 3.14, Chrome and Edge (system). npm registry reachable.
- Not installed: ffmpeg, ffprobe, global tsc. No blocked installs.
- Dev deps: typescript 6, vite 8, vitest 5, eslint 10, typescript-eslint, playwright-core (drives system Chrome), @types/node.

## Known bugs
None.

## Decisions
- No ffmpeg: fixtures come from a pure-TS lossless H.264 encoder (I_PCM/P_Skip) + own MP4 muxer. Decode is bit-exact, so hashes do not depend on the decoder.
- Fixture audio is PCM (`ipcm`) so sample-accurate tests need no lossy codec. AAC/Opus paths are tested through export round-trips (Phase 8).
- Fixture outputs are git-ignored (long_2h is 465 MB); `fixtures/manifest.json` holds hashes. Unit test rebuilds the small ones in memory; `npm run fixtures -- --check` covers all.
- Added `hd_1080` fixture for the 1080p scrub budget.
- Smoke tests use headless system Chrome with SwiftShader for stable render hashes.
- Own MP4 muxer (reused for export) instead of a dependency.
- Resume checks scheduled with CronCreate (session-only one-shots).
- Commands are lists of before/after ops built by a Draft; invert is mechanical. Caption cues are clips of kind `caption`.
- Move/overwrite replace what they land on. Ripple left-shifts clamp when another track is in the way (partial close) rather than failing.
- Ripple edits do not move markers or locked tracks.
- Project keeps a `sequences` array, UI edits the active one (nested sequences out of scope).
- Media list is kept sorted by id so undo restores exact order.
