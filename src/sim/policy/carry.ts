// ============================================================================
// Treasury carry rules (s.policy.carries): move the Treasury's own goods from its
// store in one town to its store in another. OWNER: market-policy agent. See
// DESIGN §5 (Trade).
//
// A carry neither buys nor sells. Goods reach a store because an order bought them
// there (or cargo landed, or a line handed back its wagons); they leave it because
// an order sold them, a transfer handed them out, or a carry loaded them. So a
// "supply route" is three primitives side by side: a buy order in A, a carry
// A → B, and a sell order in B — each listed, paused and changed on its own.
//
// Mechanics: after every market session (markets.clearAll → player.playerAfterSession)
// each rule looks at what the Treasury holds of its good in `from` and loads what it
// may (traders.sendTreasuryCargo: a Treasury freight line on that road first, else
// the trading house of `from`, for freight from the Purse). Wagons leave at noon or
// after the session that filled them, and the goods land in the store at `to` when
// they arrive — in time for the next session there. Cargo is tagged with the rule's
// id (Shipment.order) only so the map and the stores view can say whose it is.
//
// 'full' rules wait for a fuller wagon — the Purse pays a whole wagon's trip however
// little it carries: a wagon leaves once it is CARRY_FULL_SHARE full, or once the
// goods have waited as long as they keep (carryHoldDays), or when a Treasury freight
// line on the road has room, or at the close of the rule's last day. 'now' rules
// send what is held after every session. A rule with a daily amount (qty ≥ 0) may
// load qty a day; while its goods wait for a fuller wagon the allowance is banked
// (at most CARRY_MAX_HOLD_DAYS days of it).
//
// Several Treasury uses of one store never double-count: whatever a sell order,
// a transfer or an earlier rule took is simply no longer held.
//
// A rule may carry to "wherever it runs short" (to −1) instead of one town. It serves
// the towns where the Treasury has a sell order for the good — the sell orders say
// where the goods are to be offered, the rule decides which of those towns gets the
// next load: the one that needs it most (shortTargets) — its average daily shortage
// over the last MARKET_BALANCE_DAYS days plus what the Treasury sold there a day
// (never more than its sell orders there offer a day), over the days a load takes to
// arrive plus one, less what the Treasury holds there or has on the road to it.
// When no served town needs any, the goods wait where they are.
// ============================================================================
import { GOODS, N_GOODS } from '../goods';
import { dateLabel } from '../calendar';
import { rt } from '../runtime';
import { STATE } from '../types';
import type { CarryRule, SimState } from '../types';
import { CARRY_FULL_SHARE, CARRY_MAX_HOLD_DAYS, CARRY_SPOIL_BUDGET, MARKET_SESSIONS, SESSION_TIMES, WAGON_CAPACITY } from '../config';
import { sendTreasuryCargo } from '../agents/traders';
import { lineOffer, usableRoute } from './lines';
import { recentBalance } from '../market/markets';
import { news } from '../stats/events';

/**
 * Days goods may wait in a store for a fuller wagon: until waiting longer would cost the good more
 * than CARRY_SPOIL_BUDGET to spoilage (bread 2, ale 3), at most CARRY_MAX_HOLD_DAYS.
 */
export function carryHoldDays(good: number): number {
  const sp = GOODS[good]?.spoil ?? 0;
  if (!(sp > 0)) return CARRY_MAX_HOLD_DAYS;
  const d = Math.floor(Math.log(1 - CARRY_SPOIL_BUDGET) / Math.log(1 - sp) + 1e-9);
  return Math.max(1, Math.min(CARRY_MAX_HOLD_DAYS, d));
}

/**
 * How much of `avail` leaves now. 'full': whole wagons at least CARRY_FULL_SHARE full — or
 * everything once it has waited carryHoldDays, a freight line has room, or the rule is closing;
 * 'now' (and a closing rule): everything. 0 = keep collecting.
 */
