// ============================================================================
// Map palette (pure data). Colours are [r, g, b] 0..255 for the per-pixel
// ground painter and CSS strings for vector drawing. A warm, slightly muted
// "illuminated map" palette that sits well against the dark ledger UI.
// ============================================================================

export type RGB = [number, number, number];

/** Water colour stops by depth (tiles from the nearest land) — t = depth / WATER_DEPTH_SPAN. */
export const WATER_STOPS: [number, RGB][] = [
  [0.0, [112, 176, 170]],
  [0.12, [84, 152, 162]],
  [0.3, [56, 118, 146]],
  [0.55, [38, 88, 126]],
  [0.8, [28, 66, 106]],
  [1.0, [22, 52, 88]],
];
export const WATER_DEPTH_SPAN = 9;
export const FOAM: RGB = [236, 242, 234];

export const SAND: RGB = [221, 202, 150];
export const SAND_WET: RGB = [186, 170, 128];
export const GRASS_LUSH: RGB = [98, 146, 72];
export const GRASS_DRY: RGB = [150, 158, 92];
export const FOREST_FLOOR: RGB = [66, 104, 58];
export const HILLS_LO: RGB = [116, 130, 78];
export const HILLS_HI: RGB = [128, 122, 88];
export const MOUNTAIN: RGB = [118, 112, 102];
export const MARSH: RGB = [92, 114, 80];
/** Trodden earth around settlements. */
export const TOWN_GROUND: RGB = [160, 150, 104];

// ---- vector features ---------------------------------------------------------
export const TREE = {
  shadow: 'rgba(22,40,28,0.42)',
  dark: ['#2f5a36', '#355f36', '#2c5238'],
  mid: ['#467a41', '#4f8344', '#3f7040'],
  light: ['#6c9c55', '#78a55c', '#5f9150'],
  conDark: '#274a37',
  conMid: '#33603f',
  conLight: '#4e7d55',
  trunk: '#5a4430',
};
export const PEAK = {
  lit: '#b3aa9c',
  litLow: '#a0978a',
  shade: '#766c63',
  deep: '#6a6158',
  snow: '#f0f2f2',
  snowShade: '#c2ccd8',
  line: 'rgba(52,44,38,0.32)',
};
export const HILL = {
  body: 'rgba(150,154,96,0.55)',
  lit: 'rgba(228,226,176,0.55)',
  shade: 'rgba(62,66,36,0.34)',
};
export const MARSH_F = {
  pool: '#3f6b6e',
  poolRim: 'rgba(170,205,196,0.45)',
  reed: '#4d6a36',
  reedLight: '#7a9450',
  cattail: '#6b4a2e',
};
export const RIVER = {
  bank: 'rgba(46,70,50,0.55)',
  water: '#4f95ad',
  light: 'rgba(170,215,222,0.55)',
};
export const ROAD = {
  dirtEdge: 'rgba(84,64,40,0.5)',
  dirt: '#ad9168',
  dirtRut: 'rgba(120,92,58,0.45)',
  pavedEdge: '#5b5a55',
  pavedLine: '#d4cfc2',
  paved: '#a3a097',
  plaza: '#b7a784',
  plazaEdge: 'rgba(90,76,54,0.5)',
};
export const BRIDGE = {
  wood: '#8a6a45',
  woodDark: '#5c4430',
  stone: '#aaa498',
  stoneDark: '#6e6a62',
};

// ---- buildings ------------------------------------------------------------------
/** Roof palettes by town kind (houses pick by hash). */
export const ROOFS: Record<string, string[]> = {
  capital: ['#9b4a3a', '#a85b40', '#6f5a73', '#56657a', '#8d5037', '#b0673f'],
  farm: ['#c9a757', '#b99447', '#a9493a', '#d1b066', '#9d3f33'],
  mining: ['#56606b', '#4c5560', '#6a6e73', '#5d4c48', '#717a84'],
  harbor: ['#3f6f86', '#4d8093', '#b3543f', '#3b5f7d', '#5c8ea0'],
};
export const WALLS: Record<string, string[]> = {
  capital: ['#e6d8bd', '#dccaa8', '#efe3cb', '#d7c19c'],
  farm: ['#e8d9b4', '#decb9e', '#f0e4c3', '#c9ae80'],
  mining: ['#b9ada0', '#a79c90', '#c7bcad', '#9e958b'],
  harbor: ['#eee8dc', '#f3efe6', '#e2dccd', '#d9d3c3'],
};
export const STONE = '#c9c0ae';
export const STONE_DARK = '#8f8676';
export const TIMBER = '#8a6644';
export const TIMBER_DARK = '#5e4430';
export const WINDOW_DAY = '#3b3a38';
export const WINDOW_NIGHT = '#ffd98a';
export const DOOR = '#4a3526';
export const SHADOW = 'rgba(18,22,16,0.32)';

/** Mix two RGB colours. */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Water colour at depth `d` tiles. Writes into `out`. */
export function waterAt(d: number, out: number[]): void {
  const t = d <= 0 ? 0 : d >= WATER_DEPTH_SPAN ? 1 : d / WATER_DEPTH_SPAN;
  let k = 1;
  while (k < WATER_STOPS.length - 1 && WATER_STOPS[k][0] < t) k++;
  const [t0, c0] = WATER_STOPS[k - 1];
  const [t1, c1] = WATER_STOPS[k];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  out[0] = c0[0] + (c1[0] - c0[0]) * f;
  out[1] = c0[1] + (c1[1] - c0[1]) * f;
  out[2] = c0[2] + (c1[2] - c0[2]) * f;
}

/** 'rgb(…)' of an RGB triple scaled by brightness `k`. */
export function rgbStr(c: RGB, k = 1): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

/** Parse '#rrggbb' into RGB (fallback grey). */
export function hexRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [150, 150, 150];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (k > 0) or darken (k < 0) a hex colour → 'rgb(…)'. */
export function shade(hex: string, k: number): string {
  const c = hexRgb(hex);
  if (k >= 0) return rgbStr(mixRgb(c, [255, 255, 255], k));
  return rgbStr(c, 1 + k);
}
