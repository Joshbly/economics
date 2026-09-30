// ============================================================================
// Town councils and the town's land. OWNER: councils agent. See DESIGN §3.7.
//
// Every town has a council: a purse (a deposit at the bank like anyone's, ledger
// ref councilRef(town)) and a mayor, a resident the town chooses every
// MAYOR_TERM_DAYS (sooner if the mayor dies or moves away) — the more standing
// (savings, years in the town, contentment, a business of their own) the likelier,
// the sitting mayor twice as likely. The council plans with its mayor's temperament
// (agents/temperament.ts): how many years ahead it looks, what it asks over the
// bank's rate, how rosy it sees things, how hard it bargains.
//
// The land. Within a town's core (its settlement radius + BELONG_CORE) the unbuilt
// land is the council's; beyond every core it is nobody's, free to whoever clears
// it. Whoever builds in the core buys the plot from the council when the works
// start (plotPrice): a tile at the very centre costs LAND_TILE_SHARE of what a
// house costs to build there today, times (LAND_CROWD_BASE + the share of the core
// already built on) — land grows dear as the town fills — falling to
// LAND_EDGE_SHARE of that at the core's edge. Ventures weigh it like any other
// capital (agents/sites.ts, entry.ts), so a crowded centre sends workshops to the
// edge of town and beyond, and the town grows outward.
//
// Monthly (COUNCIL_DAY) each council:
//   · buys an empty building for its plot — a workshop or a house that has stood
//     empty COUNCIL_CLEAR_DAYS within the core — when the plot is worth more to the
//     council (its price × the odds of selling it again × the mayor's optimism, plus
//     what the materials fetch less the clearing) than the owner asks (what the
//     building might still be worth to them — the less the longer it stands empty —
//     and OWNER_LAND_SHARE of the land, raised by the owner's own optimism, plus
//     whatever tearing it down themselves would net). They meet in between, each
//     side's share of the gain by their nerve (a bargain: price = ask + θ·(value −
//     ask), θ = owner's nerve / both nerves). The council pays the owner, the town's
//     builders clear it, and the plot is the council's to sell again;
//   · sets its land policy: with many of the town's households out of work it asks
//     LAND_MUL_STEP less for its plots (to draw workshops in), with few and the core
//     crowded LAND_MUL_STEP more, drifting back to the formula's price otherwise
//     (Council.landMul, within LAND_MUL_MIN … LAND_MUL_MAX);
//   · lets houses: when at least COUNCIL_HOUSE_HOMELESS of its town's households have
//     no roof and nobody is building houses there, it builds one (on its own land) if
//     the rents of a full house, plus COUNCIL_HOUSE_CIVIC of them again for the
//     households taken off the street, repay the cost over the mayor's horizon — and
//     lets it at the going rent like any landlord (rents to its purse);
//   · builds the road that pays its town best: for each town its own carters trade
//     with (TraderState.lane both ways, ROAD_MIN_LANE and more), paving the way or
//     cutting a new track centre to centre (as the trading houses judge theirs,
//     entry.roadVentures) — but counting COUNCIL_ROAD_SHARE of the freight saved on
//     all the town's traffic, not one house's — worth its cost over the mayor's
//     horizon at the bank's rate + COUNCIL_PREMIUM_SHARE of the mayor's premium. One
//     at a time, paid from the purse (never more than COUNCIL_SPEND_SHARE of it).
//
// A council's money: the plots it sells, the rents of its houses, the deposit interest
// on its purse, and whatever the Treasury hands it (Transfer to the town councils);
// nothing else. It never borrows. Its accounts for the year and the last are kept in Council.year/last.
// ============================================================================
import {
  BELONG_CORE,
  CLEAR_COST_SHARE,
  COUNCIL_CLEAR_DAYS,
  COUNCIL_DAY,
  COUNCIL_HOUSE_CIVIC,
  COUNCIL_HOUSE_HOMELESS,
  COUNCIL_PREMIUM_SHARE,
  COUNCIL_RESALE_ODDS,
  COUNCIL_ROAD_SHARE,
  COUNCIL_SPEND_SHARE,
  DAYS_PER_YEAR,
  LAND_CROWD_BASE,
  LAND_CROWDED,
  LAND_EDGE_SHARE,
  LAND_JOBLESS_HIGH,
  LAND_JOBLESS_LOW,
  LAND_MUL_MAX,
  LAND_MUL_MIN,
  LAND_MUL_STEP,
  LAND_TILE_SHARE,
  MAYOR_MIN_AGE,
  MAYOR_TERM_DAYS,
  OWNER_LAND_SHARE,
  ROAD_MIN_LANE,
  ROAD_SHORTCUT_GAIN,
  SALVAGE_SHARE,
} from '../config';
import { dayOfMonth, dayOfYear } from '../calendar';
import { HOUSE_SLOTS } from '../goods';
import { blankCouncil, cashOf, councilOf, councilRef, firmRef, isCouncil, isFirm, isPerson, pay, refId, refName } from '../ledger';
import { decisionRand, decisionSeed } from '../rng';
import { rt } from '../runtime';
import { news } from '../stats/events';
import { STATE, Terrain, type Building, type Council, type Ref, type SimState, type TownId } from '../types';
import { fin } from '../util';
import { coreTown } from '../world/belonging';
import { removeBuilding, townCentreTile } from '../world/layout';
import { roadPlan, routeBetweenTowns, trackPlan } from '../world/paths';
import { daysAlong, freightAfter } from '../world/roadEffect';
import { builderFor, estimateCost, needCost, roadNeed, startProject } from './construction';
import { screenRate, vacantPrice } from './entry';
import { temperament, type Temperament } from './temperament';
import { freightPerUnit } from './traders';

