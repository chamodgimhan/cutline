# Cutline test report

Generated 2026-11-15 10:15 UTC from commit 18ca743 by `npm run report`. Machine: Windows_NT 10.0.26200, Intel(R) Core(TM) Ultra 5 125H, 7 GB RAM, node v22.22.1.

## Summary

| Check | Result | Time | Run at |
|---|---|---|---|
| Unit tests (26 files) | 236 of 236 passed | 14.6 s | 2026-11-15 10:15 UTC |
| Fuzz: random commands | passed: 100,000 applied | 6.1 s | 2026-11-15 09:56 UTC |
| Smoke phase0: Fixtures decode in Chrome; frame counters and clicks | passed | 2.8 s | 2026-11-15 09:17 UTC |
| Smoke phase2: Import, probe, decode, VFR, thumbnails, waveforms | passed | 7.3 s | 2026-11-15 09:18 UTC |
| Smoke phase3: Render check (stored frame hashes), playback sync, transport | passed | 41.6 s | 2026-11-15 09:18 UTC |
| Smoke phase4: Editing UI, tools, shortcuts, 2,000-clip timeline budget | passed | 42.4 s | 2026-11-15 09:19 UTC |
| Smoke phase5: Audio mix, meters, loudness | passed | 4.1 s | 2026-11-15 09:19 UTC |
| Smoke phase6: Effects, transitions, speed, keyframes (frame hashes) | passed | 5.8 s | 2026-11-15 09:19 UTC |
| Smoke phase7: Titles and captions | passed | 5.4 s | 2026-11-15 09:19 UTC |
| Smoke phase8: Export: MP4, WebM, PNG, WAV vs preview | passed | 76.1 s | 2026-11-15 09:20 UTC |
| Smoke phase9: Save/open, recovery, relink, cache limits | passed | 21.0 s | 2026-11-15 09:21 UTC |
| Smoke phase10: Licensing, watermark, no network (production build) | passed | 8.1 s | 2026-11-15 09:21 UTC |
| Smoke phase11: End-to-end workflow, 50 cycles, keyboard-only (production build) | passed | 28.8 s | 2026-11-15 09:21 UTC |
| Smoke desktop: Electron shell (packaged app when CUTLINE_PACKAGED=1) | passed | 10.2 s | 2026-11-15 09:25 UTC |
| Smoke drift: 10-minute playback sync | passed | 604.0 s | 2026-11-15 10:07 UTC |
| Smoke soak: 30-minute playback soak: sync and memory | passed | 1805.3 s | 2026-11-15 09:56 UTC |

## Fuzz

100,000 random commands applied (41,777 more were refused as invalid, which is also checked) across 27 command kinds, in 142 chains of up to 1000 steps; largest project 69 clips. After every command all invariants were checked (no overlaps, no negative times, source ranges inside media, unique ids, locked tracks unchanged). Each chain was then saved and reloaded, undone back to its exact start and redone to its exact end.

## Measurements

Lines printed by each smoke suite while it ran.

**phase2**

- [budget] 2h open in browser: 44 ms; seeks 8/4/7/2/5 ms
- [budget] 1080p scrub: worst 99 ms, mean 60 ms (limit 150)

**phase3**

- [info] 2D fallback vs GL: 68/68/53/53/51/54/52 dB
- [budget] 1080p scrub through renderFrame: worst 131 ms, mean 76 ms (limit 150)
- [sync 20 s] 19 clicks, worst audio/timeline error 0.02 ms; picture lag median 0.12 frames (first tenth 0.12, last tenth 0.12); 23.8 fps drawn, 2 dropped
- [fps] 1080p playback: 29.2 fps drawn of 30 (0 dropped), software GL

**phase4**

- [budget] 2,000 clips: paint worst 1.2 ms, mean 0.5 ms; frame interval median 6.1 ms, 0 of 239 over 32 ms, p95 12.2 ms, worst 18.2 ms (one-pixel repaint: 6.2 ms); 252 to 1264 clips drawn per frame (limit 32 ms)

**phase5**

