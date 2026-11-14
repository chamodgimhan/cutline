// Time-stretch without changing pitch (WSOLA): overlap-add of windows taken from the
// input at positions nudged to line up with what was just written.

/**
 * Returns audio `speed` times faster (or slower) at the original pitch. All channels get the
 * same alignment, chosen on their sum, so stereo images stay put.
 * Output length is round(input length / speed).
 */
export function timeStretch(channels: readonly Float32Array[], speed: number, sampleRate: number): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  const outLen = Math.round(inLen / speed);
  const out = channels.map(() => new Float32Array(outLen));
  if (inLen === 0 || outLen === 0) return out;
  if (speed === 1) return channels.map((c) => c.slice());
  const N = Math.max(64, Math.round(sampleRate * 0.03) & ~1); // 30 ms window
  const hop = N / 2;
  const reach = N / 4; // how far a window may move to find a match
  const mono = new Float32Array(inLen);
  for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] = (mono[i] as number) + (c[i] as number);
  const window = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let prev = 0; // input position of the previous window
  for (let k = 0; k * hop < outLen; k++) {
    const ideal = Math.round(k * hop * speed);
    let pos = Math.min(Math.max(0, ideal), Math.max(0, inLen - N));
    if (k > 0) {
      // The natural continuation of the last window starts one hop after it: find the candidate most like that.
      const want = prev + hop;
      let best = -Infinity;
      for (let d = -reach; d <= reach; d += 2) {
        const cand = ideal + d;
        if (cand < 0 || cand + N > inLen || want + N > inLen) continue;
        let score = 0;
        for (let i = 0; i < N; i += 4) score += (mono[cand + i] as number) * (mono[want + i] as number);
        if (score > best) {
          best = score;
          pos = cand;
        }
      }
    }
    prev = pos;
    const at = k * hop - hop; // windows are centred so the first half-window is not faded in from nothing
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c] as Float32Array;
      const dst = out[c] as Float32Array;
      for (let i = 0; i < N; i++) {
        const o = at + i;
        if (o < 0 || o >= outLen) continue;
        const s = pos - hop + i;
        dst[o] = (dst[o] as number) + (s >= 0 && s < inLen ? (src[s] as number) : 0) * (window[i] as number);
      }
    }
  }
  return out;
}
