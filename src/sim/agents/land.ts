// ============================================================================
// Land held to sell dearer: people buy plots of a town's land from its council and hold them
// unbuilt while they expect the town's land to rise in price faster than their money would
// earn otherwise. OWNER: councils agent. See DESIGN §3.7.
//
// What a plot is worth is what the council would ask for it today (council.landTilePrice: a
// share of what a house costs to build there × how much of the core is taken × the mayor's
// land policy, dearer at the centre). Held land counts as taken (at LAND_HELD_CROWD_W), so
// buying land up raises its price for everyone else.
//
// Monthly, on LAND_DAY, in each town:
//   1. plots whose holder is gone revert to the council (estates pass them on first,
//      demography.passAssets → passPlots); a plot a road was laid across is bought back by the
//      council at today's price (as far as its purse allows);
//   2. the price of a tile at the centre is recorded (Town.landIdx, the last LAND_HISTORY
//      months): what investors expect of it a year ahead is LAND_TREND_W × its trend over
//      the last year + the rest × the inflation they expect (a house will cost that much
//      more to build), seen through each one's optimism;
//   3. holders who no longer expect it to pay — less than the deposit rate + LAND_PREMIUM_SHARE
//      of their premium + LAND_HURDLE, by LAND_SELL_MARGIN — or who are short of money sell
//      back to the council at LAND_RESALE_DISCOUNT under today's price (while its purse allows);
//   4. up to LAND_BUYERS would-be buyers with money to spare (weighted by it; people of
//      independent means twice) buy where they expect it to pay: at most LAND_MAX_TILES
//      plots each and nerve × LAND_SPEC_SHARE of their spare money, the free tiles a house
//      could stand on nearest the centre, while no more than LAND_HELD_MAX of the core's free
//      land is held.
// A builder whose site takes a held tile buys it (council.buyPlot → takePlots) at today's price
// + LAND_HOLD_MARKUP; builders prefer free land unless the held tile is the clearly better site
// (layout.siteScore). Levies on 'land' charge holders daily (policy/levies.stockLevies).
// ============================================================================
import {
  BELONG_CORE,
  LAND_BUYERS,
  LAND_DAY,
  LAND_EXP_MAX,
  LAND_EXP_MIN,
  LAND_HELD_MAX,
  LAND_HISTORY,
  LAND_HOLD_MARKUP,
  LAND_HURDLE,
  LAND_MAX_TILES,
  LAND_PREMIUM_SHARE,
  LAND_RESALE_DISCOUNT,
  LAND_SELL_MARGIN,
  LAND_SPEC_SHARE,
  LAND_TREND_W,
  LAND_COUNCIL_BUY_SHARE,
  LAND_CASH_DAYS,
} from '../config';
import { dayOfMonth } from '../calendar';
import { cashOf, councilOf, councilRef, isPerson, pay, personRef } from '../ledger';
import { decisionRand, decisionSeed } from '../rng';
import { news } from '../stats/events';
import { STATE, Terrain, type Building, type LandPlot, type Ref, type SimState, type TownId } from '../types';
import { clamp, fin } from '../util';
import { coreTown } from '../world/belonging';
import { siteFits } from '../world/layout';
import { isHeld, plotAt, touchPlots } from '../world/plots';
import { landTilePrice, payForPlot } from './council';
import { expectedInflation, investableCash } from './entry';
import { temperament } from './temperament';

function bump(s: SimState, key: string, v = 1): void {
  s.stats.acc[key] = (s.stats.acc[key] || 0) + v;
}

function tileXY(s: SimState, tile: number): { x: number; y: number } {
  return { x: tile % s.map.w, y: Math.floor(tile / s.map.w) };
}

/** What the council would ask for the tile today (0 beyond every core). */
export function plotValue(s: SimState, tile: number, town?: TownId): number {
  const { x, y } = tileXY(s, tile);
  const t = town ?? coreTown(s, x + 0.5, y + 0.5);
  return t >= 0 ? Math.max(0, fin(landTilePrice(s, t, x + 0.5, y + 0.5))) : 0;
}

