// ============================================================================
// Treasury works: the workplaces the Treasury wholly owns, run as departments.
// OWNER: firms agent. See DESIGN §5 (Build) and §3.2.
//
// A producer the Treasury holds all of (built by it, left to it, or bought outright)
// is a works (Firm.works). It hires, pays and makes things like any firm, but:
//
//   · what it makes goes each morning to the Treasury's stores in its town, and it
//     draws its materials from the Treasury's stores there first (INPUT_BUFFER_DAYS
//     of making) — the Treasury's works supply one another in-house, at no price;
//     what the stores lack it buys in the market;
//   · the Purse keeps its cash at WORKS_FLOAT_DAYS of its running costs (plus the tools
//     it lacks) and takes back what is beyond twice that: it never borrows, pays no
//     dividends and never goes bankrupt (the Purse carries it; with auto-mint off and an
//     empty Purse its workers go unpaid, as the Treasury's crews do);
//   · it plans to keep the stores stocked for WORKS_STOCK_DAYS of what leaves them (plus
//     a season's carry for coal): the outflow is learnt as the fall in the stores since
//     the morning before (sold by orders, handed out, carried off, drawn by other works,
//     spoilt — less what the Treasury bought or carried in), shared among the works of
//     the good in the town by their room; a new works runs at NEW_FIRM_SCALE of its room
//     until it has a record, and every works keeps one hand at work while its stores
//     are low (a works that stopped would never learn that demand came back);
//   · when it becomes a works it gets a standing sell order asking what its good costs to make
//     (firms.fairPrice × WORKS_PRICE_MULT, re-set each morning: never a monopolist's price where
//     the Treasury is the only maker) whose daily quantity follows what it makes,
//     beyond what the Treasury's own works use, × (1 + WORKS_OFFER_SLACK) — so it learns
//     what more would sell. The player prices it (0 gives it away), pauses it, hands the
//     goods out (Transfer) or carries them (Carry) instead;
//   · where one of its materials is made by a Treasury works in another town and none in
//     its own, a carry rule brings what it needs (once: a rule the player removes stays
//     removed; it goes when the works stops being one).
//
// Its books (WorksBook) are what it would earn as a company: its output at the going price
// less what it costs to run (materials at the going price wherever they came from) — its
// `profit` holds that, so buyers of a stake can value it. Selling any part of it, or closing
// it, ends it as a works: it runs as an ordinary company from then (releaseWorks).
// ============================================================================
import { DAYS_PER_YEAR, INPUT_BUFFER_DAYS, SHORTAGE_WEIGHT, SUPPLY_ELASTICITY, SUPPLY_RESP_MAX, SUPPLY_SCARCITY_FROM, INV_ADJUST_DAYS, INV_CORR_MAX, NEW_FIRM_RAMP_DAYS, NEW_FIRM_SCALE, PRICE_EXP_EMA, WORKS_BOOK_EMA, WORKS_FLOAT_DAYS, WORKS_OFFER_SLACK, WORKS_OUT_EMA, WORKS_SELLDOWN_DAYS, WORKS_STOCK_DAYS } from '../config';
import { seasonFactor } from '../calendar';
import { G, GOODS, SECTORS } from '../goods';
import { firmRef, pay, repayPrincipal, writeOff } from '../ledger';
import { expectedNet, marketOf } from '../market/markets';
import { rt } from '../runtime';
import { news } from '../stats/events';
import type { CarryRule, Firm, SimState, StoreFlow, TownId } from '../types';
import { STATE } from '../types';
import { clamp, ema, fin } from '../util';
import { demandCarryDays, fairPrice, seasonalCarryDays, siteMultiplier } from './firms';
import { isWorks, whollyTreasury } from './ownership';
import { potentialOutput } from './production';
import { carryLabel } from '../policy/carry';
import { usableRoute } from '../policy/lines';
import { addWorksOrder, worksCostPrice, worksOrderLabel } from '../policy/player';

