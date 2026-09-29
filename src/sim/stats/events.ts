// ============================================================================
// News and random events. OWNER: stats agent.
//
// Random events (only when settings.events is on, never during warm-up, and not
// in the first EVENT_GRACE_DAYS of play) act through ordinary state, so their
// consequences emerge from the agents:
//   drought       town.droughtDays = EVENT_DROUGHT_DAYS (firms.ts halves farm output)
//   bumper crop   farms of a town find EVENT_BUMPER_DAYS of extra grain in their barns
//                 (booked as production: acc.prod_0 and acc.event_va)
//   storm at sea  fisheries of a town lose EVENT_STORM_TOOL_LOSS of their boats (tools)
//   mine collapse a mine loses EVENT_MINE_TOOL_LOSS of its tools, its miners are hurt
//   world shock   foreign.shocks gets {good, factor, until} (foreign.ts applies it)
// Unrest → strikes is not random and always runs: a town whose mean contentment
// stays below UNREST_CONTENT for UNREST_DAYS days strikes for STRIKE_DAYS days
// (firms.ts applies STRIKE_FACTOR while town.strikeDays > 0).
// Market news: severe shortages of staples, monthly price swings, realm-wide
// alarms (prices, joblessness, hunger, homelessness), population milestones and
// a year-end summary. Bankruptcies, bank trouble, evictions, emigration and
// policy changes are reported by their own modules.
// Wording is neutral: mechanics are described, never named after modern policies.
// ============================================================================
import {
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  EVENT_ALARM_DEFLATION,
  EVENT_ALARM_HOMELESS,
  EVENT_ALARM_HUNGER,
  EVENT_ALARM_INFLATION,
  EVENT_ALARM_UNEMP,
  EVENT_BUMPER_DAYS,
  EVENT_BUMPER_FROM_DOY,
  EVENT_BUMPER_PER_YEAR,
  EVENT_BUMPER_TO_DOY,
  EVENT_DROUGHT_DAYS,
  EVENT_DROUGHT_FROM_DOY,
  EVENT_DROUGHT_PER_YEAR,
  EVENT_DROUGHT_TO_DOY,
  EVENT_GRACE_DAYS,
  EVENT_MINE_INJURY,
  EVENT_MINE_PER_YEAR,
  EVENT_MINE_TOOL_LOSS,
  EVENT_MIN_VOLUME,
  EVENT_NEWS_COOLDOWN,
  EVENT_POP_STEP,
  EVENT_SHOCK_DOWN_MAX,
  EVENT_SHOCK_DOWN_MIN,
  EVENT_SHOCK_MAX_DAYS,
  EVENT_SHOCK_MIN_DAYS,
  EVENT_SHOCK_UP_MAX,
  EVENT_SHOCK_UP_MIN,
  EVENT_SHOCK_UP_PROB,
  EVENT_SHOCK_UP_PROB_OIL,
  EVENT_SHORTAGE_DAYS,
  EVENT_SHORTAGE_SHARE,
  EVENT_STORM_PER_YEAR,
  EVENT_STORM_TOOL_LOSS,
  EVENT_SWING,
  EVENT_SWING_MAX,
  EVENT_WORLD_SHOCK_PER_YEAR,
  NEWS_CAP,
  STRIKE_DAYS,
  UNREST_CONTENT,
  UNREST_DAYS,
  WARMUP_DAYS,
} from '../config';
import { dayOfYear, isMonthEnd, yearOf } from '../calendar';
import { G, GOODS, N_GOODS, SECTORS, TRADABLE_GOODS } from '../goods';
import { priceBounds } from '../policy/limits';
import { rand, randInt, randRange } from '../rng';
import { rt } from '../runtime';
import type { Firm, NewsKind, SimState } from '../types';
import { clamp, fin } from '../util';

/** Append a news item (capped to NEWS_CAP). */
export function news(s: SimState, text: string, kind: NewsKind = 'info', town = -1): void {
  s.news.push({ day: s.day, text, kind, town });
  if (s.news.length > NEWS_CAP) s.news.splice(0, s.news.length - NEWS_CAP);
}

