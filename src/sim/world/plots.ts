// ============================================================================
// Which tiles of town land are privately held (SimState.plots; agents/land.ts buys and sells them).
// A rebuildable index (runtime cache): tile → its plot's place in s.plots, −1 for none. Whoever
// changes s.plots calls touchPlots so the index is rebuilt on next use.
// ============================================================================
import { rt } from '../runtime';
import type { LandPlot, SimState } from '../types';

interface PlotIndex {
  ver: number;
  len: number;
  n: number;
  at: Int32Array;
}

/** s.plots changed: the index is rebuilt on next use. */
export function touchPlots(s: SimState): void {
  const bag = rt(s).bag;
  bag.plotsVer = ((bag.plotsVer as number | undefined) ?? 0) + 1;
}

function index(s: SimState): PlotIndex {
  const bag = rt(s).bag;
  const list = s.plots ?? [];
  const ver = (bag.plotsVer as number | undefined) ?? 0;
  const n = s.map.w * s.map.h;
  let c = bag.plotIndex as PlotIndex | undefined;
  if (c && c.ver === ver && c.len === list.length && c.n === n) return c;
  const at = c && c.n === n ? c.at : new Int32Array(n);
  at.fill(-1);
  for (let k = 0; k < list.length; k++) {
    const t = list[k].tile;
    if (t >= 0 && t < n) at[t] = k;
  }
  c = { ver, len: list.length, n, at };
  bag.plotIndex = c;
  return c;
}

/** The plot held on `tile`, if any. */
export function plotAt(s: SimState, tile: number): LandPlot | undefined {
  if (!s.plots || s.plots.length === 0) return undefined;
  const k = index(s).at[tile];
  return k >= 0 ? s.plots[k] : undefined;
}

/** Is `tile` held by someone other than its council? */
export function isHeld(s: SimState, tile: number): boolean {
  if (!s.plots || s.plots.length === 0) return false;
  return index(s).at[tile] >= 0;
}

/** Tiles of a footprint that are held. */
export function heldIn(s: SimState, x: number, y: number, w: number, h: number): number {
  if (!s.plots || s.plots.length === 0) return 0;
  const at = index(s).at;
  const W = s.map.w;
  let k = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (at[yy * W + xx] >= 0) k++;
  return k;
}