/** Could `f` be a works: open, a maker of goods on a site, and wholly the Treasury's. */
export function worksEligible(f: Firm | undefined): boolean {
  if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks' || f.building < 0) return false;
  const d = SECTORS[f.sector];
  return !!d && d.producer && whollyTreasury(f);
}

function key(town: TownId, good: number): string {
  return `${town}:${good}`;
}

function held(s: SimState, town: TownId, good: number): number {
  const q = fin(s.treasury.goods[town]?.[good] ?? 0);
  return q > 1e-9 ? q : 0;
}

/** The record of what leaves a store (created on first use: nothing left yet). */
function flowOf(s: SimState, town: TownId, good: number): StoreFlow {
  const t = s.treasury;
  const all = (t.storeFlow ??= {});
  const k = key(town, good);
  let f = all[k];
  if (!f || !Number.isFinite(f.prev) || !Number.isFinite(f.out)) all[k] = f = { prev: held(s, town, good), out: 0 };
  return f;
}

/** The works, in id order. */
export function worksList(s: SimState): Firm[] {
  const out: Firm[] = [];
  for (const f of s.firms) if (isWorks(f)) out.push(f);
  return out;
}

/** One worker's day of output at `f` (a yardstick). */
function oneHand(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  const season = d.season === 'farm' ? 1 : seasonFactor(d.season, s.day);
  return potentialOutput(f.sector, 0.95, d.toolsPerWorker * 0.95, season, siteMultiplier(s, f));
}

/** What a works costs a day at today's plan: wages of its planned hands and its materials at the going price. */
function runningCost(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  let c = Math.max(f.workers.length, fin(f.target)) * Math.max(0, fin(f.wage));
  const q = Math.max(fin(f.output), fin(f.works?.want ?? 0));
  for (const [g, a] of d.inputs) c += a * q * Math.max(0, fin(marketOf(s, f.town, g).ema));
  return Math.max(1, c);
}

/** The cash the Purse keeps a works in: WORKS_FLOAT_DAYS of running costs plus the tools it lacks. */
export function worksFloat(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  const hands = Math.max(f.workers.length, fin(f.target));
  const tools = Math.max(0, d.toolsPerWorker * hands * 1.1 - Math.max(0, fin(f.tools)) - Math.max(0, fin(f.inv[G.tools])));
  return WORKS_FLOAT_DAYS * runningCost(s, f) + tools * Math.max(0, fin(marketOf(s, f.town, G.tools).ema));
}

/** Units a day the Treasury's works in `town` use of `good` (at their plans), and those a carry rule supplies from there. */
export function treasuryUse(s: SimState, town: TownId, good: number, depth = 0): number {
  let u = 0;
  for (const f of s.firms) {
    if (!isWorks(f) || f.town !== town) continue;
    for (const [g, a] of SECTORS[f.sector].inputs) if (g === good) u += a * Math.max(0, fin(f.works!.want));
  }
  if (depth < 2)
    for (const c of s.policy.carries ?? []) if (c.works !== undefined && c.enabled && c.from === town && c.good === good && c.to !== town && c.to >= 0) u += treasuryUse(s, c.to, good, depth + 1);
  return u;
}

