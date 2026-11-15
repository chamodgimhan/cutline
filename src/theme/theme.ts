// Single source for every colour, spacing step and type size in Cutline.
// UI code reads these through CSS variables emitted by themeCssVariables().

export const color = {
  bg0: '#0f1114', // app background
  bg1: '#15181d', // panel background
  bg2: '#1c2027', // raised surface, inputs
  bg3: '#262b34', // hover
  line: '#2e343f', // borders, dividers
  text: '#e8ebf0',
  textDim: '#a3abb8',
  textFaint: '#7c8594',
  accent: '#f2a33a', // playhead, primary actions
  accentText: '#1a1204',
  select: '#5aa9ff', // selection outline, snap indicator
  danger: '#ff6b5e',
  ok: '#5fd08a',
  clipVideo: '#396ba3',
  clipAudio: '#337457',
  clipText: '#7e56a5',
  clipCaption: '#886030',
  clipAdjust: '#636977',
  meterLow: '#5fd08a',
  meterMid: '#e9c94a',
  meterHigh: '#ff6b5e',
  marker: '#e25fa0',
  range: '#f2a33a33',
  overlay: '#000000b3',
} as const;

export const space = { x1: 2, x2: 4, x3: 8, x4: 12, x5: 16, x6: 24, x7: 32 } as const;

export const type = {
  family: '"Inter", "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  xs: 10,
  sm: 11,
  md: 12,
  lg: 14,
  xl: 18,
} as const;

export const size = {
  radius: 4,
  trackHeight: 56,
  trackHeaderWidth: 132,
  rulerHeight: 24,
  panelHeader: 26,
  control: 24,
  focusRing: 2,
} as const;

export type ColorName = keyof typeof color;

const kebab = (s: string): string => s.replace(/[A-Z]/g,(m) => '-' + m.toLowerCase());

/** CSS custom properties for the whole theme, e.g. --c-bg0, --s-x3, --t-md, --z-radius. */
export function themeCssVariables(): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(color)) out.push(`--c-${kebab(k)}:${v}`);
  for (const [k, v] of Object.entries(space)) out.push(`--s-${k}:${v}px`);
  for (const [k, v] of Object.entries(type)) out.push(`--t-${kebab(k)}:${typeof v === 'number' ? v + 'px' : v}`);
  for (const [k, v] of Object.entries(size)) out.push(`--z-${kebab(k)}:${v}px`);
  return `:root{${out.join(';')}}`;
}

/** Parse #rrggbb or #rrggbbaa to [r,g,b,a] in 0..1. */
export function parseHex(hex: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m || !m[1]) throw new Error(`Bad colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

/** WCAG relative luminance contrast ratio between two opaque theme colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = parseHex(hex);
    const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
