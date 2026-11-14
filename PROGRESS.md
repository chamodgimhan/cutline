# Cutline progress

## Phase
Phase 7: Titles and captions (starting)

## Done
- Setup: CLAUDE.md, SPEC.md, git.
- Phase 0: scaffold, verify, theme, fixture generator (9 fixtures, byte-identical), phase0 smoke (lossless decode in Chrome).
- Phase 1: time, model, commands (27 kinds), history, snapping, project file + v1 migration. 100 unit tests; property test 10,000 sequences x 12 steps green.
- Phase 2: MP4/MOV demuxer, probe (fps, VFR, rotation, WAV, images), fingerprint, MediaLibrary (offline/relink), VideoSource (WebCodecs, bounded cache), AudioSource (PCM + WebCodecs), media worker (peaks, thumbnails). 118 unit tests; phase2 smoke green.
- Phase 3: keyframes, render plan, WebGL2 compositor + Canvas 2D fallback, renderFrame, renderAudio (OfflineAudioContext), audio-clock Transport (play, pause, JKL, step, loop, quality), sourceProject for the source monitor. 140 unit tests; phase3 smoke and 10-minute drift green. Reviewed and audited 2026-11-14.
- Phase 4: editor Session, 62 actions + shortcut map, timeline layout + tool gestures (pure, tested); UI in src/ui (no framework): menus, resizable panels, bin with picker/drag-drop import, source/program monitors, canvas timeline, inspector, meters, history, shortcut editor. 172 unit tests; phase4 smoke green.
- Phase 5: clip gain, fades, keyframed gain, track volume/pan, automatic 128-sample edit crossfade, LUFS meter (BS.1770), normalise, exact peak meters, audio scrub, inspector audio fields. 181 unit tests; phase5 smoke green.
- Phase 6: 11 effects (GL passes, ordered stacks), adjustment clips, 5 video transitions + audio crossfade, speed/reverse/freeze/pitch keep (WSOLA), keyframe lane + inspector sections. 197 unit tests; phase6 smoke green (25 stored hashes in fixtures/effect-hashes.json).

## Next step
Read RESUME.md first. Phase 7 step 1: pure caption code in src/core/captions.ts (SRT + VTT parse/serialise incl. malformed input, cue rules: no overlap, minimum duration, split, merge, shift) with tests; then text rendering (OffscreenCanvas 2D -> layer image for kind 'text' and burned-in captions; bundled open-licence fonts under assets/fonts with licence files), text/caption inspector fields, caption track editing on the timeline (cues are clips of kind 'caption'), SRT/VTT import/export actions, speech-to-text provider interface (control hidden with no provider), phase7 smoke (burned-in caption frame hashes). Compositor already accepts kind 'text' layers via the images map; planFrame must add caption layers when burn-in is on. Carry-over for Phase 8: exported AAC needs its encoder delay removed or signalled; an imported AAC file without an edit list plays about 44 ms late.

## Budgets measured
- Audio: mixdown within 0.001 LSB of an independent calculation; largest step at a cut 0.032 (unfaded 0.244); after 50 edits clicks within 0.042 ms of their frame; fixture loudness -14.28 LUFS (reference -14.29).
- Timeline with 2,000 clips: worst frame 24 ms, median 6 ms while scrolling (limit 32); paint script 1.3 ms.
- Render: 2D fallback matches GL at 51-68 dB. 1080p scrub through renderFrame worst 80 ms. 1080p playback 29.2 of 30 fps (software GL). 10-min playback: audio/timeline error 0.02 ms, picture lag 0.12 frames, no drift, 7 frames dropped.
- 2h open: node 125 ms / 1 MB of 444 MB read; browser ~50 ms. 1080p scrub worst 124 ms (limit 150), mean ~80 ms.

## Environment (Phase 0)
- Installed: node 22.22.1, npm 11.12.1, git 2.53, Python 3.14, Chrome and Edge (system). npm registry reachable.
- Not installed: ffmpeg, ffprobe, global tsc. No blocked installs.
- Dev deps: typescript 6, vite 8, vitest 5, eslint 10, typescript-eslint, playwright-core (drives system Chrome), @types/node.

## Known bugs
- Timing checks vary with machine load: 1080p scrub once read 430 ms right after another suite (normally 60-120 ms, limit 150); the 2,000-clip frame once read 91 ms (normally under 31, limit 32). Re-run the suite alone to confirm.

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
- UI has no framework: timeline is one canvas, panels are plain DOM built with a small h() helper. Runs of clips narrower than 6 px are painted merged.
- Import refuses files this machine cannot decode, and takes image size from the decoded bitmap (carry-overs from the Phase 3 review, done).
- window.cutline = { app, timeline } is exposed for smoke tests.
- Audio gain is applied per sample in JS before the OfflineAudioContext mix; mono is spread to both sides; track pan uses StereoPannerNode. Meters read the scheduled samples, not an analyser.
- Transitions start at the cut: the outgoing clip runs on into its handle (or holds its last frame) under the incoming one. Canvas 2D fallback draws only exposure/contrast/saturation/blur/flip and shows every transition as a dissolve.
- Pitch keep stretches each 0.4 s audio chunk on its own (marked `shortcut:` in audioRender.ts).
- The inspector rebuilds on change and restores focus and uncommitted text.