export function carryLoadNow(avail: number, wagons: CarryRule['wagons'], collecting: boolean, age: number, good: number, lineRoom: number): number {
  if (!(avail > 1e-6)) return 0;
  if (wagons === 'now' || !collecting) return avail;
  if (lineRoom > 0.5 || age >= carryHoldDays(good)) return avail;
  const perWagon = CARRY_FULL_SHARE * WAGON_CAPACITY;
  if (avail < perWagon - 1e-6) return 0;
  // whole wagons only: the last one at least CARRY_FULL_SHARE full
  const n = Math.floor(avail / WAGON_CAPACITY);
  const rest = avail - n * WAGON_CAPACITY;
  return rest >= perWagon - 1e-6 ? avail : Math.max(perWagon, n * WAGON_CAPACITY);
}

/** The carry rule with this id, or undefined. */
export function carryById(s: SimState, id: number): CarryRule | undefined {
  const cs = s.policy.carries;
  if (!cs) return undefined;
  for (let i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
  return undefined;
}

/** Units a rule has on the road now (the Treasury cargo tagged with it). */
export function carryOnRoad(s: SimState, id: number): number {
  let n = 0;
  for (const sh of s.shipments) if (sh && sh.owner === STATE && sh.order === id) n += Math.max(0, sh.qty);
  return n;
}

/** What a rule could load right now: the store's holdings of its good, within its daily allowance. */
export function carryAvailable(s: SimState, c: CarryRule): number {
  const held = Math.max(0, s.treasury.goods[c.from]?.[c.good] ?? 0);
  return c.qty >= 0 ? Math.min(held, Math.max(0, c.allow)) : held;
}

/** Is the rule running today (enabled and not past its last day)? */
export function carryActive(s: SimState, c: CarryRule): boolean {
  return c.enabled && !(c.until >= 0 && c.until < s.day);
}

function townName(s: SimState, t: number): string {
  return s.towns[t]?.name ?? `town ${t}`;
}

function amountText(g: number, q: number): string {
  const u = GOODS[g]?.unit ?? 'unit';
  const n = q >= 100 ? String(Math.round(q)) : q >= 10 ? q.toFixed(1).replace(/\.0$/, '') : q.toFixed(2).replace(/\.?0+$/, '');
  const plural = Math.abs(q - 1) < 1e-9 ? u : u.endsWith('f') ? u.slice(0, -1) + 'ves' : u.endsWith('s') ? u + 'es' : u + 's';
  return `${n} ${plural}`;
}

/** Where a rule carries to, in words: a town's name, or "where it runs short". */
export function carryDest(s: SimState, c: Pick<CarryRule, 'to'>): string {
  return c.to >= 0 ? townName(s, c.to) : 'where it runs short';
}

/** A short label: "Carry bread · Millbrook → Saltmere · all" / "· 40/day". */
export function carryLabel(s: SimState, c: Pick<CarryRule, 'from' | 'to' | 'good' | 'qty' | 'wagons'>): string {
  const g = GOODS[c.good]?.name.toLowerCase() ?? 'goods';
  const q = c.qty >= 0 ? `${amountText(c.good, c.qty).split(' ')[0]}/day` : 'all';
  return `Carry ${g} · ${townName(s, c.from)} → ${carryDest(s, c)} · ${q}${c.wagons === 'now' ? ' · right away' : ''}`;
}

/** A town a "where it runs short" rule serves, and what it needs now. */
export interface ShortTarget {
  town: number;
  /** Units it could use now (≤ 0: none). */
  need: number;
  /** Average daily shortage there over the last days, what the Treasury sold there a day, and what its sell orders there offer a day. */
  shortage: number;
  sold: number;
  offered: number;
  held: number;
  onRoad: number;
  /** Days a load takes to arrive. */
  days: number;
}

/**
 * The towns a "where it runs short" rule serves — every town other than its own with a wagon road
 * to it and a running Treasury sell order for the good — neediest first (see the header).
 */
export function shortTargets(s: SimState, c: Pick<CarryRule, 'from' | 'good'>): ShortTarget[] {
  const offered = new Map<number, number>();
  for (const o of s.policy.orders) {
    if (!o.enabled || o.side !== 'sell' || o.market.kind !== 'good' || o.market.good !== c.good) continue;
    if (o.until >= 0 && o.until < s.day) continue;
    if (o.total >= 0 && o.filled >= o.total - 1e-9) continue;
    const t = o.market.town;
    if (t === c.from || !(t >= 0 && t < s.towns.length)) continue;
    offered.set(t, (offered.get(t) ?? 0) + Math.max(0, o.qty));
  }
  const out: ShortTarget[] = [];
  for (const [town, offer] of offered) {
    const r = usableRoute(s, c.from, town);
    if (!r) continue;
    const b = recentBalance(s.markets[town * N_GOODS + c.good]);
    let onRoad = 0;
    for (const sh of s.shipments) if (sh && sh.owner === STATE && sh.to === town && sh.good === c.good) onRoad += Math.max(0, sh.qty);
    const held = Math.max(0, s.treasury.goods[town]?.[c.good] ?? 0);
    const days = Math.max(1, Math.ceil(r.days));
    const rate = Math.min(b.shortage + b.treasury, offer);
    out.push({ town, need: rate * (days + 1) - held - onRoad, shortage: b.shortage, sold: b.treasury, offered: offer, held, onRoad, days });
  }
  return out.sort((x, y) => y.need - x.need || x.town - y.town);
}

/** A carry rule in a plain sentence. */
export function describeCarry(s: SimState, c: CarryRule): string {
  const g = GOODS[c.good]?.name.toLowerCase() ?? 'goods';
  const what = c.qty >= 0 ? `up to ${amountText(c.good, c.qty)} a day of the ${g} it holds` : `all the ${g} it holds`;
  const how = c.wagons === 'now' ? 'as soon as a market session ends' : `in full wagons (or after ${carryHoldDays(c.good) === 1 ? 'a day' : `${carryHoldDays(c.good)} days`} of waiting)`;
  const span = c.until >= 0 ? ` until ${dateLabel(c.until)}` : '';
  if (c.to < 0)
    return `The Treasury will carry ${what} in ${townName(s, c.from)} to wherever it runs short — each load to the town, of those where it sells ${g}, that needs it most — ${how}${span}.`;
  return `The Treasury will carry ${what} in ${townName(s, c.from)} to its store in ${townName(s, c.to)}, ${how}${span}.`;
}

/**
 * Morning: drop rules past their last day (their cargo on the road still lands), reset today's
 * counts and add the day's allowance of rules with a daily amount.
 */
export function carriesBeginDay(s: SimState): void {
  const cs = s.policy.carries;
  if (!cs || !cs.length) return;
  const keep: CarryRule[] = [];
  for (const c of cs) {
    if (c.until >= 0 && c.until < s.day) {
      news(s, `The Treasury has stopped carrying ${GOODS[c.good]?.name.toLowerCase() ?? 'goods'} from ${townName(s, c.from)} to ${townName(s, c.to)} (${amountText(c.good, c.carried)} carried in all).`, 'policy', c.from);
      continue;
    }
    keep.push(c);
  }
  if (keep.length !== cs.length) s.policy.carries = keep;
  for (const c of s.policy.carries) {
    c.carriedToday = 0;
    c.freightToday = 0;
    if (c.qty >= 0) {
      const waiting = c.wagons === 'full' && c.heldSince >= 0;
      c.allow = waiting ? Math.min(Math.max(0, c.allow) + c.qty, c.qty * CARRY_MAX_HOLD_DAYS) : c.qty;
    }
  }
}

/**
 * After market session `session`: every running rule loads what it may. On days freight cannot be
 * paid (auto-mint off, Purse short) or no one can carry, the goods stay in the store and the rule
 * tries again after the next session; the news says why on the first day of such a spell.
 */
export function runCarries(s: SimState, session: number): void {
  const cs = s.policy.carries;
  if (!cs || !cs.length) return;
  // Wagons leave at noon, or after a later session (goods bought at the close leave that evening).
  const depart = s.day + Math.max(0.5, (SESSION_TIMES[session] ?? 0.5) + 0.05);
  const closing = session >= MARKET_SESSIONS - 1;
  for (const c of cs) {
    if (!carryActive(s, c)) continue;
    if (!(c.from >= 0 && c.from < s.towns.length && c.to >= -1 && c.to < s.towns.length) || c.from === c.to) continue;
    if (!(c.good >= 0 && c.good < N_GOODS)) continue;
    const avail = carryAvailable(s, c);
    if (!(avail > 1e-6)) {
      c.heldSince = -1;
      continue;
    }
    if (c.to < 0) {
      carryWhereShort(s, c, avail, depart, closing);
      continue;
    }
    if (!(c.heldSince >= 0)) c.heldSince = s.day;
    const collecting = !(closing && c.until === s.day);
    const lineRoom = s.policy.lines?.length ? (lineOffer(s, c.from, c.to)?.room ?? 0) : 0;
    const load = Math.min(avail, carryLoadNow(avail, c.wagons, collecting, s.day - c.heldSince, c.good, lineRoom));
    if (!(load > 1e-6)) continue; // keep collecting for a fuller wagon
    const res = sendTreasuryCargo(s, c.from, c.to, c.good, load, { order: c.id, depart });
    if (res.ok && res.qty > 0) {
      c.heldSince = avail - res.qty > 1e-6 ? s.day : -1; // what is left starts a new load
      booked(c, res.qty, res.paid);
    } else if (!res.ok) failed(s, c, c.to, res.message);
  }
}

/** Book a load on the rule. */
function booked(c: CarryRule, qty: number, paid: number): void {
  if (c.qty >= 0) c.allow = Math.max(0, c.allow - qty);
  c.carriedToday += qty;
  c.carried += qty;
  c.freightToday += paid;
  c.freight += paid;
}

/** A load that could not leave: say why on the first day of a spell. */
function failed(s: SimState, c: CarryRule, to: number, message: string): void {
  const fails = (rt(s).bag.carryFails ??= {}) as Record<number, number>;
  if (fails[c.id] !== s.day - 1 && fails[c.id] !== s.day) {
    const why = message.charAt(0).toLowerCase() + message.slice(1);
    news(s, `The Treasury's ${GOODS[c.good]?.name.toLowerCase() ?? 'goods'} for ${townName(s, to)} wait in ${townName(s, c.from)}: ${why}`, 'policy', c.from);
  }
  fails[c.id] = s.day;
}

/**
 * A "where it runs short" rule after a session: loads for the neediest served towns in turn (each
 * no more than it needs; 'full' rules keep collecting below a full wagon as usual). Nothing needed
 * anywhere: the goods wait in the store (and are not counted as waiting for a wagon).
 */
function carryWhereShort(s: SimState, c: CarryRule, avail: number, depart: number, closing: boolean): void {
  const targets = shortTargets(s, c).filter((x) => x.need > 0.5);
  if (!targets.length) {
    c.heldSince = -1;
    return;
  }
  if (!(c.heldSince >= 0)) c.heldSince = s.day;
  const collecting = !(closing && c.until === s.day);
  let left = avail;
  let sent = false;
  for (const x of targets) {
    if (!(left > 1e-6)) break;
    const want = Math.min(left, x.need);
    const lineRoom = s.policy.lines?.length ? (lineOffer(s, c.from, x.town)?.room ?? 0) : 0;
    const load = Math.min(want, carryLoadNow(want, c.wagons, collecting, s.day - c.heldSince, c.good, lineRoom));
    if (!(load > 1e-6)) continue;
    const res = sendTreasuryCargo(s, c.from, x.town, c.good, load, { order: c.id, depart });
    if (res.ok && res.qty > 0) {
      left -= res.qty;
      sent = true;
      booked(c, res.qty, res.paid);
    } else if (!res.ok) {
      failed(s, c, x.town, res.message);
      break;
    }
  }
  if (sent) c.heldSince = left > 1e-6 ? s.day : -1;
}