/** What a holder asks of a builder for the plot: today's price + LAND_HOLD_MARKUP. */
export function plotAsk(s: SimState, p: LandPlot): number {
  return plotValue(s, p.tile, p.town) * (1 + LAND_HOLD_MARKUP);
}

/** What the plots `ref` holds are worth today (¤). */
export function landWealth(s: SimState, ref: Ref): number {
  let v = 0;
  for (const p of s.plots ?? []) if (p.owner === ref) v += plotValue(s, p.tile, p.town);
  return v;
}

/** Plots held, by holder, worth today (for statistics over everyone at once). */
export function landWealthByOwner(s: SimState): Map<Ref, number> {
  const m = new Map<Ref, number>();
  for (const p of s.plots ?? []) m.set(p.owner, (m.get(p.owner) ?? 0) + plotValue(s, p.tile, p.town));
  return m;
}

/** Plots held in a town. */
export function heldInTown(s: SimState, town: TownId): number {
  let n = 0;
  for (const p of s.plots ?? []) if (p.town === town) n++;
  return n;
}

/** What investors expect the town's land to gain a year (before their own optimism). */
export function expectedLandGain(s: SimState, town: TownId): number {
  const t = s.towns[town];
  const infl = expectedInflation(s);
  const idx = t?.landIdx ?? [];
  let g = infl;
  if (idx.length >= 3) {
    const last = idx.length - 1;
    const months = Math.min(12, last);
    const a = idx[last - months];
    const b = idx[last];
    if (a > 0 && b > 0) {
      const trend = Math.pow(b / a, 12 / months) - 1;
      g = LAND_TREND_W * clamp(trend, LAND_EXP_MIN, LAND_EXP_MAX) + (1 - LAND_TREND_W) * infl;
    }
  }
  return clamp(g, LAND_EXP_MIN, LAND_EXP_MAX);
}

/** What `who` expects of the town's land, and what they would ask of it, a year. */
function view(s: SimState, who: number, town: TownId): { gain: number; need: number } {
  const tm = temperament(s, personRef(who));
  const g = expectedLandGain(s, town) + 0.1 * tm.optimism;
  const need = Math.max(0, fin(s.bank.depositRate)) + LAND_PREMIUM_SHARE * tm.premium + LAND_HURDLE;
  return { gain: g, need };
}

function removePlot(s: SimState, k: number): void {
  const list = s.plots!;
  list[k] = list[list.length - 1];
  list.pop();
  touchPlots(s);
}

/** The council buys a plot back (`price` ¤, as far as its purse allows); false if it cannot. */
function sellBack(s: SimState, k: number, price: number, cap: number): number {
  const p = s.plots![k];
  const c = councilOf(s, p.town);
  const ref = councilRef(p.town);
  if (!c || !(price > 0) || cashOf(s, ref) < price || price > cap) return 0;
  const paid = pay(s, ref, p.owner, price, 'asset');
  if (!(paid > 0)) return 0;
  c.year.landBought += paid;
  bump(s, 'land_held_back', paid);
  if (paid < p.paid) bump(s, 'land_held_loss', p.paid - paid);
  else bump(s, 'land_held_gain', paid - p.paid);
  removePlot(s, k);
  return paid;
}

/**
 * A builder's new building takes the held tiles under it (council.buyPlot): the council buys each from its
 * holder at the holder's ask — the builder pays the council for it with the rest of the plot — or, as far as
 * the council's purse cannot, the builder's owner pays the holder directly. Returns what the owner paid
 * holders directly (¤), which the council does not charge again.
 */