// ---------------------------------------------------------------------------
// Land
// ---------------------------------------------------------------------------

interface LandCache {
  day: number;
  ver: number;
  /** What a house costs to build in each town today (¤). */
  house: number[];
  /** Share of each town's core land already built on (0 … 1). */
  crowd: number[];
}

function landCache(s: SimState): LandCache {
  const r = rt(s);
  let c = r.bag.land as LandCache | undefined;
  if (c && c.day === s.day && c.ver === r.buildingVersion && c.house.length === s.towns.length) return c;
  const m = s.map;
  const house: number[] = [];
  const crowd: number[] = [];
  for (const t of s.towns) {
    house.push(Math.max(0, fin(estimateCost(s, 'house', t.id))));
    const R = Math.max(3, t.radius) + BELONG_CORE;
    let land = 0;
    let built = 0;
    for (let y = Math.max(0, Math.floor(t.y - R)); y <= Math.min(m.h - 1, Math.ceil(t.y + R)); y++) {
      for (let x = Math.max(0, Math.floor(t.x - R)); x <= Math.min(m.w - 1, Math.ceil(t.x + R)); x++) {
        if (Math.hypot(x + 0.5 - t.x, y + 0.5 - t.y) > R) continue;
        const i = y * m.w + x;
        const tr = m.terrain[i];
        if (tr === Terrain.Water || tr === Terrain.DeepWater) continue;
        land++;
        if (m.occ[i] >= 0) built++;
      }
    }
    crowd.push(land > 0 ? built / land : 0);
  }
  c = { day: s.day, ver: r.buildingVersion, house, crowd };
  r.bag.land = c;
  return c;
}

/** What a tile of `town`'s land at (cx, cy) costs today (0 beyond its core). */
export function landTilePrice(s: SimState, town: TownId, cx: number, cy: number): number {
  const t = s.towns[town];
  if (!t) return 0;
  const R = Math.max(3, t.radius) + BELONG_CORE;
  const d = Math.hypot(cx - t.x, cy - t.y);
  if (!(d <= R)) return 0;
  const lc = landCache(s);
  const central = LAND_EDGE_SHARE + (1 - LAND_EDGE_SHARE) * Math.max(0, 1 - d / R);
  const mul = fin(t.council?.landMul ?? 1, 1);
  return LAND_TILE_SHARE * fin(lc.house[town]) * (LAND_CROWD_BASE + fin(lc.crowd[town])) * central * mul;
}

/** Share of the town's core already built on (0 … 1). */
export function crowding(s: SimState, town: TownId): number {
  return fin(landCache(s).crowd[town]);
}

