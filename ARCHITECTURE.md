# Cutline architecture

## Folder map
- `src/theme/theme.ts`: every colour, spacing step, type size. UI reads CSS variables from `themeCssVariables()`.
- `src/core/`: pure editing logic (model, time, commands, history, snapping, project file). No DOM, no node, no UI imports (lint-enforced).
- `src/media/`: container code, pure TS. `bytes.ts` (ByteWriter, BitWriter, BitReader, hashBytes), `mp4/boxes.ts`, `mp4/muxer.ts`.
- `src/engine/`: browser engine (WebCodecs decode/encode, compositor, audio). Not yet created.
- `src/ui/`: panels and tools. Not yet created.
- `tools/fixtures/`: test media generator (never shipped). `h264pcm.ts` lossless H.264 (I_PCM + P_Skip), `frame.ts` test picture + counter reader, `build.ts` specs, `generate.ts` CLI.
- `tools/smoke/`: headless Chrome suites through playwright-core and the system Chrome. `run.ts` CLI, one file per phase.
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

## Data model
Defined in Phase 1 (`src/core/model.ts`).