export function takePlots(s: SimState, owner: Ref, b: Pick<Building, 'x' | 'y' | 'w' | 'h'>): number {
  if (!s.plots || s.plots.length === 0) return 0;
  let direct = 0;
  const W = s.map.w;
  for (let yy = b.y; yy < b.y + b.h; yy++)
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const tile = yy * W + xx;
      const p = plotAt(s, tile);
      if (!p) continue;
      const ask = plotAsk(s, p);
      let got = 0;
      if (p.owner !== owner) {
        const ref = councilRef(p.town);
        got = pay(s, ref, p.owner, Math.min(ask, Math.max(0, cashOf(s, ref))), 'asset');
        const c = councilOf(s, p.town);
        if (c && got > 0) c.year.landBought += got;
        if (got < ask - 0.005) {
          const d = pay(s, owner, p.owner, ask - got, 'asset');
          direct += d;
          got += d;
        }
        bump(s, 'land_held_sold', got);
        if (got >= p.paid) bump(s, 'land_held_gain', got - p.paid);
        else bump(s, 'land_held_loss', p.paid - got);
      } else direct += ask; // building on their own plot: nothing more to pay for it
      const k = s.plots.indexOf(p);
      if (k >= 0) removePlot(s, k);
    }
  return direct;
}

/** Plots of `from` pass to `to` (an heir); to the Treasury or nobody: back to their councils. */
export function passPlots(s: SimState, from: Ref, to: Ref): void {
  if (!s.plots || s.plots.length === 0) return;
  let changed = false;
  for (let k = s.plots.length - 1; k >= 0; k--) {
    const p = s.plots[k];
    if (p.owner !== from) continue;
    if (to !== STATE && isPerson(to) && s.people[to]?.alive) p.owner = to;
    else {
      s.plots[k] = s.plots[s.plots.length - 1];
      s.plots.pop();
    }
    changed = true;
  }
  if (changed) touchPlots(s);
}

/** Free tiles of the town's core a house could stand on, nearest the centre first. */
function freeCoreTiles(s: SimState, town: TownId): number[] {
  const t = s.towns[town];
  const m = s.map;
  const R = Math.max(3, t.radius) + BELONG_CORE;
  const out: { tile: number; d: number }[] = [];
  for (let y = Math.max(1, Math.floor(t.y - R)); y <= Math.min(m.h - 2, Math.ceil(t.y + R)); y++)
    for (let x = Math.max(1, Math.floor(t.x - R)); x <= Math.min(m.w - 2, Math.ceil(t.x + R)); x++) {
      const d = Math.hypot(x + 0.5 - t.x, y + 0.5 - t.y);
      if (d > R) continue;
      const i = y * m.w + x;
      const tr = m.terrain[i];
      if (tr === Terrain.Water || tr === Terrain.DeepWater || m.occ[i] >= 0 || m.road[i] >= 1 || m.river[i]) continue;
      if (coreTown(s, x + 0.5, y + 0.5) !== town) continue;
      if (!siteFits(s, 'house', x, y)) continue;
      out.push({ tile: i, d });
    }
  out.sort((a, b) => a.d - b.d || a.tile - b.tile);
  return out.map((o) => o.tile);
}

