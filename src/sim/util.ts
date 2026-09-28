// Small numeric helpers shared by the simulation.

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exponential moving average step: returns prev + k·(x − prev). */
export function ema(prev: number, x: number, k: number): number {
  return prev + k * (x - prev);
}

/** Finite-number guard: returns `fallback` for NaN/±Infinity. */
export function fin(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

export function sum(arr: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

export function mean(arr: readonly number[]): number {
  return arr.length ? sum(arr) / arr.length : 0;
}

/** Gini coefficient of non-negative values (0 = equal, 1 = one holds all). */
export function gini(values: readonly number[]): number {
  const v = values.map((x) => (x > 0 ? x : 0)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  let cum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    cum += v[i];
    weighted += (i + 1) * v[i];
  }
  if (cum <= 0) return 0;
  return (2 * weighted) / (n * cum) - (n + 1) / n;
}

/** Push onto an array, dropping from the front beyond `cap`. */
export function pushCapped(arr: number[], x: number, cap: number): void {
  arr.push(x);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** Tile index helpers. */
export function tileIndex(w: number, x: number, y: number): number {
  return y * w + x;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
