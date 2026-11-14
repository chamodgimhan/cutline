// Integrated loudness (LUFS) after ITU-R BS.1770: K-weighting, 400 ms blocks with
// 75 % overlap, absolute gate at -70 LUFS and relative gate 10 LU below the ungated level.

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** K-weighting stages for any sample rate, from the standard's analogue prototypes. */
function kWeighting(rate: number): [Biquad, Biquad] {
  // Stage 1: high shelf (+4 dB above ~1.5 kHz) modelling the head.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  // Stage 2: high-pass at ~38 Hz.
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / rate);
  const d = 1 + K1 / Q1 + K1 * K1;
  const high = { b0: 1, b1: -2, b2: 1, a1: (2 * (K1 * K1 - 1)) / d, a2: (1 - K1 / Q1 + K1 * K1) / d };
  return [shelf, high];
}

const lufs = (meanSquare: number): number => -0.691 + 10 * Math.log10(meanSquare);

/** Feed audio in any block sizes, then read the integrated loudness. */
export class LoudnessMeter {
  private readonly stages: [Biquad, Biquad];
  private readonly state: number[][] = []; // per channel: x1, x2, y1, y2 for each stage
  private readonly hop: number;
  private readonly hops: number[] = []; // summed channel energy per 100 ms hop
  private acc = 0;
  private filled = 0;

  constructor(sampleRate: number) {
    this.stages = kWeighting(sampleRate);
    this.hop = Math.round(sampleRate / 10);
  }

  /** Add the next block: one Float32Array per channel (left and right weigh equally). */
  push(channels: readonly Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    while (this.state.length < channels.length) this.state.push([0, 0, 0, 0, 0, 0, 0, 0]);
    const [s1, s2] = this.stages;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) {
        const z = this.state[c] as number[];
        const x = (channels[c] as Float32Array)[i] as number;
        const y = s1.b0 * x + s1.b1 * (z[0] as number) + s1.b2 * (z[1] as number) - s1.a1 * (z[2] as number) - s1.a2 * (z[3] as number);
        z[1] = z[0] as number;
        z[0] = x;
        z[3] = z[2] as number;
        z[2] = y;
        const w = s2.b0 * y + s2.b1 * (z[4] as number) + s2.b2 * (z[5] as number) - s2.a1 * (z[6] as number) - s2.a2 * (z[7] as number);
        z[5] = z[4] as number;
        z[4] = y;
        z[7] = z[6] as number;
        z[6] = w;
        sum += w * w;
      }
      this.acc += sum;
      if (++this.filled === this.hop) {
        this.hops.push(this.acc / this.hop);
        this.acc = 0;
        this.filled = 0;
      }
    }
  }

  /** Integrated loudness in LUFS. -Infinity for silence or less than 400 ms of audio. */
  integrated(): number {
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= this.hops.length; i++) blocks.push(((this.hops[i] as number) + (this.hops[i + 1] as number) + (this.hops[i + 2] as number) + (this.hops[i + 3] as number)) / 4);
    const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
    const loud = blocks.filter((b) => lufs(b) > -70);
    if (loud.length === 0) return -Infinity;
    const gate = lufs(mean(loud)) - 10;
    const kept = loud.filter((b) => lufs(b) > gate);
    return kept.length ? lufs(mean(kept)) : -Infinity;
  }
}

/** Gain in dB that brings `measured` LUFS to `target`. Zero when there is nothing to measure. */
export const normaliseGain = (measured: number, target: number): number => (Number.isFinite(measured) ? target - measured : 0);
