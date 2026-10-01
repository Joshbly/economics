// ============================================================================
// The realm's investment experience: a small neural network the investors learn
// from what their ventures actually earned. OWNER: firms agent. See DESIGN §3.2.
//
// Investors value a venture by a formula (entry.sectorSignal: the trade's profits at
// today's prices, lowered by the newcomer's own output, less the cost of hands...). A
// formula is always wrong somewhere — some trades, towns and moments it flatters,
// others it undersells. So every venture, when it is decided, leaves a record: what
// was known then (the features below) and the return the formula promised. A year
// after it opens (or when it closes sooner) the return it has actually earned is
// known; the network is trained on the difference (actual − promised) by one step of
// gradient descent. Before deciding the next venture, investors ask it how far off
// the formula is likely to be for that trade, town and moment, and correct for it as
// far as they trust experience (their temperament).
//
// The network: EXP_INPUTS features → EXP_HIDDEN tanh units → one linear output, its
// weights plain arrays in the state (s.invest.net), started small from the realm's
// random stream; learning rate EXP_LEARN_RATE; its answer is kept within ±EXP_MAX_ADJ.
// It knows nothing to begin with (it answers about 0) and learns only from this realm.
// ============================================================================
import { DAYS_PER_YEAR, EXP_HIDDEN, EXP_LEARN_RATE, EXP_MAX_ADJ, EXP_MIN_AGE } from '../config';
import { GOODS, SECTORS } from '../goods';
import { rand } from '../rng';
import type { Firm, InvestState, Sector, SimState, TownId } from '../types';
import { clamp, fin } from '../util';

/** Features: bias; the trade's kind (raw material, workshop, service); the town's kind (4); margin, shortage, makers, rate, site, price impact, carted, trade new to the town. */
export const EXP_INPUTS = 15;

const TOWN_KINDS = ['capital', 'farm', 'mining', 'harbor'];

/** What was known when a venture was decided. */
export interface VentureFacts {
  sector: Sector;
  town: TownId;
  /** Expected net price over unit cost (materials + tools + hands), ≥ 0. */
  margin: number;
  /** Buyers going without, as a share of sales. */
  shortage: number;
  makers: number;
  rate: number;
  /** The site against an average one (sites.ts rel). */
  site: number;
  /** The price after its own output, as a share of today's (entry.priceAfterEntry). */
  impact: number;
  /** A trade new to the town. */
  fresh: boolean;
}

export function features(s: SimState, v: VentureFacts): number[] {
  const d = SECTORS[v.sector];
  const kind = d && d.producer ? (d.inputs.length ? 1 : 0) : 2;
  const tk = TOWN_KINDS.indexOf(s.towns[v.town]?.kind ?? '');
  const x = new Array(EXP_INPUTS).fill(0);
  x[0] = 1;
  x[1 + kind] = 1;
  if (tk >= 0) x[4 + tk] = 1;
  x[8] = clamp(Math.log(Math.max(0.1, 1 + fin(v.margin))), -1, 2);
  x[9] = clamp(fin(v.shortage), 0, 1);
  x[10] = clamp(fin(v.makers) / 5, 0, 2);
  x[11] = clamp(fin(v.rate) * 5, -1, 2);
  x[12] = clamp(fin(v.site, 1) - 1, -1, 1);
  x[13] = clamp(1 - fin(v.impact, 1), 0, 1);
  x[14] = v.fresh ? 1 : d && GOODS[d.out]?.tradable ? 0.5 : 0;
  return x;
}

/** The state (created on first use). */
export function investState(s: SimState): InvestState {
  if (!s.invest || !s.invest.net || s.invest.net.w1.length !== EXP_INPUTS * EXP_HIDDEN) {
    const w1: number[] = [];
    for (let k = 0; k < EXP_INPUTS * EXP_HIDDEN; k++) w1.push(Math.round((rand(s) - 0.5) * 0.2 * 1e6) / 1e6);
    const w2: number[] = [];
    for (let k = 0; k < EXP_HIDDEN; k++) w2.push(Math.round((rand(s) - 0.5) * 0.2 * 1e6) / 1e6);
    s.invest = { net: { w1, b1: new Array(EXP_HIDDEN).fill(0), w2, b2: 0, trained: 0, err: 0 }, pending: s.invest?.pending ?? [] };
  }
  if (!Array.isArray(s.invest.pending)) s.invest.pending = [];
  return s.invest;
}