/** Monthly: the mayor's land policy (see the header). */
function landPolicy(s: SimState, town: TownId): void {
  const t = s.towns[town];
  const c = councilOf(s, town)!;
  const pop = Math.max(1, fin(t.pop));
  const jobless = fin(t.unemployed) / pop;
  let m = fin(c.landMul, 1);
  if (jobless > LAND_JOBLESS_HIGH) m *= 1 - LAND_MUL_STEP;
  else if (jobless < LAND_JOBLESS_LOW && crowding(s, town) > LAND_CROWDED) m *= 1 + LAND_MUL_STEP;
  else m += (1 - m) * LAND_MUL_STEP;
  c.landMul = Math.round(Math.min(LAND_MUL_MAX, Math.max(LAND_MUL_MIN, m)) * 1000) / 1000;
}

/** The plot under a footprint: whose land it is (the council of the town whose core it lies in, or −1: nobody's) and its price today. */
export function plotPrice(s: SimState, x: number, y: number, w: number, h: number): { town: TownId; price: number } {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const town = coreTown(s, cx, cy);
  if (town < 0) return { town: -1, price: 0 };
  return { town, price: landTilePrice(s, town, cx, cy) * w * h };
}

/** A new building's plot is bought from the council when its works start (construction.startProject). Returns what was paid. */
export function buyPlot(s: SimState, owner: Ref, b: Building): number {
  const { town, price } = plotPrice(s, b.x, b.y, b.w, b.h);
  if (town < 0 || !(price > 0.01)) return 0;
  const to = councilRef(town);
  if (owner === to) return 0;
  const paid = pay(s, owner, to, price, 'asset');
  if (paid > 0) {
    const c = councilOf(s, town)!;
    c.year.landSold += paid;
    c.year.plots += 1;
    bump(s, 'land_sold', paid);
  }
  return paid;
}

// ---------------------------------------------------------------------------
// The mayor
// ---------------------------------------------------------------------------

/** The mayor's temperament (an average one while the town has none). */
function mind(s: SimState, c: Council): Temperament {
  return c.mayor >= 0 ? temperament(s, c.mayor) : { horizon: 8, premium: 0.04, optimism: 0, nerve: 0.6 };
}

/** Choose a mayor when the term is up, or the mayor has died or moved away (see the header). */
export function chooseMayor(s: SimState, town: TownId): void {
  const c = councilOf(s, town);
  if (!c) return;
  const cur = c.mayor >= 0 ? s.people[c.mayor] : undefined;
  const sitting = !!cur && cur.alive && cur.town === town;
  if (sitting && s.day - c.since < MAYOR_TERM_DAYS) return;
  const cands: number[] = [];
  const w: number[] = [];
  let cashSum = 0;
  let n = 0;
  for (const p of s.people) {
    if (!p || !p.alive || p.town !== town) continue;
    cashSum += Math.max(0, fin(p.cash));
    n++;
  }
  const avg = n > 0 ? Math.max(1, cashSum / n) : 1;
  for (const p of s.people) {
    if (!p || !p.alive || p.town !== town || !(p.age >= MAYOR_MIN_AGE)) continue;
    const years = Math.min(20, Math.max(0, s.day - fin(p.born)) / DAYS_PER_YEAR);
    let v = Math.sqrt(1 + Math.max(0, fin(p.cash)) / avg) * (0.5 + fin(p.contentment, 0.5)) * (1 + years / 10) * (p.owns.length ? 1.5 : 1);
    if (sitting && p.id === c.mayor) v *= 2;
    cands.push(p.id);
    w.push(v);
  }
  if (!cands.length) {
    if (!sitting) c.mayor = -1;
    return;
  }
  let tot = 0;
  for (const x of w) tot += x;
  let r = decisionRand(decisionSeed(s), s.day, town, 901) * tot;
  let k = 0;
  for (; k < w.length - 1; k++) {
    r -= w[k];
    if (r <= 0) break;
  }
  const id = cands[k];
  const was = c.mayor;
  c.mayor = id;
  c.since = s.day;
  const tn = s.towns[town].name;
  const name = s.people[id].name;
  if (id === was) news(s, `${name} stays on as mayor of ${tn}.`, 'info', town);
  else news(s, `${name} is the new mayor of ${tn}.`, 'info', town);
}

