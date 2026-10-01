// ============================================================================
// Design tokens for canvas widgets. Mirrors the CSS custom properties in
// styles.css (keep both in sync). Canvas code cannot read `var(--x)`, so charts
// take their colours from here.
//
// Palette notes (validated with the dataviz CVD checker against the chart
// surface #161b22, dark mode):
//  * SERIES — 8 categorical hues in a FIXED order (never cycled / regenerated):
//    all inside the OKLCH lightness band, chroma ≥ 0.1, adjacent-pair CVD
//    ΔE ≥ 10, normal-vision ΔE ≥ 17.9, ≥ 3:1 contrast on the surface.
//    Assign by entity, not rank: a series keeps its colour when others hide.
//  * GOOD / BAD — teal vs coral: distinguishable under protan/deutan (ΔE 12+);
//    always paired with an arrow or sign so colour is never the only cue.
// ============================================================================

import { GOODS } from '../../sim/goods';

export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif';
export const MONO_STACK = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

export const T = {
  // surfaces (deep ink / slate)
  bg0: '#0c0f13', // app backdrop, map surround
  bg1: '#11151a', // sidebar, top bar
  bg2: '#161b22', // cards & chart surface
  bg3: '#1d232c', // inputs, hover
  bg4: '#262e39', // active / pressed
  // ink (warm parchment)
  ink0: '#f1e9d8', // primary text
  ink1: '#cfc5b0', // secondary
  ink2: '#948b7a', // muted (axes, labels)
  ink3: '#6b6558', // faint
  // chart chrome
  grid: '#212832', // hairline gridlines (one step off the surface)
  axis: '#353e4a', // baseline / axis rule
  crosshair: 'rgba(241, 233, 216, 0.35)',
  // accent
  gold: '#d8ab4e',
  goldHi: '#f2cd72',
  goldLo: '#9c7629',
  // status (reserved: never use as a series colour)
  good: '#57b8a5',
  bad: '#e8845a',
  warn: '#e2b54d',
  info: '#6aa7e0',
} as const;

/** Categorical series colours, fixed order. */
export const SERIES = [
  '#4695e1', // 1 blue
  '#d6722e', // 2 orange
  '#1ea980', // 3 aqua
  '#ba8600', // 4 ochre
  '#d86394', // 5 magenta
  '#59a739', // 6 green
  '#8e80e3', // 7 violet
  '#de6565', // 8 red
] as const;

/** Colour of categorical slot i (0-based). Past 8 it repeats — fold extra series into "Other" instead. */
export function seriesColor(i: number): string {
  return SERIES[((i % SERIES.length) + SERIES.length) % SERIES.length];
}

/** Canvas font string: font(11), font(12, 600). */
export function font(size: number, weight: number | string = 400, mono = false): string {
  return `${weight} ${size}px ${mono ? MONO_STACK : FONT_STACK}`;
}

const rgbCache = new Map<string, [number, number, number]>();

/** Parse '#rgb' / '#rrggbb' / 'rgb(…)' into [r,g,b] (falls back to ink). */
export function toRgb(color: string): [number, number, number] {
  const hit = rgbCache.get(color);
  if (hit) return hit;
  let r = 241;
  let g = 233;
  let b = 216;
  const c = color.trim();
  if (c[0] === '#') {
    const hex = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
    const n = parseInt(hex, 16);
    if (Number.isFinite(n)) {
      r = (n >> 16) & 255;
      g = (n >> 8) & 255;
      b = n & 255;
    }
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      [r, g, b] = [p[0] || 0, p[1] || 0, p[2] || 0];
    }
  }
  const out: [number, number, number] = [r, g, b];
  rgbCache.set(color, out);
  return out;
}

/** Colour with alpha: alpha('#d8ab4e', 0.2) → 'rgba(216,171,78,0.2)'. */
export function alpha(color: string, a: number): string {
  const [r, g, b] = toRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

/** Mix two colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  const m = (i: number) => Math.round(x[i] + (y[i] - x[i]) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

/** WCAG relative luminance of a colour. */
export function luminance(color: string): number {
  const [r, g, b] = toRgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const readableCache = new Map<string, string>();

/**
 * The colour, lightened just enough to reach `min`:1 contrast on the chart
 * surface (some goods' own colours — oil, coal — are too dark for a dark UI).
 */
export function readable(color: string, min = 3, surface: string = T.bg2): string {
  const key = color + '|' + min + '|' + surface;
  const hit = readableCache.get(key);
  if (hit) return hit;
  let out = color;
  for (let t = 0.08; contrast(out, surface) < min && t <= 0.9; t += 0.06) out = mix(color, '#f1e9d8', t);
  readableCache.set(key, out);
  return out;
}

/** Lighten toward parchment (hover lift). */
export function lighten(color: string, t = 0.18): string {
  return mix(color, '#ffffff', t);
}

/** A good's UI colour, lifted to stay readable on the dark chart surface. */
export function goodColor(g: number): string {
  return readable(GOODS[g]?.color ?? T.ink2);
}