- [audio] mixdown vs independent calculation: worst 0.001 LSB over 96000 samples; at the cut 0.001 LSB
- [audio] largest step at cuts 0.0319 (tone slope 0.0320, an unfaded cut would be 0.2441)
- [audio] seed 11: 50 edits, 15 clips, 49 clicks of 48 expected, worst offset 0.042 ms
- [audio] seed 12: 50 edits, 14 clips, 57 clicks of 57 expected, worst offset 0.042 ms
- [audio] fixture loudness -14.28 LUFS (reference -14.29); normalise -9 dB clip: -23.28 -> -16.00 LUFS

**phase6**

- [speed] 200%: 11 clicks over 6.0 s, worst offset from the picture 0.00 ms
- [speed] 50%: 11 clicks over 24.0 s, worst offset from the picture 0.00 ms
- [speed] reverse: 11 clicks over 12.0 s, worst offset from the picture 0.06 ms
- [speed] 150% reverse: 11 clicks over 8.0 s, worst offset from the picture 0.06 ms
- [speed] 200% keep pitch: 7 clicks over 6.0 s, worst offset from the picture 15.00 ms

**phase8**

- [export] mp4: 48 frames, 2.000 s, 61 KiB, PSNR vs preview 40.9/40.8/40.8/40.7/40.8 dB, click at sample 48000
- [export] webm: 48 frames, 2.000 s, 95 KiB, PSNR vs preview 41.0/41.0/40.9/40.9/41.0 dB, click at sample 48000
- [export] 10-minute export: done, 14400 frames in 61.0 s, file 15.5 MiB; page heap 18.3 -> 21.7 MiB (max 31.0)

**phase9**

- [cache] 400 random frames over 8 files: at most 6 decoders open (limit 6), 72 MiB of frames (limit 384), 40 thumbnails, peaks 1236 of 4096 bytes

**phase10**

- [network] 9 requests in the session; 2 aimed outside the app (the test's own attempts), all stopped by the content security policy; 0 answered from outside

**phase11**

- [workflow] import, cut, 3 captions, colour, export 62020 bytes; reopened export identical: true
- [cycles] after 5 / 50 open-edit-close cycles: heap 3.3 / 3.5 MiB, DOM nodes 423 / 423, listeners 125 / 125
- [keyboard] 70 Tab stops reached none, media, history, source, program, inspector, timeline; 0 without a focus ring

**desktop**

- [desktop] Electron shell launched and passed its smoke test (packaged app from desktop/dist/win-unpacked).

**drift**

- [sync 10 min] 598 clicks, worst audio/timeline error 2.67 ms; picture lag median 0.12 frames (first tenth 0.14, last tenth 0.12); 23.9 fps drawn, 3 dropped

**soak**

- [sync 30 min] 1797 clicks, worst audio/timeline error 2.69 ms; picture lag median 0.12 frames (first tenth 0.12, last tenth 0.12); 24.0 fps drawn, 30 dropped
- [soak 30 min] heap 3.4 -> 3.9 MiB, DOM nodes 31 -> 31, listeners 31 -> 31

## Failures

None in the runs above.

## Known bugs

Copied from PROGRESS.md, each with how to reproduce it.

- Timing checks vary with machine load. Steps: run `npm run smoke soak` and, while it plays, `npm run smoke phase3 phase4`. Seen: 1080p scrub 430 ms (normally 60-120, limit 150); 2,000-clip timeline frame 91 ms (normally under 31, limit 32). Run alone, both pass. Not fixed: the budgets are met on an idle machine; under load the browser is starved, not the code slower.

## Known limits

Copied from the README.

- Exported MP4 audio does not signal the AAC encoder delay. Imported AAC without an edit list plays about 44 ms late.
- H.264 sources with B-frames (reordered frames) have not been tested. The test fixtures have none.
- Changing speed with pitch kept stretches each 0.4 s audio chunk on its own, which can be audible on music.
- VTT cue settings and voice names are dropped on import.
- Without WebGL2, preview and export use the Canvas 2D fallback. It draws only exposure, contrast, saturation, blur and flip, and shows every transition as a dissolve.
- The Windows installer and portable builds are unsigned. Only the packaged app folder was launched in tests, not the installer itself. macOS and Linux targets are configured but were not built or tested.
- Timing budgets were measured with software rendering (SwiftShader) on one machine. They vary with machine load.
- `EULA.txt` is a template. Have a lawyer review it before selling.
