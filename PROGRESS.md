# Cutline progress

## Phase
Phase 11: Hardening and release (done; tagged 1.0.0)

## Done
- Phases 0-10 complete and committed: scaffold + fixtures; core model/commands/history; demux + decode; compositor + transport; editing UI; audio; effects/transitions/speed/keyframes; titles + captions (SRT/VTT, cue rules, burn-in, bundled Roboto fonts); export (MP4, WebM, PNG, WAV, presets, batch, reframe, queue, dialog); project safety (save/open/recent, autosave + crash recovery, error log, cache limits); licensing (Ed25519 keys, keygen tool, watermark), LICENSE/EULA/third-party notices + audit, Electron shell, Windows installer + portable built (unsigned).
- 235 unit tests; smoke suites phase0, phase2-phase10 green; drift (10 min) green; desktop smoke green on the unpackaged shell and on the packaged app (CUTLINE_PACKAGED=1). Installer exe itself was not run; mac/linux targets are configured but not built here.
- Phase 11 so far: phase11 smoke (workflow with byte-identical re-export after reopen, 50 cycles flat, keyboard pass with focus ring on every stop) green; fuzz 100,000 commands green (npm run fuzz); soak suite written (npm run smoke soak); contrast tests extended (clip fills darkened to 4.5:1 for clip names); inspector shows the picture part of a linked clip; README, tools/testReport.ts (npm run report -> TEST_REPORT.md, SHORTCUTS.md); no TODO/stub/mock outside tests.

## Next step
Build finished (v1.0.0). Sellable folder: node desktop/release.mjs. OPEN, waiting for the owner: Electron ships its own FFmpeg (ffmpeg.dll / libffmpeg.so, LGPL-2.1), which SPEC forbids in the shipped app. Options: accept it (license notice already included), or replace Electron with a shell that uses the system browser engine (e.g. Tauri + WebView2). Other follow-ups: code signing certificate, Mac build on a Mac, legal review of EULA.txt.

## Budgets measured
- Caches: 400 random frames over 8 files held at most 6 decoders and 72 MiB of frames (limit 384 MiB).
- Export: 10 min (14,400 frames, 64x48) in ~55 s, page heap flat (18 -> 23 MiB); MP4 and WebM 40.7-41.0 dB vs preview; audio click exactly on its sample; batch of 20 valid files.
- Audio: mixdown within 0.001 LSB of an independent calculation; largest step at a cut 0.032 (unfaded 0.244); after 50 edits clicks within 0.042 ms of their frame; fixture loudness -14.28 LUFS (reference -14.29).
- Timeline with 2,000 clips: worst frame 24 ms, median 6 ms while scrolling (limit 32); paint script 1.3 ms.
- Render: 2D fallback matches GL at 51-68 dB. 1080p scrub through renderFrame worst 80 ms. 1080p playback 29.2 of 30 fps (software GL). 10-min playback: audio/timeline error 0.02 ms, picture lag 0.12 frames, no drift, 7 frames dropped.
- 2h open: node 125 ms / 1 MB of 444 MB read; browser ~50 ms. 1080p scrub worst 124 ms (limit 150), mean ~80 ms.

## Environment (Phase 0)
- Installed: node 22.22.1, npm 11.12.1, git 2.53, Python 3.14, Chrome and Edge (system). npm registry reachable.
- Not installed: ffmpeg, ffprobe, global tsc. No blocked installs.
- Dev deps: typescript 6, vite 8, vitest 5, eslint 10, typescript-eslint, playwright-core (drives system Chrome), @types/node.

## Known bugs
- Timing checks vary with machine load. Steps: run `npm run smoke soak` and, while it plays, `npm run smoke phase3 phase4`. Seen: 1080p scrub 430 ms (normally 60-120, limit 150); 2,000-clip timeline frame 91 ms (normally under 31, limit 32). Run alone, both pass. Not fixed: the budgets are met on an idle machine; under load the browser is starved, not the code slower.

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
- Workers get media through a SourceSpec (Blob, or URL with range requests). On desktop, media is served same-origin at app://cutline/__media__/<path> (a separate scheme failed fetch from the page); only paths the user picked or a project names are readable.
- Open video decoders are capped at 6, 64 MB of cached frames each; a failed open is cached until the media is relinked.
- UI has no framework: timeline is one canvas, panels are plain DOM built with a small h() helper. Runs of clips narrower than 6 px are painted merged.
- Import refuses files this machine cannot decode, and takes image size from the decoded bitmap (carry-overs from the Phase 3 review, done).
- window.cutline = { app, timeline } is exposed for smoke tests.
- Audio gain is applied per sample in JS before the OfflineAudioContext mix; mono is spread to both sides; track pan uses StereoPannerNode. Meters read the scheduled samples, not an analyser.
- Transitions start at the cut: the outgoing clip runs on into its handle (or holds its last frame) under the incoming one. Canvas 2D fallback draws only exposure/contrast/saturation/blur/flip and shows every transition as a dissolve.
- Pitch keep stretches each 0.4 s audio chunk on its own (marked `shortcut:` in audioRender.ts).
- The inspector rebuilds on change and restores focus and uncommitted text.
- Fonts: Roboto and Roboto Mono are OFL-1.1, Roboto Slab is Apache-2.0; files and licences vendored in assets/fonts (not npm dependencies). VTT cue settings and names are not kept on import.
- Export converts RGB to I420 (BT.709 limited) itself and writes colr / WebM Colour: this machine's H.264 encoder, given RGB, used BT.601 full range but labelled the stream BT.709 limited (30 dB vs preview; 41 dB after). Video is constant-quality (quantizer) where the encoder supports it. Audio is mixed on the main thread and sent to the export worker (no Web Audio in workers).
- Exporting to another shape shows the centre of the sequence (cover); clip.reframe pans/zooms per clip; titles and captions are re-laid-out for the new width.
- Project files on the web go through File System Access (fallback: upload/download); recovery, recents and the error log live in IndexedDB. Importing a file whose content matches an offline asset relinks it. No persistent thumbnail/peak cache: all caches are in memory and bounded.

- Inspector: when the selection is one linked clip (picture + sound), it shows the picture part instead of "2 clips selected".