// ---------------------------------------------------------------------------
// Runtime bookkeeping for news (cooldowns, streaks). Rebuildable: after a load the
// cooldowns simply restart, which can only delay a news item, never change the economy.
// ---------------------------------------------------------------------------
interface EventsCache {
  last: Record<string, number>; // news key → day last reported
  shortStreak: number[]; // [town * N_GOODS + good] consecutive days of severe shortage
  popLevel: number; // population / EVENT_POP_STEP at the last check (−1 unknown)
  popHigh: number; // highest level announced
}

function cache(s: SimState): EventsCache {
  const bag = rt(s).bag;
  let c = bag.events as EventsCache | undefined;
  if (!c) {
    c = { last: {}, shortStreak: [], popLevel: -1, popHigh: -1 };
    bag.events = c;
  }
  return c;
}

/** True (and the key marked) if `key` was not reported within `gap` days. */
function cooled(s: SimState, key: string, gap = EVENT_NEWS_COOLDOWN): boolean {
  const c = cache(s);
  const d = c.last[key];
  if (d !== undefined && s.day - d < gap) return false;
  c.last[key] = s.day;
  return true;
}

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------
function goodLower(g: number): string {
  return (GOODS[g]?.name ?? 'goods').toLowerCase();
}
function goodCap(g: number): string {
  return GOODS[g]?.name ?? 'Goods';
}
function townName(s: SimState, t: number): string {
  return s.towns[t]?.name ?? 'the realm';
}
function pct(x: number): string {
  const v = Math.abs(x) * 100;
  return v >= 10 ? `${Math.round(v)} %` : `${v.toFixed(1)} %`;
}
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
/** "one in 8" for a share. */
function oneIn(share: number): string {
  const n = Math.max(2, Math.round(1 / Math.max(1e-6, share)));
  return `one in ${n}`;
}
function workerPlural(f: Firm): string {
  const w = SECTORS[f.sector]?.worker ?? 'worker';
  return w.endsWith('s') ? w : w + 's';
}

// ---------------------------------------------------------------------------
// Random events (morning)
// ---------------------------------------------------------------------------
function activeFirms(s: SimState, pred: (f: Firm) => boolean): Firm[] {
  const out: Firm[] = [];
  for (const f of s.firms) if (f && f.alive && f.status === 'active' && pred(f)) out.push(f);
  return out;
}

/** Pick a town weighted by how many of the given firms it hosts; −1 if none. */
function townByFirms(s: SimState, firms: Firm[], exclude: (t: number) => boolean): number {
  const w = new Array(s.towns.length).fill(0);
  let tot = 0;
  for (const f of firms) {
    if (f.town < 0 || f.town >= w.length || exclude(f.town)) continue;
    w[f.town]++;
    tot++;
  }
  if (tot === 0) return -1;
  let r = rand(s) * tot;
  for (let t = 0; t < w.length; t++) {
    r -= w[t];
    if (r < 0 && w[t] > 0) return t;
  }
  for (let t = w.length - 1; t >= 0; t--) if (w[t] > 0) return t;
  return -1;
}

function drought(s: SimState): void {
  const farms = activeFirms(s, (f) => f.sector === 'farm');
  const t = townByFirms(s, farms, (x) => s.towns[x].droughtDays > 0);
  if (t < 0) return;
  s.towns[t].droughtDays = EVENT_DROUGHT_DAYS;
  const months = Math.max(1, Math.round(EVENT_DROUGHT_DAYS / DAYS_PER_MONTH));
  news(s, `A dry spell grips ${townName(s, t)}: the fields are parched, and for about ${months === 1 ? 'a month' : `${months} months`} its farms will bring in only half their usual grain.`, 'bad', t);
}

