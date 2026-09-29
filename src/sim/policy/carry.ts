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
// ============================================================================
import { GOODS, N_GOODS } from '../goods';
import { dateLabel } from '../calendar';
import { rt } from '../runtime';
import { STATE } from '../types';
import type { CarryRule, SimState } from '../types';
import { CARRY_FULL_SHARE, CARRY_MAX_HOLD_DAYS, CARRY_SPOIL_BUDGET, MARKET_SESSIONS, SESSION_TIMES, WAGON_CAPACITY } from '../config';
import { sendTreasuryCargo } from '../agents/traders';
import { lineOffer } from './lines';
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

/** A short label: "Carry bread · Millbrook → Saltmere · all" / "· 40/day". */
export function carryLabel(s: SimState, c: Pick<CarryRule, 'from' | 'to' | 'good' | 'qty' | 'wagons'>): string {
  const g = GOODS[c.good]?.name.toLowerCase() ?? 'goods';
  const q = c.qty >= 0 ? `${amountText(c.good, c.qty).split(' ')[0]}/day` : 'all';
  return `Carry ${g} · ${townName(s, c.from)} → ${townName(s, c.to)} · ${q}${c.wagons === 'now' ? ' · right away' : ''}`;
}

/** A carry rule in a plain sentence. */
export function describeCarry(s: SimState, c: CarryRule): string {
  const g = GOODS[c.good]?.name.toLowerCase() ?? 'goods';
  const what = c.qty >= 0 ? `up to ${amountText(c.good, c.qty)} a day of the ${g} it holds` : `all the ${g} it holds`;
  const how = c.wagons === 'now' ? 'as soon as a market session ends' : `in full wagons (or after ${carryHoldDays(c.good) === 1 ? 'a day' : `${carryHoldDays(c.good)} days`} of waiting)`;
  const span = c.until >= 0 ? ` until ${dateLabel(c.until)}` : '';
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
    if (!(c.from >= 0 && c.from < s.towns.length && c.to >= 0 && c.to < s.towns.length) || c.from === c.to) continue;
    if (!(c.good >= 0 && c.good < N_GOODS)) continue;
    const avail = carryAvailable(s, c);
    if (!(avail > 1e-6)) {
      c.heldSince = -1;
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
      if (c.qty >= 0) c.allow = Math.max(0, c.allow - res.qty);
      c.carriedToday += res.qty;
      c.carried += res.qty;
      c.freightToday += res.paid;
      c.freight += res.paid;
    } else if (!res.ok) {
      const fails = (rt(s).bag.carryFails ??= {}) as Record<number, number>;
      if (fails[c.id] !== s.day - 1 && fails[c.id] !== s.day) {
        const why = res.message.charAt(0).toLowerCase() + res.message.slice(1);
        news(s, `The Treasury's ${GOODS[c.good]?.name.toLowerCase() ?? 'goods'} for ${townName(s, c.to)} wait in ${townName(s, c.from)}: ${why}`, 'policy', c.from);
      }
      fails[c.id] = s.day;
    }
  }
}
