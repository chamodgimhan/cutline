// Encoder selection. A format is offered only when this machine can actually encode it.
import type { ExportFormat, ExportJob, Quality } from '../../core/exportPlan.ts';

// H.264 from most to least capable: High 5.1/4.2/4.0, Main 4.0, Baseline 4.0/3.1.
const H264 = ['avc1.640033', 'avc1.64002a', 'avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42e01f'];
const VP9 = ['vp09.00.51.08', 'vp09.00.41.08', 'vp09.00.31.08', 'vp09.00.10.08'];

type Size = Pick<ExportJob, 'width' | 'height' | 'fps' | 'videoBitrate'>;

/** Quantizer per quality setting (lower is better): H.264 runs 0..51, VP9 0..63. */
export const QUANTIZER: Record<'mp4' | 'webm', Record<Quality, number>> = { mp4: { low: 32, medium: 25, high: 16 }, webm: { low: 44, medium: 32, high: 18 } };

export async function videoConfig(format: ExportFormat, job: Size): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || (format !== 'mp4' && format !== 'webm')) return null;
  // Constant quality (a fixed quantizer) first: the picture then looks the same whatever the content.
  // Encoders that cannot do that get a target bitrate instead.
  for (const bitrateMode of ['quantizer', 'variable'] as const) {
    for (const codec of format === 'mp4' ? H264 : VP9) {
      const config: VideoEncoderConfig = {
        codec, width: job.width, height: job.height, framerate: job.fps.num / job.fps.den, latencyMode: 'quality', bitrateMode,
        ...(bitrateMode === 'variable' ? { bitrate: job.videoBitrate } : {}),
        ...(format === 'mp4' ? { avc: { format: 'avc' as const } } : {}),
      };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch {
        // not a configuration this browser understands: try the next
      }
    }
  }
  return null;
}

export async function audioConfig(format: ExportFormat, sampleRate: number, bitrate: number): Promise<AudioEncoderConfig | null> {
  if (typeof AudioEncoder === 'undefined' || (format !== 'mp4' && format !== 'webm')) return null;
  const config: AudioEncoderConfig = { codec: format === 'mp4' ? 'mp4a.40.2' : 'opus', sampleRate, numberOfChannels: 2, bitrate };
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported ? config : null;
  } catch {
    return null;
  }
}

/** The formats to offer for an output of this size and sample rate. */
export async function supportedFormats(job: Size & { sampleRate: number }): Promise<ExportFormat[]> {
  const out: ExportFormat[] = [];
  for (const f of ['mp4', 'webm'] as const) if ((await videoConfig(f, job)) && (await audioConfig(f, job.sampleRate, 192_000))) out.push(f);
  return [...out, 'png', 'wav'];
}