// ---------------------------------------------------------------------------
// Buying empty buildings for their plots
// ---------------------------------------------------------------------------

function payee(s: SimState, ref: Ref): boolean {
  if (isPerson(ref)) return !!s.people[ref]?.alive;
  if (isFirm(ref)) {
    const f = s.firms[refId(ref)];
    return !!f && f.alive;
  }
  return false;
}

/** A council's offer for an empty building and what its owner asks (see the header); null if it is not for the council. */
export function plotDeal(s: SimState, b: Building, town: TownId): { value: number; ask: number; price: number; clear: number } | null {
  if (!b || b.town !== town || b.project >= 0) return null;
  const empty = (b.kind === 'firm' && b.status === 'vacant') || (b.kind === 'house' && b.status === 'active' && b.residents.length === 0);
  if (!empty || !(fin(b.vacantDays) >= COUNCIL_CLEAR_DAYS)) return null;
  const owner = b.owner;
  if (owner === STATE || isCouncil(owner) || !payee(s, owner)) return null;
  const plot = plotPrice(s, b.x, b.y, b.w, b.h);
  if (plot.town !== town || !(plot.price > 0)) return null;
  const c = councilOf(s, town)!;
  const T = mind(s, c);
  const odds = c.year.plots + c.last.plots > 0 ? COUNCIL_RESALE_ODDS[0] : COUNCIL_RESALE_ODDS[1];
  const cost = Math.max(0, fin(b.cost));
  const clear = CLEAR_COST_SHARE * cost;
  const scrap = (SALVAGE_SHARE - CLEAR_COST_SHARE) * cost; // what the materials net once cleared
  const value = plot.price * odds * (1 + T.optimism) + scrap;
  const age = Math.max(0, fin(b.vacantDays));
  const use = b.kind === 'firm' ? vacantPrice(s, b) * Math.exp(-age / (2 * DAYS_PER_YEAR)) : 0.5 * cost * Math.exp(-age / DAYS_PER_YEAR);
  const O = temperament(s, owner);
  const ask = (use + OWNER_LAND_SHARE * plot.price) * (1 + Math.max(0, O.optimism)) + Math.max(0, scrap);
  if (!(value > ask)) return { value, ask, price: -1, clear };
  const theta = O.nerve / Math.max(1e-9, O.nerve + T.nerve);
  return { value, ask, price: ask + theta * (value - ask), clear };
}

function clearPlots(s: SimState, town: TownId): void {
  const c = councilOf(s, town)!;
  const ref = councilRef(town);
  let best: Building | null = null;
  let bestD: { price: number; clear: number; gain: number } | null = null;
  for (const b of s.buildings) {
    if (!b || b.town !== town || (b.kind !== 'firm' && b.kind !== 'house')) continue;
    const d = plotDeal(s, b, town);
    if (!d || !(d.price > 0)) continue;
    const gain = d.value - d.price;
    if (!bestD || gain > bestD.gain) {
      best = b;
      bestD = { price: d.price, clear: d.clear, gain };
    }
  }
  if (!best || !bestD) return;
  if (!(bestD.price + bestD.clear <= COUNCIL_SPEND_SHARE * cashOf(s, ref))) return;
  const owner = best.owner;
  const paid = pay(s, ref, owner, bestD.price, 'asset');
  if (!(paid > 0)) return;
  if (isPerson(owner)) {
    const p = s.people[owner];
    p.earned += paid;
    if (best.kind === 'house') p.houses = p.houses.filter((h) => h !== best!.id);
  }
  const bld = builderFor(s, town);
  if (bld && bestD.clear > 0) pay(s, ref, firmRef(bld.id), bestD.clear, 'build');
  const what = best.kind === 'house' ? 'empty house' : `empty ${best.sector ? sectorWord(best.sector) : 'workshop'}`;
  const tn = s.towns[town].name;
  best.owner = ref;
  try {
    removeBuilding(s, best);
  } catch {
    best.status = 'ruin';
  }
  c.year.landBought += paid;
  c.year.deals += 1;
  bump(s, 'land_bought', paid);
  news(s, `The council of ${tn} has bought the ${what} of ${refName(s, owner)} for ${money(paid)} and cleared the plot for new building.`, 'info', town);
}