/** Monthly (LAND_DAY): see the header. */
export function landStep(s: SimState): void {
  if (dayOfMonth(s.day) !== LAND_DAY) return;
  if (!s.plots) s.plots = [];
  const plots = s.plots;
  const nT = s.towns.length;
  // 1. holders gone; roads laid across held land
  for (let k = plots.length - 1; k >= 0; k--) {
    const p = plots[k];
    const alive = isPerson(p.owner) && s.people[p.owner]?.alive;
    if (!alive || !(p.town >= 0 && p.town < nT)) {
      removePlot(s, k);
      continue;
    }
    const i = p.tile;
    if (s.map.occ[i] >= 0 || s.map.road[i] >= 1) {
      sellBack(s, k, plotValue(s, i, p.town), Infinity);
      if (plots[k] === p) removePlot(s, k); // the council could not pay: the road took it all the same
    }
  }
  // 2. the price of land at each town's centre
  for (const t of s.towns) {
    const v = Math.max(0, fin(landTilePrice(s, t.id, t.x, t.y)));
    const idx = (t.landIdx ??= []);
    idx.push(Math.round(v * 100) / 100);
    if (idx.length > LAND_HISTORY) idx.splice(0, idx.length - LAND_HISTORY);
  }
  // 3. holders reconsider
  const backByTown = new Array(nT).fill(0);
  const capByTown = s.towns.map((t) => LAND_COUNCIL_BUY_SHARE * Math.max(0, cashOf(s, councilRef(t.id))));
  for (let k = plots.length - 1; k >= 0; k--) {
    const p = plots[k];
    const who = s.people[p.owner];
    const v = view(s, who.id, p.town);
    const short = who.cash < LAND_CASH_DAYS * Math.max(1, fin(who.income));
    if (!(v.gain < v.need - LAND_SELL_MARGIN) && !short) continue;
    const price = plotValue(s, p.tile, p.town) * (1 - LAND_RESALE_DISCOUNT);
    const got = sellBack(s, k, price, capByTown[p.town] - backByTown[p.town]);
    backByTown[p.town] += got;
  }
  // 4. would-be holders buy
  const seed = decisionSeed(s);
  for (let town = 0; town < nT; town++) {
    const t = s.towns[town];
    const free = freeCoreTiles(s, town);
    const open = free.filter((i) => !isHeld(s, i));
    const held = heldInTown(s, town);
    let room = Math.floor(LAND_HELD_MAX * free.length) - held; // (free counts held tiles too: they are unbuilt)
    if (room <= 0 || open.length === 0) continue;
    const price0 = plotValue(s, open[0], town);
    if (!(price0 > 0)) continue;
    // would-be buyers: money to spare, weighted by it (the town's own and people of means twice)
    const cands: number[] = [];
    const weights: number[] = [];
    let total = 0;
    for (const p of s.people) {
      if (!p || !p.alive) continue;
      const spare = investableCash(s, p.id, true); // (beyond what they live on, as a landlord reckons)
      if (spare < price0) continue;
      const w = spare * (p.town === town ? 2 : 1) * (p.means ? 2 : 1);
      cands.push(p.id);
      weights.push(w);
      total += w;
    }
    if (!(total > 0)) continue;
    let bought = 0;
    let spent = 0;
    const seen = new Set<number>();
    for (let n = 0; n < LAND_BUYERS && room > 0 && open.length > 0; n++) {
      let r = decisionRand(seed, s.day, town * 64 + n, 91) * total;
      let pick = -1;
      for (let i = 0; i < cands.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          pick = cands[i];
          break;
        }
      }
      if (pick < 0 || seen.has(pick)) continue;
      seen.add(pick);
      const v = view(s, pick, town);
      if (!(v.gain > v.need)) continue;
      const tm = temperament(s, personRef(pick));
      let budget = tm.nerve * LAND_SPEC_SHARE * investableCash(s, pick, true);
      let k = 0;
      while (k < LAND_MAX_TILES && room > 0 && open.length > 0) {
        const tile = open[0];
        const price = plotValue(s, tile, town);
        if (!(price > 0) || price > budget) break;
        const paid = payForPlot(s, personRef(pick), councilRef(town), price);
        if (!(paid >= price - 0.005)) break;
        plots.push({ tile, town, owner: personRef(pick), paid: Math.round(paid * 100) / 100, day: s.day });
        touchPlots(s);
        open.shift();
        budget -= paid;
        spent += paid;
        room--;
        k++;
        bought++;
      }
    }
    if (bought > 0) {
      bump(s, 'land_held_bought', spent);
      bump(s, 'land_held_buys', bought);
      if (bought >= 5) news(s, `${bought} plots of ${t.name}'s land were bought this month to hold, by people who expect land there to rise in price.`, 'market', town);
    }
    if (backByTown[town] > 0 && backByTown[town] > 4 * price0) news(s, `Holders of land in ${t.name} sold plots back to the council this month, no longer expecting its price to rise.`, 'market', town);
  }
}