function bumperHarvest(s: SimState): void {
  const farms = activeFirms(s, (f) => f.sector === 'farm');
  const t = townByFirms(s, farms, (x) => s.towns[x].droughtDays > 0);
  if (t < 0) return;
  let extra = 0;
  for (const f of farms) {
    if (f.town !== t) continue;
    const q = Math.max(0, fin(f.output)) * EVENT_BUMPER_DAYS;
    if (!(q > 0)) continue;
    f.inv[G.grain] += q;
    extra += q;
  }
  if (!(extra > 0)) return;
  // A windfall of output: counted as today's production (and value added at base prices).
  const acc = s.stats.acc;
  acc['prod_' + G.grain] = (acc['prod_' + G.grain] || 0) + extra;
  acc.event_va = (acc.event_va || 0) + extra * fin(s.stats.basePrices[G.grain]);
  news(s, `A bumper harvest around ${townName(s, t)}: the barns are full to the rafters, with some ${Math.round(extra)} extra sacks of grain to sell.`, 'good', t);
}

function stormAtSea(s: SimState): void {
  const fisheries = activeFirms(s, (f) => f.sector === 'fishery');
  const t = townByFirms(s, fisheries, () => false);
  if (t < 0) return;
  let lost = 0;
  for (const f of fisheries) {
    if (f.town !== t) continue;
    const l = Math.max(0, fin(f.tools)) * EVENT_STORM_TOOL_LOSS;
    f.tools = Math.max(0, f.tools - l);
    lost += l;
  }
  if (!(lost > 0)) return;
  news(s, `A great storm lashed the coast off ${townName(s, t)}: boats and nets were lost, and the catch will be thin until they are replaced.`, 'bad', t);
}

function mineCollapse(s: SimState): void {
  const mines = activeFirms(s, (f) => (f.sector === 'coalmine' || f.sector === 'oremine') && f.tools > 0);
  if (mines.length === 0) return;
  const f = mines[randInt(s, mines.length)];
  f.tools = Math.max(0, f.tools * (1 - EVENT_MINE_TOOL_LOSS));
  let hurt = 0;
  for (const pid of f.workers) {
    const p = s.people[pid];
    if (!p || !p.alive) continue;
    p.health = clamp(fin(p.health) - EVENT_MINE_INJURY, 0.05, 1);
    hurt++;
  }
  const who = hurt > 1 ? ` and ${hurt} ${workerPlural(f)} are hurt` : hurt === 1 ? ' and one of its miners is hurt' : '';
  news(s, `A shaft collapsed at ${f.name}: no one was killed, but most of its gear lies buried${who}.`, 'bad', f.town);
}

function worldShock(s: SimState): void {
  const fo = s.foreign;
  if (!fo || !fo.world) return;
  const cands: number[] = [];
  for (const g of TRADABLE_GOODS) {
    if (!(fo.world[g] > 0)) continue;
    if (fo.shocks.some((k) => k.good === g && k.until >= s.day)) continue;
    cands.push(g);
  }
  if (cands.length === 0) return;
  const g = cands[randInt(s, cands.length)];
  const up = rand(s) < (g === G.oil ? EVENT_SHOCK_UP_PROB_OIL : EVENT_SHOCK_UP_PROB);
  const factor = up ? randRange(s, EVENT_SHOCK_UP_MIN, EVENT_SHOCK_UP_MAX) : randRange(s, EVENT_SHOCK_DOWN_MIN, EVENT_SHOCK_DOWN_MAX);
  const days = Math.round(randRange(s, EVENT_SHOCK_MIN_DAYS, EVENT_SHOCK_MAX_DAYS));
  fo.shocks.push({ good: g, factor: Math.round(factor * 1000) / 1000, until: s.day + days });
  const port = s.towns.find((t) => t.hasPort);
  const at = port ? ` at ${port.name}` : '';
  if (up)
    news(s, `Word from foreign ports: ${goodLower(g)} has grown scarce abroad and fetches about ${pct(factor - 1)} more there. Ships${at} will ask more for it, and pay more for any we send out.`, 'market', port ? port.id : -1);
  else
    news(s, `${goodCap(g)} is plentiful abroad this season and fetches about ${pct(1 - factor)} less there. Ships${at} will sell it cheaper, and pay less for any we send out.`, 'market', port ? port.id : -1);
}

/**
 * Morning: count down town.droughtDays; if settings.events, roll random events
 * (rates per year in config): drought in a farming town, a bumper harvest, a storm
 * that wrecks fishing boats, a mine collapse (tools destroyed), world price shocks
 * (foreign.shocks, 90–180 days). Each with a news item. (Strikes count down in the
 * evening, see eventsStep, so a strike idles exactly STRIKE_DAYS working days.)
 */
