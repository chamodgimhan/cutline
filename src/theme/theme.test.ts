import { describe, expect, it } from 'vitest';
import { color, contrastRatio, parseHex, themeCssVariables } from './theme.ts';

describe('theme', () => {
  it('emits a CSS variable for every token', () => {
    const css = themeCssVariables();
    expect(css.startsWith(':root{')).toBe(true);
    for (const k of ['--c-bg0:', '--c-text-dim:', '--s-x3:8px', '--t-md:12px', '--z-track-height:56px']) expect(css).toContain(k);
  });

  it('parses colours and rejects bad ones', () => {
    expect(parseHex('#ff000080')).toEqual([1, 0, 0, 128 / 255]);
    expect(() => parseHex('red')).toThrow();
  });

  it('keeps text readable on every surface (WCAG AA)', () => {
    for (const bg of [color.bg0, color.bg1, color.bg2, color.bg3]) {
      expect(contrastRatio(color.text, bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(color.textDim, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(color.textFaint, color.bg2)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(color.accentText, color.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
