// WAV writing: 16-bit PCM header and float-to-PCM conversion, usable in a stream.

/** 44-byte RIFF/WAVE header for `frames` frames of 16-bit PCM. */
export function wavHeader(sampleRate: number, channels: number, frames: number): Uint8Array {
  const data = frames * channels * 2;
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, data, true);
  return b;
}

/** Interleaved little-endian 16-bit PCM from one Float32Array per channel. Values are clipped to -1..1. */
export function floatToPcm16(channels: readonly Float32Array[]): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  const out = new Uint8Array(frames * channels.length * 2);
  const v = new DataView(out.buffer);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c] as Float32Array;
    for (let i = 0; i < frames; i++) {
      const s = Math.max(-1, Math.min(1, ch[i] as number));
      v.setInt16((i * channels.length + c) * 2, Math.round(s * 32767), true);
    }
  }
  return out;
}
