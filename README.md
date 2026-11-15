# Cutline

A desktop video editor for cutting long footage into finished clips. You import, cut, arrange clips on a multi-track timeline, add titles and captions, do colour and audio work, and export. Cutline runs fully offline: no account and no network calls. The app blocks every outside request, and a test checks this.

Copyright (c) 2026 Chamod Gimhan. All rights reserved. See `LICENSE` and `EULA.txt`.

## Install

- **Windows:** run `Cutline-Setup-1.0.0.exe` (installer) or `Cutline-Portable-1.0.0.exe` (no install). Both builds are unsigned, so Windows SmartScreen asks once before the first run.
- **Make the folder you sell:** `node desktop/release.mjs` writes `release/Cutline-<version>/` with four files (`Cutline.exe`, which runs without installing, READ-ME-FIRST.txt, EULA.txt and the third-party notices) and a zip of it. Add `--linux` for a Linux archive next to it. The Windows installer is still built in `desktop/dist`. The script refuses to finish if anything from `keygen/` would ship.
- **Build the desktop app:** `node desktop/build.mjs` makes the Windows installer and portable build in `desktop/dist`. Add `--mac` or `--linux` on those systems, or `--dir` for an unpacked folder only.
- **Run in a browser (development):** `npm install`, then `npm run dev`, then open the printed address in Chrome or Edge.

## What it does

- **Timeline:** video, audio and caption tracks. Select, razor, ripple, roll, slip and slide tools. Insert, overwrite, lift and extract. Snapping, markers, in/out range, linked clips, undo history.
- **Picture:** transform, crop, opacity, blend modes and keyframes. Effects: exposure, contrast, saturation, temperature and tint, curves, LUT (.cube), blur, sharpen, vignette, chroma key and flip. Transitions, speed changes and freeze frames.
- **Audio:** gain and fades with keyframes, pan, mute and solo, meters, loudness measurement and normalising.
- **Titles and captions:** text layers with bundled fonts (Roboto, Roboto Mono, Roboto Slab). SRT and VTT import and export, cue editing, and burn-in.
- **Export:** MP4 (H.264 + AAC), WebM (VP9 + Opus), PNG frame and WAV audio. Size presets (1080p, 4K, vertical, square, custom) with per-clip reframing. Batch export by selected clips or marker ranges, through an export queue. The app only offers formats this machine can encode.
- **Projects:** `.cutline` files, recent projects, autosave and crash recovery. If a media file has moved, importing it again relinks it by its content. An error log can be exported.
- **Licence:** Help → About and Licence takes an offline licence key. Without a key, exports carry a small Cutline watermark. The owner makes keys with the `keygen` tool (`node keygen/keygen.ts`). That tool is not shipped in the app, and its private key never leaves the owner's machine.

Keyboard shortcuts are listed in [SHORTCUTS.md](SHORTCUTS.md) and in Help → Keyboard Shortcuts, where you can change them.

## Import formats

- **Video and audio in MP4, MOV or M4A:** H.264, HEVC, VP9 and AV1 video, and AAC, MP3, Opus, FLAC and PCM audio. Which codecs work depends on what this machine's WebCodecs can decode, and a file it cannot decode is refused with a message.
- **WAV** audio. **PNG, JPEG and WebP** stills.
- **Not imported:** WebM and MKV containers, fragmented MP4. You get a plain message for each.
- **Captions:** SRT and VTT.

## Not supported in v1

Multicam, motion tracking, plugin hosts (VST, OFX), nested sequences, HDR and 10-bit pipelines, camera RAW, cloud or collaboration features, and bundled AI models. Cutline has no controls for any of these.

## Known limits

- Exported MP4 audio does not signal the AAC encoder delay. Imported AAC without an edit list plays about 44 ms late.
- H.264 sources with B-frames (reordered frames) have not been tested. The test fixtures have none.
- Changing speed with pitch kept stretches each 0.4 s audio chunk on its own, which can be audible on music.
- VTT cue settings and voice names are dropped on import.
- Without WebGL2, preview and export use the Canvas 2D fallback. It draws only exposure, contrast, saturation, blur and flip, and shows every transition as a dissolve.
- The Windows installer and portable builds are unsigned. Only the packaged app folder was launched in tests, not the installer itself. The Linux archive is built on Windows and was not run on Linux. macOS must be built on a Mac (`node desktop/build.mjs --mac`).
- Timing budgets were measured with software rendering (SwiftShader) on one machine. They vary with machine load.
- `EULA.txt` is a template. Have a lawyer review it before selling.

## Development

- `npm run verify`: typecheck, lint and unit tests.
- `npm run smoke [suite…]`: browser smoke suites in headless Chrome. The long runs `drift` and `soak` and the `desktop` suite run only when named.
- `npm run fuzz`: 100,000 random editing commands with invariant checks.
- `npm run report`: runs the unit tests, then writes `TEST_REPORT.md` and `SHORTCUTS.md` from the latest recorded results.
- `npm run fixtures`: builds the generated test media in `fixtures/out`.

The code layout, data model and conventions are described in [ARCHITECTURE.md](ARCHITECTURE.md).