function sectorWord(sector: string): string {
  const w: Record<string, string> = { farm: 'farm', fishery: 'fishery', lumber: 'lumber camp', coalmine: 'coal mine', oilwell: 'oil well', oremine: 'ore mine', smelter: 'smelter', toolworks: 'toolworks', bakery: 'bakery', brewery: 'brewery', furniture: 'furniture workshop', builder: "builders' yard", trader: 'trading house' };
  return w[sector] ?? 'workshop';
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

function annuity(rate: number, years: number): number {
  const r = Math.max(0.005, rate);
  return (1 - Math.pow(1 + r, -years)) / r;
}

/** Units a day carried between two towns by the carters of either (TraderState.lane). */
export function laneTraffic(s: SimState, a: TownId, b: TownId): number {
  let v = 0;
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.sector !== 'trader' || !f.trade?.lane) continue;
    if (f.town === a) v += fin(f.trade.lane[b]);
    else if (f.town === b) v += fin(f.trade.lane[a]);
  }
  return v;
}

/** The road that would pay the town best (see the header), by its worth over the mayor's horizon; null if none pays. */
export function councilRoadPlan(s: SimState, town: TownId): { tiles: number[]; grade: 1 | 2; cost: number; npv: number; to: TownId } | null {
  const c = councilOf(s, town);
  if (!c) return null;
  const T = mind(s, c);
  const rate = Math.max(0.01, screenRate(s) + COUNCIL_PREMIUM_SHARE * T.premium);
  const worth = annuity(rate, T.horizon) * (1 + T.optimism);
  const busy = new Set<number>();
  for (const p of s.projects) if (p.kind === 'road' && p.status !== 'done' && p.status !== 'cancelled') for (const i of p.tiles) busy.add(i);
  let best: { tiles: number[]; grade: 1 | 2; cost: number; npv: number; to: TownId } | null = null;
  for (let b = 0; b < s.towns.length; b++) {
    if (b === town) continue;
    const v = laneTraffic(s, town, b);
    if (!(v >= ROAD_MIN_LANE)) continue;
    const fNow = freightPerUnit(s, town, b);
    if (!(fNow > 0)) continue;
    const route = routeBetweenTowns(s, town, b);
    if (!(route.days > 0) || route.tiles.length < 2) continue;
    const consider = (tiles: readonly number[], path: readonly number[], grade: 1 | 2) => {
      const todo = tiles.filter((i) => !busy.has(i));
      if (!todo.length) return;
      const days = daysAlong(s, path, new Set(todo), grade);
      if (!(days < route.days - 1e-6)) return;
      const fA = freightAfter(s, town, b, days, path.length);
      if (!(fA >= 0) || !(fA < fNow)) return;
      const cost = needCost(s, town, roadNeed(s, todo, grade));
      if (!(cost > 0)) return;
      const npv = COUNCIL_ROAD_SHARE * v * (fNow - fA) * DAYS_PER_YEAR * worth - cost;
      if (!best || npv > best.npv) best = { tiles: todo, grade, cost, npv, to: b };
    };
    consider(roadPlan(s, town, b), route.tiles, 2);
    const tp = trackPlan(s, townCentreTile(s, town), townCentreTile(s, b), 1);
    if (tp.tiles.length >= 3 && daysAlong(s, tp.path, new Set(tp.tiles), 1) < route.days * (1 - ROAD_SHORTCUT_GAIN)) consider(tp.tiles, tp.path, 1);
  }
  return best && (best as { npv: number }).npv > 0 ? best : null;
}

