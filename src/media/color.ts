// Colour description of encoded video, as the code points containers store (ITU-T H.273).
export interface ColorInfo {
  primaries: string;
  transfer: string;
  matrix: string;
  fullRange: boolean;
}

const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 };
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, linear: 8 };
const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };
const nameOf = (table: Record<string, number>, code: number): string | undefined => Object.keys(table).find((k) => table[k] === code);

/** What an encoder produces from RGB when it does not say: BT.709, limited range. */
export const DEFAULT_COLOR: ColorInfo = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

export const colorCodes = (c: ColorInfo): { primaries: number; transfer: number; matrix: number; fullRange: boolean } => ({
  primaries: PRIMARIES[c.primaries] ?? 1, transfer: TRANSFER[c.transfer] ?? 1, matrix: MATRIX[c.matrix] ?? 1, fullRange: c.fullRange,
});

/** Names for stored code points; null when any of them is one we do not know. */
export function colorFromCodes(primaries: number, transfer: number, matrix: number, fullRange: boolean): ColorInfo | null {
  const [p, t, m] = [nameOf(PRIMARIES, primaries), nameOf(TRANSFER, transfer), nameOf(MATRIX, matrix)];
  return p && t && m ? { primaries: p, transfer: t, matrix: m, fullRange } : null;
}
