// Lossless H.264 encoder for test fixtures only (never shipped in the app).
// Baseline profile, CAVLC. Changed macroblocks are stored as I_PCM, unchanged
// ones as P_Skip, deblocking off. Output decodes bit-exactly on any decoder.
import { BitWriter, ByteWriter } from '../../src/media/bytes.ts';

export interface Yuv420 {
  /** Coded size, multiples of 16. */
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

const I_PCM_IN_I = 25;
const I_PCM_IN_P = 30;

/** Wrap an RBSP in a NAL unit with emulation prevention bytes. */
export function nal(refIdc: number, type: number, rbsp: Uint8Array): Uint8Array {
  const out = new ByteWriter(rbsp.length + 16);
  out.u8((refIdc << 5) | type);
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i] as number;
    if (zeros >= 2 && b <= 3) {
      out.u8(3);
      zeros = 0;
    }
    out.u8(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.finish();
}

export class LosslessH264 {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly width: number;
  readonly height: number;
  private readonly mbW: number;
  private readonly mbH: number;
  private prev: Yuv420 | null = null;
  private frameNum = 0;
  private idrCount = 0;

  constructor(width: number, height: number) {
    if (width % 2 || height % 2) throw new Error('LosslessH264: dimensions must be even');
    this.width = width;
    this.height = height;
    this.mbW = Math.ceil(width / 16);
    this.mbH = Math.ceil(height / 16);
    this.codedWidth = this.mbW * 16;
    this.codedHeight = this.mbH * 16;
  }

  sps(): Uint8Array {
    const b = new BitWriter();
    b.bits(66, 8).bits(0xc0, 8).bits(40, 8); // baseline, constraint_set0/1, level 4.0
    b.ue(0); // seq_parameter_set_id
    b.ue(0); // log2_max_frame_num_minus4
    b.ue(2); // pic_order_cnt_type: output order = decode order
    b.ue(1); // max_num_ref_frames
    b.bit(0); // gaps_in_frame_num_value_allowed_flag
    b.ue(this.mbW - 1).ue(this.mbH - 1);
    b.bit(1); // frame_mbs_only_flag
    b.bit(1); // direct_8x8_inference_flag
    const cropR = (this.codedWidth - this.width) / 2;
    const cropB = (this.codedHeight - this.height) / 2;
    if (cropR || cropB) b.bit(1).ue(0).ue(cropR).ue(0).ue(cropB);
    else b.bit(0);
    b.bit(1); // vui_parameters_present_flag
    b.bit(0).bit(0); // aspect_ratio_info, overscan_info
    b.bit(1).bits(5, 3).bit(0).bit(1).bits(1, 8).bits(1, 8).bits(1, 8); // BT.709, limited range
    b.bit(0).bit(0).bit(0).bit(0).bit(0); // chroma_loc, timing, nal_hrd, vcl_hrd, pic_struct
    b.bit(1); // bitstream_restriction_flag
    b.bit(1).ue(0).ue(0).ue(16).ue(16).ue(0).ue(1); // no reordering, 1 frame buffer
    b.trailing();
    return nal(3, 7, b.finish());
  }

  pps(): Uint8Array {
    const b = new BitWriter();
    b.ue(0).ue(0); // pps id, sps id
    b.bit(0).bit(0); // CAVLC, no field poc
    b.ue(0); // one slice group
    b.ue(0).ue(0); // default active refs
    b.bit(0).bits(0, 2); // no weighted prediction
    b.se(0).se(0).se(0); // qp, qs, chroma offset
    b.bit(1); // deblocking_filter_control_present_flag
    b.bit(0).bit(0); // constrained_intra_pred, redundant_pic_cnt
    b.trailing();
    return nal(3, 8, b.finish());
  }

  private mbChanged(f: Yuv420, p: Yuv420, mx: number, my: number): boolean {
    const w = this.codedWidth;
    for (let r = 0; r < 16; r++) {
      const o = (my * 16 + r) * w + mx * 16;
      for (let c = 0; c < 16; c++) if (f.y[o + c] !== p.y[o + c]) return true;
    }
    const cw = w / 2;
    for (let r = 0; r < 8; r++) {
      const o = (my * 8 + r) * cw + mx * 8;
      for (let c = 0; c < 8; c++) if (f.u[o + c] !== p.u[o + c] || f.v[o + c] !== p.v[o + c]) return true;
    }
    return false;
  }

  private writePcm(b: BitWriter, f: Yuv420, mx: number, my: number): void {
    b.alignZero();
    const w = this.codedWidth;
    const cw = w / 2;
    for (let r = 0; r < 16; r++) {
      const o = (my * 16 + r) * w + mx * 16;
      b.bytes(f.y.subarray(o, o + 16));
    }
    for (const plane of [f.u, f.v]) {
      for (let r = 0; r < 8; r++) {
        const o = (my * 8 + r) * cw + mx * 8;
        b.bytes(plane.subarray(o, o + 8));
      }
    }
  }

  /** Encode one frame. Returns one length-prefixed (AVCC) NAL unit. */
  encode(frame: Yuv420, forceKey = false): { data: Uint8Array; key: boolean } {
    if (frame.width !== this.codedWidth || frame.height !== this.codedHeight) throw new Error('LosslessH264: frame size mismatch');
    const key = forceKey || this.prev === null;
    const b = new BitWriter();
    if (key) this.frameNum = 0;
    b.ue(0); // first_mb_in_slice
    b.ue(key ? 7 : 5); // slice_type: I or P
    b.ue(0); // pps id
    b.bits(this.frameNum, 4);
    if (key) b.ue(this.idrCount++ & 0xffff);
    else b.bit(0).bit(0); // num_ref_idx_active_override, ref_pic_list_modification
    if (key) b.bit(0).bit(0); // no_output_of_prior_pics, long_term_reference
    else b.bit(0); // adaptive_ref_pic_marking_mode_flag
    b.se(0); // slice_qp_delta
    b.ue(1); // disable_deblocking_filter_idc

    let skip = 0;
    for (let my = 0; my < this.mbH; my++) {
      for (let mx = 0; mx < this.mbW; mx++) {
        if (key) {
          b.ue(I_PCM_IN_I);
          this.writePcm(b, frame, mx, my);
        } else if (this.prev && !this.mbChanged(frame, this.prev, mx, my)) {
          skip++;
        } else {
          b.ue(skip).ue(I_PCM_IN_P);
          skip = 0;
          this.writePcm(b, frame, mx, my);
        }
      }
    }
    if (!key && skip > 0) b.ue(skip);
    b.trailing();
    const unit = nal(key ? 3 : 2, key ? 5 : 1, b.finish());
    this.frameNum = (this.frameNum + 1) & 15;
    this.prev = { width: frame.width, height: frame.height, y: frame.y.slice(), u: frame.u.slice(), v: frame.v.slice() };
    const out = new ByteWriter(unit.length + 4).u32(unit.length).bytes(unit).finish();
    return { data: out, key };
  }
}