export function beginDayEvents(s: SimState): void {
  for (const town of s.towns) {
    if (town.droughtDays > 0) {
      town.droughtDays -= 1;
      if (town.droughtDays === 0) news(s, `Rain has returned to ${town.name}; the fields are green again.`, 'good', town.id);
    }
  }
  if (!s.settings.events) return;
  if (s.day < Math.max(WARMUP_DAYS, s.startDay + EVENT_GRACE_DAYS)) return;
  const doy = dayOfYear(s.day);
  // Draw every roll every day (fixed RNG use regardless of which events fire).
  const rDrought = rand(s);
  const rBumper = rand(s);
  const rStorm = rand(s);
  const rMine = rand(s);
  const rShock = rand(s);
  const droughtLen = Math.max(1, EVENT_DROUGHT_TO_DOY - EVENT_DROUGHT_FROM_DOY);
  const bumperLen = Math.max(1, EVENT_BUMPER_TO_DOY - EVENT_BUMPER_FROM_DOY);
  if (doy >= EVENT_DROUGHT_FROM_DOY && doy < EVENT_DROUGHT_TO_DOY && rDrought < EVENT_DROUGHT_PER_YEAR / droughtLen) drought(s);
  if (doy >= EVENT_BUMPER_FROM_DOY && doy < EVENT_BUMPER_TO_DOY && rBumper < EVENT_BUMPER_PER_YEAR / bumperLen) bumperHarvest(s);
  if (rStorm < EVENT_STORM_PER_YEAR / DAYS_PER_YEAR) stormAtSea(s);
  if (rMine < EVENT_MINE_PER_YEAR / DAYS_PER_YEAR) mineCollapse(s);
  if (rShock < EVENT_WORLD_SHOCK_PER_YEAR / DAYS_PER_YEAR) worldShock(s);
}

// ---------------------------------------------------------------------------
// Evening: unrest, shortages, monthly market news, milestones
// ---------------------------------------------------------------------------
function unrest(s: SimState): void {
  const acc = s.stats.acc;
  const half = Math.max(1, Math.ceil(UNREST_DAYS / 2));
  for (const town of s.towns) {
    if (town.strikeDays > 0) {
      town.strikeDays -= 1;
      if (town.strikeDays === 0) news(s, `The strike in ${town.name} is over; work has resumed.`, 'info', town.id);
    }
    const unhappy = town.pop > 0 && fin(town.contentment, 1) < UNREST_CONTENT;
    town.unrestDays = unhappy ? town.unrestDays + 1 : 0;
    if (!unhappy || town.strikeDays > 0) continue;
    if (town.unrestDays === half && cooled(s, 'grumble_' + town.id)) {
      news(s, `Tempers are fraying in ${town.name}: crowds gather in the square to complain of hard times.`, 'bad', town.id);
    }
    if (town.unrestDays >= UNREST_DAYS) {
      town.strikeDays = STRIKE_DAYS;
      town.unrestDays = 0;
      acc.strikes_started = (acc.strikes_started || 0) + 1;
      news(s, `Discontent boils over in ${town.name}: workers have walked off the job, and its workshops will run short-handed for ${STRIKE_DAYS} days.`, 'crisis', town.id);
    }
  }
}

const STAPLES = [G.bread, G.fish, G.coal];

function shortages(s: SimState): void {
  const c = cache(s);
  const nT = s.towns.length;
  if (c.shortStreak.length !== nT * N_GOODS) c.shortStreak = new Array(nT * N_GOODS).fill(0);
  for (let t = 0; t < nT; t++) {
    for (const g of STAPLES) {
      const i = t * N_GOODS + g;
      const m = s.markets[i];
      if (!m) continue;
      const demand = fin(m.volume) + fin(m.shortage);
      const share = demand > 1 ? fin(m.shortage) / demand : 0;
      c.shortStreak[i] = share >= EVENT_SHORTAGE_SHARE ? c.shortStreak[i] + 1 : 0;
      if (c.shortStreak[i] !== EVENT_SHORTAGE_DAYS || !cooled(s, 'short_' + i)) continue;
      // the day's legal ceiling (a fixed one, or how far the price was allowed to move)
      const cap = m.curve && m.curve.ceiling >= 0 ? m.curve.ceiling : priceBounds(s, t, g).max;
      const atCap = cap >= 0 && m.price >= cap - 1e-9;
      const why = atCap ? ' At the price the law allows, there is not enough to go round.' : ' Sellers cannot keep up.';
      news(s, `${goodCap(g)} is running short in ${townName(s, t)}: for days now, buyers have been turned away from the market hall empty-handed.${why}`, 'bad', t);
    }
  }
}