function councilRoads(s: SimState, town: TownId): void {
  const ref = councilRef(town);
  for (const p of s.projects) if (p.owner === ref && p.kind === 'road' && p.status !== 'done' && p.status !== 'cancelled') return;
  const plan = councilRoadPlan(s, town);
  if (!plan || !(plan.cost <= COUNCIL_SPEND_SHARE * cashOf(s, ref))) return;
  const A = s.towns[town].name;
  const B = s.towns[plan.to].name;
  const r = startProject(s, { kind: 'road', town, owner: ref, tiles: plan.tiles, grade: plan.grade, label: `${plan.grade === 1 ? 'Track' : 'Paved road'} ${A}–${B}, for the council of ${A}` });
  if (typeof r === 'string') return;
  const paid = pay(s, ref, firmRef(r.builder), plan.cost, 'asset');
  r.prepaid = fin(r.prepaid) + paid;
  const c = councilOf(s, town)!;
  c.year.roads += paid;
  c.year.roadCount += 1;
  bump(s, 'council_roads', paid);
  news(s, `The council of ${A} is having ${plan.grade === 1 ? 'a new track cut' : 'the road paved'} to ${B} (${money(paid)}): the town's carters will pay less to carry its trade.`, 'info', town);
}

// ---------------------------------------------------------------------------
// Houses
// ---------------------------------------------------------------------------

/** The council's case for building a house now (see the header): its worth over the mayor's horizon less its cost; null when it does not arise. */
export function councilHousePlan(s: SimState, town: TownId): { cost: number; npv: number } | null {
  const t = s.towns[town];
  const c = councilOf(s, town);
  if (!t || !c || !(fin(t.homeless) >= COUNCIL_HOUSE_HOMELESS)) return null;
  for (const p of s.projects) if (p.kind === 'house' && p.town === town && p.status !== 'done' && p.status !== 'cancelled') return null;
  const cost = Math.max(0, fin(estimateCost(s, 'house', town)));
  if (!(cost > 0)) return null;
  const T = mind(s, c);
  const rate = Math.max(0.01, screenRate(s) + COUNCIL_PREMIUM_SHARE * T.premium);
  const rent = Math.max(0, fin(t.avgRent));
  const slots = Math.min(HOUSE_SLOTS, Math.max(1, Math.round(fin(t.homeless))));
  const perYear = rent * (HOUSE_SLOTS + COUNCIL_HOUSE_CIVIC * slots) * DAYS_PER_YEAR;
  return { cost, npv: perYear * annuity(rate, T.horizon) * (1 + T.optimism) - cost };
}

function councilHouses(s: SimState, town: TownId): void {
  const plan = councilHousePlan(s, town);
  const ref = councilRef(town);
  if (!plan || !(plan.npv > 0) || !(plan.cost <= COUNCIL_SPEND_SHARE * cashOf(s, ref))) return;
  const tn = s.towns[town].name;
  const r = startProject(s, { kind: 'house', town, owner: ref, label: `Houses in ${tn}, for the council` });
  if (typeof r === 'string') return;
  const paid = pay(s, ref, firmRef(r.builder), plan.cost, 'asset');
  r.prepaid = fin(r.prepaid) + paid;
  const c = councilOf(s, town)!;
  c.year.houses += paid;
  c.year.houseCount += 1;
  bump(s, 'council_houses', paid);
  news(s, `The council of ${tn} is building houses to let (${money(paid)}): ${fmtCount(s.towns[town].homeless)} of its households have no roof.`, 'info', town);
}

function fmtCount(n: number): string {
  return Math.round(fin(n)).toLocaleString('en-GB');
}

// ---------------------------------------------------------------------------
// The daily step
// ---------------------------------------------------------------------------

/** Daily (evening, after the market for companies): the councils' year turns; mayors; on COUNCIL_DAY, land deals and roads. */
export function councilStep(s: SimState): void {
  const newYear = dayOfYear(s.day) === 0;
  const meet = dayOfMonth(s.day) === COUNCIL_DAY;
  for (let t = 0; t < s.towns.length; t++) {
    const c = councilOf(s, t)!;
    if (newYear && s.day > 0) {
      c.last = c.year;
      c.year = blankCouncil().year;
    }
    if (c.mayor < 0 || meet) chooseMayor(s, t);
    if (!meet) continue;
    landPolicy(s, t);
    clearPlots(s, t);
    councilHouses(s, t);
    councilRoads(s, t);
  }
}

function bump(s: SimState, key: string, v: number): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

function money(v: number): string {
  return `${Math.round(v).toLocaleString('en-GB')} ¤`;
}
