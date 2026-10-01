// ============================================================================
// Production model — pure math shared by firms.ts (behaviour) and world/init.ts
// (calibration). Do not put behaviour or state mutation here.
//
//   Q = A · season · site · Leff^α · toolFactor(K, Leff)
//   toolFactor = TOOLLESS + (1 − TOOLLESS) · min(1, K / (tpw · Leff))
//
// With α < 1 each site has decreasing returns, so every firm has a rising
// marginal cost and the market supply curve slopes up. Tools are complements
// to labour: without them output falls to TOOLLESS of normal.
// ============================================================================
import { BASE_MARKUP, BASE_WAGE, INIT_LEND_RATE, TOOLLESS, TOOLS_IDLE_WEAR_DAY, DAYS_PER_YEAR } from '../config';
import { G, N_GOODS, PRODUCER_SECTORS, SECTORS, type SectorDef } from '../goods';
import type { Sector } from '../types';

const tfpCache: Partial<Record<Sector, number>> = {};

/** Total factor productivity A for a sector (calibrated from prodPerWorker at typicalSize). */
export function tfp(sector: Sector): number {
  const c = tfpCache[sector];
  if (c !== undefined) return c;
  const d = SECTORS[sector];
  const n = Math.max(1, d.typicalSize);
  const a = (d.prodPerWorker * n) / Math.pow(n, d.alpha);
  tfpCache[sector] = a;
  return a;
}

/** Tool factor in [TOOLLESS, 1]. */
export function toolFactor(d: SectorDef, tools: number, leff: number): number {
  if (leff <= 0) return 1;
  if (d.toolsPerWorker <= 0) return 1;
  const k = tools / (d.toolsPerWorker * leff);
  return TOOLLESS + (1 - TOOLLESS) * Math.min(1, Math.max(0, k));
}

/** Output with effective labour `leff`, tools `tools`, seasonal factor and site multiplier (before material caps). */
export function potentialOutput(sector: Sector, leff: number, tools: number, season: number, site: number): number {
  if (leff <= 0) return 0;
  const d = SECTORS[sector];
  return tfp(sector) * season * site * Math.pow(leff, d.alpha) * toolFactor(d, tools, leff);
}

/** Maximum output allowed by material inventories (Leontief). */
export function materialCap(sector: Sector, inv: readonly number[]): number {
  const d = SECTORS[sector];
  let cap = Infinity;
  for (const [g, a] of d.inputs) cap = Math.min(cap, inv[g] / a);
  return cap === Infinity ? 1e12 : Math.max(0, cap);
}

/**
 * Effective labour needed to produce Q (assuming tools are adequate, i.e. toolFactor = 1).
 * Inverse of Q = A·s·m·L^α.
 */
export function laborForOutput(sector: Sector, q: number, season: number, site: number): number {
  if (q <= 0) return 0;
  const d = SECTORS[sector];
  const k = tfp(sector) * Math.max(1e-6, season * site);
  return Math.pow(q / k, 1 / d.alpha);
}

/**
 * Profit-maximising effective labour given the per-unit margin over materials and
 * tool wear (`margin` = p_net − Σ a_j p_j − toolCostPerUnit) and effective wage.
 * FOC: margin · α · Q/L = w  →  L = (α·margin·A·s·m / w)^(1/(1−α)).
 * Returns 0 when margin ≤ 0.
 */
export function optimalLabor(sector: Sector, margin: number, wageEff: number, season: number, site: number): number {
  if (margin <= 0 || wageEff <= 0) return 0;
  const d = SECTORS[sector];
  if (d.alpha >= 1) return 1e9;
  const k = tfp(sector) * season * site;
  return Math.pow((d.alpha * margin * k) / wageEff, 1 / (1 - d.alpha));
}

/** Material cost per unit of output at the given (gross) input prices. */
export function materialCostPerUnit(sector: Sector, prices: readonly number[]): number {
  let c = 0;
  for (const [g, a] of SECTORS[sector].inputs) c += a * prices[g];
  return c;
}

/** Tool wear cost per unit of output at a given tools price and output per worker. */
export function toolCostPerUnit(sector: Sector, pTools: number, outputPerWorker: number, rateAnnual = INIT_LEND_RATE): number {
  const d = SECTORS[sector];
  if (outputPerWorker <= 0) return 0;
  const perWorkerDay = d.toolUse * pTools + d.toolsPerWorker * pTools * (TOOLS_IDLE_WEAR_DAY + rateAnnual / DAYS_PER_YEAR);
  return perWorkerDay / outputPerWorker;
}

/**
 * Founding price vector: the price at which a typical firm is exactly at its
 * profit-maximising size, i.e. p = materials + tool wear + w/(α·prodPerWorker),
 * scaled by `markup` (BASE_MARKUP ≈ 1 keeps firms at optimum; >1 adds margin).
 * Solved by fixed-point iteration (tools price depends on itself).
 */
export function basePrices(wage = BASE_WAGE, markup = BASE_MARKUP, rateAnnual = INIT_LEND_RATE): number[] {
  // Every cost is linear in the wage and in the prices, so the solution is linear in the wage:
  // solve once per (markup, rate) for a unit wage and scale (firms ask for it every day, per town).
  const key = markup + '|' + rateAnnual;
  let unit = UNIT_PRICES.get(key);
  if (!unit) {
    unit = solveBasePrices(1, markup, rateAnnual);
    if (UNIT_PRICES.size > 32) UNIT_PRICES.clear();
    UNIT_PRICES.set(key, unit);
  }
  const p = new Array(N_GOODS);
  for (let g = 0; g < N_GOODS; g++) p[g] = unit[g] * wage;
  return p;
}

/** Memo of the unit-wage solution of basePrices (a pure function of markup and rate). */
const UNIT_PRICES = new Map<string, number[]>();

function solveBasePrices(wage: number, markup: number, rateAnnual: number): number[] {
  const p = new Array(N_GOODS).fill(1);
  for (let it = 0; it < 80; it++) {
    for (const k of PRODUCER_SECTORS) {
      const d = SECTORS[k];
      const labour = wage / (d.alpha * d.prodPerWorker);
      const mat = materialCostPerUnit(k, p);
      const tool = toolCostPerUnit(k, p[G.tools], d.prodPerWorker, rateAnnual);
      p[d.out] = (mat + tool + labour) * markup;
    }
  }
  return p;
}

/** Unit variable cost (labour at the current wage and output per worker + materials + tool wear). */
export function unitVariableCost(sector: Sector, wage: number, outputPerWorker: number, prices: readonly number[]): number {
  if (outputPerWorker <= 0) return 1e9;
  return wage / outputPerWorker + materialCostPerUnit(sector, prices) + toolCostPerUnit(sector, prices[G.tools], outputPerWorker);
}

/** Value (¤) of a construction bundle at given prices and wage, including the builder's margin. */
export function materialsValue(m: { labor: number; wood: number; iron: number; tools: number }, prices: readonly number[], wage: number, margin: number): number {
  return (m.labor * wage + m.wood * prices[G.wood] + m.iron * prices[G.iron] + m.tools * prices[G.tools]) * margin;
}