interface Swing {
  good: number;
  town: number;
  change: number;
}

function monthMean(a: readonly number[], from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < to && i < a.length; i++) {
    if (a[i] > 0) {
      sum += a[i];
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Change of the mean over the last 30 values vs the 30 before; NaN-free (0 if not enough history). */
export function monthlyChange(hist: readonly number[]): number {
  const n = hist.length;
  if (n < 2 * DAYS_PER_MONTH) return 0;
  const a = monthMean(hist, n - DAYS_PER_MONTH, n);
  const b = monthMean(hist, n - 2 * DAYS_PER_MONTH, n - DAYS_PER_MONTH);
  return a > 0 && b > 0 ? a / b - 1 : 0;
}

function priceSwings(s: SimState): void {
  const swings: Swing[] = [];
  for (let t = 0; t < s.towns.length; t++) {
    for (let g = 0; g < N_GOODS; g++) {
      const m = s.markets[t * N_GOODS + g];
      if (!m || !(m.volEma >= EVENT_MIN_VOLUME)) continue;
      const ch = monthlyChange(m.hist);
      if (Math.abs(ch) >= EVENT_SWING) swings.push({ good: g, town: t, change: ch });
    }
  }
  // Group by good and direction; report the biggest moves first.
  const groups = new Map<string, Swing[]>();
  for (const w of swings) {
    const k = w.good + (w.change > 0 ? '+' : '-');
    const arr = groups.get(k);
    if (arr) arr.push(w);
    else groups.set(k, [w]);
  }
  const items = [...groups.values()].map((arr) => ({ arr, size: Math.max(...arr.map((w) => Math.abs(w.change))) }));
  items.sort((a, b) => b.size - a.size);
  let told = 0;
  for (const { arr } of items) {
    if (told >= EVENT_SWING_MAX) break;
    arr.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    const g = arr[0].good;
    const up = arr[0].change > 0;
    const avg = arr.reduce((x, w) => x + w.change, 0) / arr.length;
    const where = arr.length >= s.towns.length && s.towns.length > 1 ? 'across the realm' : `in ${listNames(arr.slice(0, 3).map((w) => townName(s, w.town)))}`;
    const town = arr.length === 1 ? arr[0].town : -1;
    if (up) news(s, `${goodCap(g)} ${where} costs about ${pct(avg)} more than a month ago.`, 'market', town);
    else news(s, `The price of ${goodLower(g)} ${where} has fallen by about ${pct(avg)} in a month.`, 'market', town);
    told++;
  }
  // National markets
  const gold = monthlyChange(s.goldMarket?.hist ?? []);
  if (Math.abs(gold) >= EVENT_SWING * 0.8)
    news(s, `Gold now fetches ¤${Math.round(s.goldMarket.price)} an ounce, ${pct(gold)} ${gold > 0 ? 'more' : 'less'} than a month ago.`, 'market');
  const iou = monthlyChange(s.iouMarket?.hist ?? []);
  if (Math.abs(iou) >= EVENT_SWING * 0.6)
    news(s, `Treasury IOUs now change hands at ¤${s.iouMarket.price.toFixed(1)}, ${pct(iou)} ${iou > 0 ? 'above' : 'below'} last month's price.`, 'market');
}

function monthlyMean(a: readonly number[] | undefined, from: number, to: number): number {
  if (!a) return 0;
  return monthMean(a, from, to);
}

function milestones(s: SimState): void {
  const c = cache(s);
  const lat = s.stats.latest;
  const pop = fin(lat.pop);
  // ---- population ----
  const level = Math.floor(pop / Math.max(1, EVENT_POP_STEP));
  if (c.popLevel < 0) {
    c.popLevel = level;
    c.popHigh = level;
  } else {
    if (level > c.popLevel && level > c.popHigh) {
      news(s, `The realm has grown to more than ${level * EVENT_POP_STEP} households.`, 'good');
      c.popHigh = level;
    } else if (level < c.popLevel && cooled(s, 'popdown', 90)) {
      news(s, `The realm has dwindled to fewer than ${(level + 1) * EVENT_POP_STEP} households.`, 'bad');
    }
    c.popLevel = level;
  }
  if (s.day < s.startDay + DAYS_PER_MONTH) return;

  // ---- realm-wide alarms ----
  const yoy = fin(lat.inflYoY);
  const played = s.day - s.startDay;
  if (played >= 90) {
    if (yoy >= EVENT_ALARM_INFLATION && cooled(s, 'inflation', 180))
      news(s, `Prices are ${pct(yoy)} higher than a year ago; savers complain that their coin buys less every month.`, 'bad');
    else if (yoy <= EVENT_ALARM_DEFLATION && cooled(s, 'deflation', 180))
      news(s, `Prices have fallen ${pct(yoy)} in a year; those in debt find their loans ever heavier to carry.`, 'bad');
  }
  const unemp = fin(lat.unemp);
  if (unemp >= EVENT_ALARM_UNEMP && cooled(s, 'unemp', 120)) news(s, `Work is scarce: ${oneIn(unemp)} of the realm's workers has no job.`, 'bad');
  const hunger = fin(lat.hunger);
  if (hunger >= EVENT_ALARM_HUNGER && cooled(s, 'hunger', 60)) news(s, `Hunger is spreading: about ${oneIn(hunger)} households did not get enough to eat today.`, 'crisis');
  const homeless = fin(lat.homelessRate);
  if (homeless >= EVENT_ALARM_HOMELESS && cooled(s, 'homeless', 120)) news(s, `${Math.round(fin(lat.homeless))} households have no roof over their heads.`, 'bad');

  // ---- year-end summary ----
  if (dayOfYear(s.day) === DAYS_PER_YEAR - 1 && played >= DAYS_PER_YEAR - DAYS_PER_MONTH) {
    const gdp = s.stats.monthly.gdpReal;
    let growth = 0;
    let have = false;
    if (gdp && gdp.length >= 24) {
      const a = monthlyMean(gdp, gdp.length - 12, gdp.length);
      const b = monthlyMean(gdp, gdp.length - 24, gdp.length - 12);
      if (a > 0 && b > 0) {
        growth = a / b - 1;
        have = true;
      }
    } else if (gdp && gdp.length >= 13) {
      const a = gdp[gdp.length - 1];
      const b = gdp[gdp.length - 13];
      if (a > 0 && b > 0) {
        growth = a / b - 1;
        have = true;
      }
    }
    const pricesText = Math.abs(yoy) < 0.005 ? 'prices are about where they were a year ago' : `prices are ${pct(yoy)} ${yoy > 0 ? 'higher' : 'lower'} than a year ago`;
    const jobsText = `${pct(unemp)} of workers are without a job`;
    const outText = have ? (Math.abs(growth) < 0.005 ? ', and the realm produces about as much as it did' : `, and the realm produces ${pct(growth)} ${growth > 0 ? 'more' : 'less'} than the year before`) : '';
    news(s, `Year ${yearOf(s.day)} draws to a close: ${pricesText}, ${jobsText}${outText}.`, 'info');
  }
}

/**
 * Evening: strikes count down; unrest — if town.contentment < UNREST_CONTENT for
 * UNREST_DAYS → strike (strikeDays = STRIKE_DAYS) with news; notable-market news
 * (staple shortages daily; price swings > EVENT_SWING in a month, alarms and
 * milestones at month end; bankruptcies are reported by their modules).
 */
export function eventsStep(s: SimState): void {
  unrest(s);
  shortages(s);
  if (isMonthEnd(s.day)) {
    priceSwings(s);
    milestones(s);
  }
}
