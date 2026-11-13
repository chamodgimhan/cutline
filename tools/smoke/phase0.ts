// Phase 0 smoke: the fixture encoder's H.264 stream decodes bit-exactly in WebCodecs.
import { hashBytes } from '../../src/media/bytes.ts';
import { drawFrame, visibleI420 } from '../fixtures/frame.ts';
import { LosslessH264 } from '../fixtures/h264pcm.ts';
import { blankPage, launch } from './browser.ts';

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const browser = await launch();
  try {
    const page = await blankPage(browser);
    for (const [w, h] of [[320, 180], [64, 48]] as const) {
      const enc = new LosslessH264(w, h);
      const sps = enc.sps();
      const pps = enc.pps();
      const count = 5;
      const samples: string[] = [];
      const expected: string[] = [];
      for (let n = 0; n < count; n++) {
        const f = drawFrame(w, h, n);
        samples.push(Buffer.from(enc.encode(f, n === 0).data).toString('base64'));
        expected.push(hashBytes(visibleI420(f, w, h)));
      }
      const got = await page.evaluate(
        async ({ sps, pps, samples, w, h }) => {
          const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
          const s = b64(sps);
          const p = b64(pps);
          const desc = new Uint8Array(11 + s.length + p.length);
          desc.set([1, s[1]!, s[2]!, s[3]!, 0xff, 0xe1, s.length >> 8, s.length & 255]);
          desc.set(s, 8);
          desc.set([1, p.length >> 8, p.length & 255], 8 + s.length);
          desc.set(p, 11 + s.length);
          const frames: number[][] = [];
          const errors: string[] = [];
          const pending: Promise<void>[] = [];
          const dec = new VideoDecoder({
            output: (frame) => {
              pending.push(
                (async () => {
                  const raw = new Uint8Array(frame.allocationSize());
                  await frame.copyTo(raw);
                  let buf = raw;
                  if (frame.format === 'NV12') {
                    const ySize = frame.displayWidth * frame.displayHeight;
                    const cSize = ySize / 4;
                    buf = new Uint8Array(ySize + 2 * cSize);
                    buf.set(raw.subarray(0, ySize));
                    for (let i = 0; i < cSize; i++) {
                      buf[ySize + i] = raw[ySize + 2 * i]!;
                      buf[ySize + cSize + i] = raw[ySize + 2 * i + 1]!;
                    }
                  } else if (frame.format !== 'I420') {
                    errors.push('unexpected pixel format ' + frame.format);
                  }
                  frames.push([frame.displayWidth, frame.displayHeight, ...buf]);
                  frame.close();
                })(),
              );
            },
            error: (e) => errors.push(String(e)),
          });
          dec.configure({ codec: 'avc1.42c028', codedWidth: w, codedHeight: h, description: desc, hardwareAcceleration: 'prefer-software' });
          samples.forEach((smp, i) => dec.decode(new EncodedVideoChunk({ type: i === 0 ? 'key' : 'delta', timestamp: i * 1000, data: b64(smp) })));
          await dec.flush();
          await Promise.all(pending);
          return { frames, errors };
        },
        { sps: Buffer.from(sps).toString('base64'), pps: Buffer.from(pps).toString('base64'), samples, w, h },
      );
      if (got.errors.length) failures.push(`${w}x${h}: decoder error ${got.errors.join('; ')}`);
      if (got.frames.length !== count) failures.push(`${w}x${h}: decoded ${got.frames.length} of ${count} frames`);
      got.frames.forEach((f, i) => {
        if (f[0] !== w || f[1] !== h) failures.push(`${w}x${h} frame ${i}: size ${f[0]}x${f[1]}`);
        if (hashBytes(Uint8Array.from(f.slice(2))) !== expected[i]) failures.push(`${w}x${h} frame ${i}: pixels differ from source`);
      });
    }
  } finally {
    await browser.close();
  }
  return failures;
}
