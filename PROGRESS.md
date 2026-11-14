# Cutline progress

## Phase
Phase 4: Timeline and editing UI (starting)

## Done
- Setup: CLAUDE.md, SPEC.md, git.
- Phase 0: scaffold, verify, theme, fixture generator (9 fixtures, byte-identical), phase0 smoke (lossless decode in Chrome).
- Phase 1: time, model, commands (27 kinds), history, snapping, project file + v1 migration. 100 unit tests; property test 10,000 sequences x 12 steps green.
- Phase 2: MP4/MOV demuxer, probe (fps, VFR, rotation, WAV, images), fingerprint, MediaLibrary (offline/relink), VideoSource (WebCodecs, bounded cache), AudioSource (PCM + WebCodecs), media worker (peaks, thumbnails). 118 unit tests; phase2 smoke green.
- Phase 3: keyframes, render plan, WebGL2 compositor + Canvas 2D fallback, renderFrame, renderAudio (OfflineAudioContext), audio-clock Transport (play, pause, JKL, step, loop, quality), sourceProject for the source monitor. 140 unit tests; phase3 smoke and 10-minute drift green. Reviewed and audited 2026-11-14.

## Next step
Read RESUME.md first. Phase 4 step 1: app shell (index.html, src/ui/, theme CSS, app state store holding History + MediaLibrary + MediaSources + Transport), then media bin with import (picker + drag-and-drop), then timeline. Carry-overs to do inside Phase 4 import: (a) refuse a file at import when VideoDecoder/AudioDecoder.isConfigSupported is false, with the plain message; (b) take image width/height from the decoded bitmap (EXIF-rotated photos). Carry-over for Phase 8: exported AAC needs its encoder delay removed or signalled (edit list), and an imported AAC file without an edit list plays about 44 ms late.

## Budgets measured
- Render: 2D fallback matches GL at 51-68 dB. 1080p scrub through renderFrame worst 80 ms. 1080p playback 29.2 of 30 fps (software GL). 10-min playback: audio/timeline error 0.02 ms, picture lag 0.12 frames, no drift, 7 frames dropped.
- 2h open: node 125 ms / 1 MB of 444 MB read; browser ~50 ms. 1080p scrub worst 124 ms (limit 150), mean ~80 ms.

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
- Decoder runs with optimizeForLatency; cached frames are copied out of the decoder pool. Seeks decode the GOP and keep only the last 6 frames before the target.
- Import formats v1: MP4/MOV/M4A (H.264, HEVC, VP9, AV1, AAC, MP3, Opus, FLAC, PCM as the machine supports), WAV, PNG/JPEG/WebP. WebM/MKV import refused with a plain message.
- Picker and drag-and-drop UI arrive with the media bin (Phase 4); both call MediaLibrary.importSource, tested in Phase 2.
- Workers get media through a SourceSpec (Blob, or URL with range requests for the desktop file protocol).
- Open video decoders are capped at 6, 64 MB of cached frames each; a failed open is cached until the media is relinked.
- Text and adjustment layers are planned by planFrame but drawn from Phases 6 and 7.
- Monitors: Phase 3 delivers Renderer + Transport + sourceProject; the monitor panels are built in Phase 4.