/** Make `f` a works (see the header). */
export function convertToWorks(s: SimState, f: Firm): void {
  const d = SECTORS[f.sector];
  const fref = firmRef(f.id);
  const firstDay = f.founded >= s.day - 1;
  f.works = { since: s.day, want: Math.max(0, fin(f.output), fin(f.sales)), cost: 0, value: 0, inhouse: 0, linked: [] };
  // its stock of what it makes joins the Treasury's stores; the store's outflow starts from what it sold as a firm
  const g = d.out;
  const q = Math.max(0, fin(f.inv[g]));
  const fl = flowOf(s, f.town, g);
  if (q > 0) {
    s.treasury.goods[f.town][g] = held(s, f.town, g) + q;
    f.inv[g] = 0;
  }
  if (!(fl.out > 0)) fl.out = Math.max(0, fin(f.sales));
  fl.prev = held(s, f.town, g);
  // a department does not borrow: the Purse pays off what it owes the bank
  for (const ln of s.loans) {
    if (!ln.active || ln.borrower !== fref || !(ln.principal > 0)) continue;
    const need = ln.principal - Math.max(0, fin(f.cash));
    if (need > 0) pay(s, STATE, fref, need, 'works');
    const a = repayPrincipal(s, fref, ln.principal);
    ln.principal = Math.max(0, ln.principal - a);
    if (ln.principal <= 1e-6) {
      if (ln.principal > 0) writeOff(s, ln.principal);
      ln.principal = 0;
      ln.active = false;
    }
  }
  const rq = s.bank.requests;
  if (rq && rq.length) {
    let k = 0;
    for (let i = 0; i < rq.length; i++) if (rq[i].borrower !== fref) rq[k++] = rq[i];
    rq.length = k;
  }
  f.distress = 0;
  // cash beyond its float goes back to the Purse
  const float = worksFloat(s, f);
  if (f.cash > float) pay(s, fref, STATE, f.cash - float, 'works');
  // its sell order: the one it had before it was sold in part, else a new one
  const was = s.policy.orders.find((o) => o.worksWas === f.id && o.market.kind === 'good');
  if (was) {
    delete was.worksWas;
    was.works = f.id;
  } else if (!s.policy.orders.some((o) => o.works === f.id)) addWorksOrder(s, f);
  const tn = s.towns[f.town]?.name ?? '';
  news(
    s,
    firstDay
      ? `The Treasury's ${d.name.toLowerCase()} in ${tn} is at work: what it makes goes to the Treasury's stores there, and a standing order sells it at the going price — change it, or hand the goods out, as you see fit.`
      : `${f.name} in ${tn} is now wholly the Treasury's and the Treasury runs it as its own: what it makes goes to the Treasury's stores there, sold by a standing order at the going price.`,
    'policy',
    f.town,
  );
}

/**
 * `f` stops being a works (sold in part, closed, or no longer wholly the Treasury's): its sell order
 * becomes a plain order, the carry rules added for it go, and — still open — it runs as a company from
 * today, with what it would have earned as one for its record.
 */
export function releaseWorks(s: SimState, f: Firm): void {
  const b = f.works;
  if (!b) return;
  delete f.works;
  for (const o of s.policy.orders) {
    if (o.works !== f.id) continue;
    delete o.works;
    delete o.atCost; // a plain order at its last price from now on
    if (f.alive && f.status === 'active') o.worksWas = f.id;
  }
  if (s.policy.carries?.length) s.policy.carries = s.policy.carries.filter((c) => c.works !== f.id);
  if (!f.alive || f.status !== 'active') return;
  const d = SECTORS[f.sector];
  const made = Math.max(0, fin(f.output));
  f.sales = made;
  f.salesLong = made;
  f.pExp = Math.max(1e-6, fin(expectedNet(s, f.town, d.out), f.pExp));
  f.unitCost = made > 1e-6 ? Math.max(0, fin(b.cost)) / made : f.unitCost;
  f.lossDays = f.profit < 0 ? Math.min(fin(f.lossDays), 30) : 0;
  f.distress = 0;
}