function forward(s: SimState, x: readonly number[]): { h: number[]; y: number } {
  const n = investState(s).net;
  const h: number[] = new Array(EXP_HIDDEN);
  let y = n.b2;
  for (let j = 0; j < EXP_HIDDEN; j++) {
    let a = n.b1[j];
    for (let i = 0; i < EXP_INPUTS; i++) a += n.w1[j * EXP_INPUTS + i] * x[i];
    h[j] = Math.tanh(a);
    y += n.w2[j] * h[j];
  }
  return { h, y };
}

/** How far off (annual return, e.g. −0.1) the formula is likely to be for a venture like this, by experience. */
export function experienceAdjust(s: SimState, v: VentureFacts): number {
  const { y } = forward(s, features(s, v));
  return clamp(fin(y), -EXP_MAX_ADJ, EXP_MAX_ADJ);
}

/** One step of gradient descent on (features → actual − promised). */
function train(s: SimState, x: readonly number[], target: number): void {
  const n = investState(s).net;
  const { h, y } = forward(s, x);
  const e = clamp(y - target, -2, 2);
  const lr = EXP_LEARN_RATE;
  for (let j = 0; j < EXP_HIDDEN; j++) {
    const g2 = e * h[j];
    const back = e * n.w2[j] * (1 - h[j] * h[j]);
    n.w2[j] = fin(n.w2[j] - lr * g2);
    n.b1[j] = fin(n.b1[j] - lr * back);
    for (let i = 0; i < EXP_INPUTS; i++) n.w1[j * EXP_INPUTS + i] = fin(n.w1[j * EXP_INPUTS + i] - lr * back * x[i]);
  }
  n.b2 = fin(n.b2 - lr * e);
  n.trained += 1;
  n.err = fin(0.9 * n.err + 0.1 * Math.abs(e));
}

/** A venture was decided: keep what was known and what the formula promised, to learn from when it has run a while. */
export function noteVenture(s: SimState, project: number, v: VentureFacts, promised: number, capital: number): void {
  const st = investState(s);
  st.pending.push({ project, firm: -1, day: s.day, x: features(s, v), promised: fin(promised), capital: Math.max(1, fin(capital)) });
  if (st.pending.length > 200) st.pending.splice(0, st.pending.length - 200);
}

/** A venture's workshop has opened: its record follows the firm. */
export function ventureOpened(s: SimState, project: number, f: Firm): void {
  const st = s.invest;
  if (!st) return;
  for (const r of st.pending) if (r.project === project && r.firm < 0) {
    r.firm = f.id;
    r.day = s.day;
    f.profitLife = 0;
  }
}

/**
 * Daily: ventures open EXP_MIN_AGE days (or closed sooner) are judged — the return they earned a
 * year on their capital (their profit so far, annualised; a closed one lost its capital) against
 * what was promised — and the network learns from each; ventures never built are forgotten.
 */
export function learnFromVentures(s: SimState): void {
  const st = s.invest;
  if (!st || !st.pending.length) return;
  let k = 0;
  for (const r of st.pending) {
    const f = r.firm >= 0 ? s.firms[r.firm] : undefined;
    const age = s.day - r.day;
    if (r.firm < 0) {
      const p = s.projects.find((x) => x.id === r.project);
      if (!p || p.status === 'cancelled' || age > 3 * DAYS_PER_YEAR) continue; // never built: forget it
      st.pending[k++] = r;
      continue;
    }
    if (!f) continue;
    const closed = !f.alive || f.status !== 'active';
    if (!closed && age < EXP_MIN_AGE) {
      st.pending[k++] = r;
      continue;
    }
    const years = Math.max(EXP_MIN_AGE, age) / DAYS_PER_YEAR;
    // the profit it earned a year on its capital; one that closed lost about half its capital besides
    const earned = fin(f.profitLife ?? 0) / r.capital / years - (closed ? 0.5 / years : 0);
    train(s, r.x, clamp(earned, -1, 2) - r.promised);
  }
  st.pending.length = k;
}