/** Morning, before the firms plan: what became (or stopped being) a works, what left the stores, each works' plan, its sell order, its carry rules. */
export function worksBeginDay(s: SimState): void {
  for (const f of s.firms) {
    if (!f) continue;
    if (f.works && !worksEligible(f)) releaseWorks(s, f);
    else if (!f.works && worksEligible(f)) convertToWorks(s, f);
  }
  const list = worksList(s);
  // orphans (a works that is gone): its order turns plain, its carry rules go
  const live = new Set(list.map((f) => f.id));
  for (const o of s.policy.orders) if (o.works !== undefined && !live.has(o.works)) delete o.works;
  if (s.policy.carries?.some((c) => c.works !== undefined && !live.has(c.works))) s.policy.carries = s.policy.carries.filter((c) => c.works === undefined || live.has(c.works));
  if (!list.length) return;

  // ---- what left each store since yesterday's deliveries ----
  const groups = new Map<string, Firm[]>();
  for (const f of list) {
    const k = key(f.town, SECTORS[f.sector].out);
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  for (const [k, fs] of groups) {
    const g = SECTORS[fs[0].sector].out;
    const town = fs[0].town;
    const fl = flowOf(s, town, g);
    const now = held(s, town, g);
    fl.out = Math.max(0, fin(ema(fl.out, Math.max(0, fl.prev - now), WORKS_OUT_EMA)));
    fl.prev = now;
    void k;
    // ---- each works' plan: its share of the outflow, toward a stock target ----
    let room = 0;
    for (const f of fs) room += Math.max(1, fin(f.capacity));
    // what the Treasury's own workplaces need of it (here and where carry rules take it): a floor on
    // what leaves — the store's outflow is capped by what it held, and an empty store hides their need
    const own = treasuryUse(s, town, g);
    for (const f of fs) {
      const share = Math.max(1, fin(f.capacity)) / Math.max(1, room);
      const D = Math.max(fl.out, own) * share;
      const stock = now * share;
      // the season's carry: coal ahead of the winter, a farm's harvest through the year
      const carry = g === G.coal ? demandCarryDays(g, s.day) : SECTORS[f.sector].season === 'farm' ? seasonalCarryDays(s.day) : 0;
      const target = (WORKS_STOCK_DAYS + carry) * D;
      // up gently (hiring takes time), down as far as the stores' overflow needs (to a stop)
      const corr = clamp((target - stock) / INV_ADJUST_DAYS, -D, INV_CORR_MAX * D);
      // and, like any maker, more while the market pays well over what the good costs to make, or goes short
      // (a bounded supply response: firms.planTarget's, SUPPLY_ELASTICITY up to SUPPLY_RESP_MAX + the scarcity log)
      const m = marketOf(s, town, g);
      const cost = Math.max(1e-6, fairPrice(s, town, g));
      const gap = Math.max(1e-6, fin(m.ema)) / cost;
      const resp = stock < target ? clamp(Math.pow(gap, SUPPLY_ELASTICITY), 1, 1 + SUPPLY_RESP_MAX + Math.max(0, Math.log(gap / SUPPLY_SCARCITY_FROM))) : 1;
      let want = Math.max(0, (D + corr) * resp + (stock < target ? SHORTAGE_WEIGHT * Math.max(0, fin(m.shortage)) * share : 0));
      const unit = oneHand(s, f);
      // less than one hand's work and the stores full: it rests while they sell down (people come whole)
      if (want < unit && stock >= Math.max(target, WORKS_STOCK_DAYS * unit)) want = 0;
      // one hand at work while the stores are low; a new works at NEW_FIRM_SCALE of its room until it has a record
      if (stock < WORKS_STOCK_DAYS * unit) want = Math.max(want, unit);
      const d = SECTORS[f.sector];
      if (s.day - f.works!.since < NEW_FIRM_RAMP_DAYS && s.day - f.founded < NEW_FIRM_RAMP_DAYS) {
        const ramp = NEW_FIRM_SCALE * Math.min(Math.max(1, fin(f.capacity)), d.typicalSize) * unit;
        if (stock < WORKS_STOCK_DAYS * ramp) want = Math.max(want, ramp);
      }
      f.works!.want = fin(want);
    }
  }

  // ---- materials made by the Treasury elsewhere: a carry rule brings them ----
  linkWorks(s, list);
}

/** Add, once per good, a carry rule to each works from the nearest town where a Treasury works makes a material it uses and its own town has none. */
function linkWorks(s: SimState, list: Firm[]): void {
  for (const f of list) {
    const b = f.works!;
    for (const [g] of SECTORS[f.sector].inputs) {
      if (b.linked.includes(g)) continue;
      if (list.some((o) => o.town === f.town && SECTORS[o.sector].out === g)) continue; // made in its own town
      let best = -1;
      let days = Infinity;
      for (const o of list) {
        if (o.town === f.town || SECTORS[o.sector].out !== g) continue;
        const r = usableRoute(s, o.town, f.town);
        if (r && r.days < days) {
          days = r.days;
          best = o.town;
        }
      }
      if (best < 0) continue; // no Treasury works makes it, or none has a road here yet: look again tomorrow
      b.linked.push(g);
      if ((s.policy.carries ?? []).some((c) => c.to === f.town && c.good === g && c.enabled)) continue; // the player already carries it here
      const c: CarryRule = {
        id: s.ids.policy++,
        label: '',
        enabled: true,
        from: best,
        to: f.town,
        good: g,
        qty: -1,
        need: true,
        wagons: 'full',
        until: -1,
        created: s.day,
        allow: 0,
        heldSince: -1,
        carriedToday: 0,
        carried: 0,
        freightToday: 0,
        freight: 0,
        works: f.id,
      };
      c.label = carryLabel(s, c);
      (s.policy.carries ??= []).push(c);
      const tn = (t: number) => s.towns[t]?.name ?? '';
      news(s, `The Treasury will carry the ${GOODS[g].name.toLowerCase()} its ${SECTORS[f.sector].name.toLowerCase()} in ${tn(f.town)} needs from what its own workplaces make in ${tn(best)} (see Carry).`, 'policy', f.town);
    }
  }
}

/**
 * Each works' sell order (after the morning's deliveries and draws, before the market): what it makes
 * beyond what the Treasury's own workplaces use, × (1 + WORKS_OFFER_SLACK) — or, while it rests, its stock
 * beyond that use over WORKS_SELLDOWN_DAYS — but never into the INPUT_BUFFER_DAYS of that use the store
 * keeps back for them (their carry rules load after the market sessions: a sell order must not empty
 * the store first).
 */
function sizeOrders(s: SimState, list: Firm[]): void {
  const room = new Map<string, number>();
  for (const f of list) {
    const k = key(f.town, SECTORS[f.sector].out);
    room.set(k, (room.get(k) ?? 0) + Math.max(1, fin(f.capacity)));
  }
  for (const o of s.policy.orders) {
    if (o.works === undefined) continue;
    const f = s.firms[o.works];
    if (!isWorks(f) || o.market.kind !== 'good') continue;
    const g = SECTORS[f.sector].out;
    const share = Math.max(1, fin(f.capacity)) / Math.max(1, room.get(key(f.town, g)) ?? 1);
    const made = Math.max(fin(f.output), fin(f.works!.want));
    const use = share * treasuryUse(s, f.town, g);
    const have = share * held(s, f.town, g);
    const spare = Math.max(0, have - use * INPUT_BUFFER_DAYS);
    const offer = Math.max((1 + WORKS_OFFER_SLACK) * made - use, spare / WORKS_SELLDOWN_DAYS);
    o.qty = Math.max(0, fin(Math.min(offer, spare)));
    if (o.atCost) o.price = worksCostPrice(s, f);
    o.label = worksOrderLabel(s, o, f);
  }
}

/** Today's in-house materials (¤ at the going price) by works id (runtime: rebuilt each morning). */
function inhouseToday(s: SimState): Map<number, number> {
  const bag = rt(s).bag;
  let m = bag.worksInhouse as { day: number; v: Map<number, number> } | undefined;
  if (!m || m.day !== s.day) bag.worksInhouse = m = { day: s.day, v: new Map() };
  return m.v;
}

/** After production, before wages: deliveries to the stores, materials drawn from them, the Purse's top-up. */
export function worksAfterProduce(s: SimState): void {
  const list = worksList(s);
  if (!list.length) return;
  const goods = s.treasury.goods;
  // deliveries
  for (const f of list) {
    const g = SECTORS[f.sector].out;
    const q = Math.max(0, fin(f.inv[g]));
    if (q > 0) {
      goods[f.town][g] = held(s, f.town, g) + q;
      f.inv[g] = 0;
    }
  }
  // what the stores hold now (what the works draw below counts as leaving them)
  for (const f of list) flowOf(s, f.town, SECTORS[f.sector].out).prev = held(s, f.town, SECTORS[f.sector].out);
  // materials: INPUT_BUFFER_DAYS of making, from the Treasury's own stores first
  const drawn = inhouseToday(s);
  for (const f of list) {
    const d = SECTORS[f.sector];
    const q = Math.max(fin(f.works!.want), fin(f.output));
    for (const [j, a] of d.inputs) {
      const want = a * q * INPUT_BUFFER_DAYS - Math.max(0, fin(f.inv[j]));
      const take = Math.min(Math.max(0, want), held(s, f.town, j));
      if (!(take > 1e-9)) continue;
      goods[f.town][j] = held(s, f.town, j) - take;
      f.inv[j] = Math.max(0, fin(f.inv[j])) + take;
      drawn.set(f.id, (drawn.get(f.id) ?? 0) + take * Math.max(0, fin(marketOf(s, f.town, j).ema)));
      s.stats.acc.works_inhouse = (s.stats.acc.works_inhouse || 0) + take;
    }
  }
  // each sell order, now that the day's goods are in: what the store can spare beyond what the Treasury's own workplaces need
  sizeOrders(s, list);
  // the Purse keeps each in cash for its wages and what it must still buy
  for (const f of list) {
    const want = worksFloat(s, f) - Math.max(0, fin(f.cash));
    if (want > 0.01) {
      const got = pay(s, STATE, firmRef(f.id), want, 'works');
      s.stats.acc.works_funded = (s.stats.acc.works_funded || 0) + got;
    }
  }
}

/** Evening, after the firms' accounts: the in-house book, and cash beyond twice the float back to the Purse. */
export function worksEndDay(s: SimState): void {
  const list = worksList(s);
  if (!list.length) return;
  const drawn = inhouseToday(s);
  for (const f of list) {
    const b = f.works!;
    b.inhouse = fin(ema(fin(b.inhouse), drawn.get(f.id) ?? 0, WORKS_BOOK_EMA));
    const float = worksFloat(s, f);
    if (f.cash > 2 * float) pay(s, firmRef(f.id), STATE, f.cash - float, 'works');
    f.pExp = Math.max(1e-6, fin(ema(fin(f.pExp, 1), fin(expectedNet(s, f.town, SECTORS[f.sector].out), f.pExp), PRICE_EXP_EMA), f.pExp));
  }
}

/** A works' figures for the UI. */
export interface WorksReport {
  /** ¤ a day: running cost, its output at the going price, materials from the Treasury's own works (at the going price). */
  cost: number;
  value: number;
  inhouse: number;
  /** Units a day it plans to make, and has been making. */
  want: number;
  made: number;
  /** What the Treasury holds of its output in its town, and what leaves that store a day. */
  held: number;
  out: number;
  /** ¤ a year it would earn as a company (value − cost). */
  perYear: number;
  /** The sell order that offers its output (−1 none), and the carry rules that bring it materials. */
  order: number;
  carries: number[];
}

export function worksReport(s: SimState, f: Firm): WorksReport | null {
  if (!f.works) return null;
  const b = f.works;
  const g = SECTORS[f.sector].out;
  const fl = s.treasury.storeFlow?.[key(f.town, g)];
  const o = s.policy.orders.find((x) => x.works === f.id);
  return {
    cost: fin(b.cost),
    value: fin(b.value),
    inhouse: fin(b.inhouse),
    want: fin(b.want),
    made: fin(f.output),
    held: held(s, f.town, g),
    out: fin(fl?.out ?? 0),
    perYear: (fin(b.value) - fin(b.cost)) * DAYS_PER_YEAR,
    order: o ? o.id : -1,
    carries: (s.policy.carries ?? []).filter((c) => c.works === f.id).map((c) => c.id),
  };
}
