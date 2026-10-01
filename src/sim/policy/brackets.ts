// ============================================================================
// Price brackets: the Treasury buys a good below a floor and sells it above a ceiling, in every town
// it names, every day — a buffer stock that takes in gluts and lets them out into spikes. A primitive
// of Trade: it is no more than standing orders in each town's market, set each morning. OWNER: policy
// agent. See DESIGN §5 (Trade).
//
// Floor and ceiling (Bracket.mode):
//   'fixed'  low / high are prices (¤), the same in every town;
//   'local'  low / high are fractions below / above each town's own going price — a slow average
//            (an EMA over BRACKET_REF_DAYS of the market's smoothed price, Bracket.ref), so the band
//            holds still while a spike or a glut passes;
//   'realm'  the same fractions around the mean of the towns' going prices: one band for the realm,
//            so the cheap towns' gluts are bought and the dear towns' spikes are sold into.
// A ladder (rungs > 1): rung k bids `step` × k further below the floor — and offers that much above the
// ceiling — for (k + 1) × the day's quantity: the further the price runs, the harder it leans on it.
//
// Each morning a bracket posts, in each of its towns, a bid at each buying rung (while the store there
// holds less than maxStock) and an ask at each selling rung (what the store holds, at most the day's
// quantity) — the Treasury's orders like any (policy/player.playerOrders): exempt from levies, within
// what the Purse can pay, never trading with the Treasury's own orders, sells re-sized before each later
// session to what the store then holds. What fills is tallied on the bracket (bought, spent, sold,
// earned) after the close. Goods it buys sit in the town's store (Treasury.goods) with any other.
// ============================================================================
import { BRACKET_BAND_MAX, BRACKET_MAX_RUNGS, BRACKET_REF_DAYS, BRACKET_STEP_MAX } from '../config';
import { GOODS, N_GOODS } from '../goods';
import type { Bracket, BracketInput, BracketMode, GoodId, PlayerOrder, SimState, TownId } from '../types';
import { clamp, ema, fin } from '../util';

/** The towns a bracket trades in. */
export function bracketTowns(s: SimState, b: Pick<Bracket, 'towns'>): TownId[] {
  return b.towns && b.towns.length ? b.towns.filter((t) => t >= 0 && t < s.towns.length) : s.towns.map((t) => t.id);
}

function goingPrice(s: SimState, town: TownId, good: GoodId): number {
  const m = s.markets[town * N_GOODS + good];
  if (!m) return 0;
  const own = m.ownEma ?? 0;
  const p = own > 0 && Number.isFinite(own) && (m.ownShare ?? 1) >= 0.5 ? own : m.ema > 0 ? m.ema : m.price;
  return p > 0 && Number.isFinite(p) ? p : 0;
}

/** The going price of the bracket's good in a town, as it reckons it (its slow average; today's if none yet). */
export function bracketRef(s: SimState, b: Bracket, town: TownId): number {
  const r = b.ref?.[town];
  return r !== undefined && r > 0 ? r : goingPrice(s, town, b.good);
}

/** Floor and ceiling of the bracket in a town today (rung 0). */
export function bracketBand(s: SimState, b: Bracket, town: TownId): { floor: number; ceiling: number; ref: number } {
  if (b.mode === 'fixed') return { floor: Math.max(0, b.low), ceiling: Math.max(0, b.high), ref: bracketRef(s, b, town) };
  let ref = bracketRef(s, b, town);
  if (b.mode === 'realm') {
    const ts = bracketTowns(s, b);
    let sum = 0;
    let n = 0;
    for (const t of ts) {
      const r = bracketRef(s, b, t);
      if (r > 0) {
        sum += r;
        n++;
      }
    }
    ref = n > 0 ? sum / n : ref;
  }
  return { floor: ref * (1 - clamp(b.low, 0, BRACKET_BAND_MAX)), ceiling: ref * (1 + clamp(b.high, 0, 10)), ref };
}

/** A new bracket (or one switched to another good) starts from today's going prices. */
export function primeBracketRef(s: SimState, b: Bracket): void {
  b.ref = s.towns.map((t) => Math.round(goingPrice(s, t.id, b.good) * 1e4) / 1e4);
}

/** Morning: brackets past their day lapse; each town's going price moves a day toward the market's. */
export function bracketsBeginDay(s: SimState): string[] {
  const list = s.policy.brackets;
  if (!list || list.length === 0) return [];
  const lapsed: string[] = [];
  const keep: Bracket[] = [];
  for (const b of list) {
    if (b.until >= 0 && b.until < s.day) {
      lapsed.push(b.label);
      continue;
    }
    keep.push(b);
    b.boughtToday = 0;
    b.soldToday = 0;
    b.today = s.towns.map(() => 0);
    if (!Array.isArray(b.ref) || b.ref.length !== s.towns.length) b.ref = s.towns.map((t) => Math.round(goingPrice(s, t.id, b.good) * 1e4) / 1e4);
    for (const t of s.towns) {
      const p = goingPrice(s, t.id, b.good);
      if (!(p > 0)) continue;
      const r = b.ref[t.id];
      b.ref[t.id] = Math.round((r > 0 ? ema(r, p, 1 / BRACKET_REF_DAYS) : p) * 1e4) / 1e4;
    }
  }
  if (keep.length !== list.length) s.policy.brackets = keep;
  return lapsed;
}

/** One rung of a bracket in one town today, as an order the Treasury posts (not kept among its orders). */
export interface BracketLeg {
  b: Bracket;
  town: TownId;
  side: 'buy' | 'sell';
  rung: number;
  po: PlayerOrder;
}

/** Order-like records for today's rungs (prices and the most each could take; the order engine caps them by Purse and store). */
export function bracketLegs(s: SimState): BracketLeg[] {
  const out: BracketLeg[] = [];
  const list = s.policy.brackets;
  if (!list || list.length === 0) return out;
  for (const b of list) {
    if (!b.enabled) continue;
    const rungs = clamp(Math.round(fin(b.rungs, 1)), 1, BRACKET_MAX_RUNGS);
    const step = clamp(fin(b.step), 0, BRACKET_STEP_MAX);
    for (const town of bracketTowns(s, b)) {
      const { floor, ceiling } = bracketBand(s, b, town);
      const held = Math.max(0, s.treasury.goods[town]?.[b.good] ?? 0);
      // buying: within what the store may still take
      let room = b.maxStock >= 0 ? Math.max(0, b.maxStock - held) : Infinity;
      for (let k = 0; k < rungs && b.buyQty > 0 && floor > 0; k++) {
        const price = floor * (1 - step * k);
        const qty = Math.min(b.buyQty * (k + 1), room);
        if (!(price > 0) || !(qty > 1e-9)) break;
        room -= qty;
        out.push({ b, town, side: 'buy', rung: k, po: legOrder(s, b, town, 'buy', k, price, qty) });
      }
      for (let k = 0; k < rungs && b.sellQty > 0 && ceiling > 0; k++) {
        const price = ceiling * (1 + step * k);
        const qty = b.sellQty * (k + 1);
        out.push({ b, town, side: 'sell', rung: k, po: legOrder(s, b, town, 'sell', k, price, qty) });
      }
    }
  }
  return out;
}

function legOrder(s: SimState, b: Bracket, town: TownId, side: 'buy' | 'sell', k: number, price: number, qty: number): PlayerOrder {
  return {
    id: -(b.id * 4096 + town * 32 + (side === 'buy' ? 0 : 16) + k + 1), // (a tag of its own: never one of the orders' ids)
    label: b.label,
    enabled: true,
    market: { kind: 'good', town, good: b.good },
    side,
    price: Math.round(price * 1e4) / 1e4,
    qty,
    total: -1,
    until: -1,
    once: false,
    filled: 0,
    value: 0,
    filledToday: 0,
    created: s.day,
    priceMode: 'fixed',
    band: 0,
  };
}

/** After the close: what each rung filled today, tallied on its bracket. */
export function foldBracketFills(legs: readonly BracketLeg[]): void {
  for (const L of legs) {
    const f = Math.max(0, L.po.filled);
    if (!(f > 0)) continue;
    const v = Math.abs(fin(L.po.value));
    if (L.side === 'buy') {
      L.b.bought += f;
      L.b.boughtToday += f;
      if (L.b.today) L.b.today[L.town] = fin(L.b.today[L.town]) + f;
      L.b.spent += v;
    } else {
      L.b.sold += f;
      L.b.soldToday += f;
      if (L.b.today) L.b.today[L.town] = fin(L.b.today[L.town]) - f;
      L.b.earned += v;
    }
  }
  for (const L of legs) {
    L.b.bought = round(L.b.bought);
    L.b.spent = round(L.b.spent);
    L.b.sold = round(L.b.sold);
    L.b.earned = round(L.b.earned);
    L.b.boughtToday = round(L.b.boughtToday);
    L.b.soldToday = round(L.b.soldToday);
    if (L.b.today) L.b.today[L.town] = round(L.b.today[L.town]);
  }
}

const round = (x: number) => Math.round(fin(x) * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Words and checks
// ---------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
const money = (x: number) => `¤${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`;

function townWords(s: SimState, b: Pick<Bracket, 'towns'>): string {
  if (!b.towns || b.towns.length === 0 || b.towns.length >= s.towns.length) return 'in every town';
  const names = b.towns.map((t) => s.towns[t]?.name ?? '?');
  return names.length === 1 ? `in ${names[0]}` : `in ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A plain sentence for a bracket. */
export function describeBracket(s: SimState, b: Bracket): string {
  const g = (GOODS[b.good]?.name ?? 'goods').toLowerCase();
  const band =
    b.mode === 'fixed'
      ? `below ${money(b.low)} and sells it above ${money(b.high)}`
      : b.mode === 'local'
        ? `${pct(b.low)} below each town's going price and sells it ${pct(b.high)} above`
        : `${pct(b.low)} below the realm's going price and sells it ${pct(b.high)} above`;
  const qty = [b.buyQty > 0 ? `${b.buyQty} a day bought` : 'buys nothing', b.sellQty > 0 ? `${b.sellQty} a day sold` : 'sells nothing'].join(', ');
  const ladder = b.rungs > 1 ? `, in ${b.rungs} steps ${pct(b.step)} apart (more at each)` : '';
  const cap = b.maxStock >= 0 ? `, holding at most ${b.maxStock} in each store` : '';
  return `The Treasury buys ${g} ${band}, ${townWords(s, b)}: ${qty}${ladder}${cap}.`;
}

/** A short label: "Grain 10 % ↓ / 15 % ↑, every town". */
export function bracketLabel(s: SimState, b: Pick<Bracket, 'good' | 'mode' | 'low' | 'high' | 'towns'>): string {
  const g = GOODS[b.good]?.name ?? 'Goods';
  const band = b.mode === 'fixed' ? `${money(b.low)}–${money(b.high)}` : `−${pct(b.low)} / +${pct(b.high)}${b.mode === 'realm' ? ' of the realm' : ''}`;
  return `${g} ${band}, ${townWords(s, b).replace(/^in /, '')}`;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Validate the player's bracket (all problems in words); the bracket as it will be kept. */
export function checkBracket(s: SimState, a: Partial<BracketInput>): { ok: true; value: Omit<Bracket, 'id' | 'created' | 'ref' | 'bought' | 'spent' | 'sold' | 'earned' | 'boughtToday' | 'soldToday' | 'today' | 'label' | 'enabled' | 'until'> } | { ok: false; message: string } {
  const good = a.good;
  if (!(Number.isInteger(good) && good! >= 0 && good! < N_GOODS)) return { ok: false, message: 'Choose a good.' };
  const mode: BracketMode = a.mode === 'fixed' || a.mode === 'local' || a.mode === 'realm' ? a.mode : 'local';
  const low = fin(a.low ?? NaN, NaN);
  const high = fin(a.high ?? NaN, NaN);
  if (!isNum(low) || !isNum(high) || low < 0 || high < 0) return { ok: false, message: 'Set a floor and a ceiling.' };
  if (mode === 'fixed') {
    if (!(high > low)) return { ok: false, message: 'The ceiling must be above the floor.' };
    if (!(low > 0) && !(high > 0)) return { ok: false, message: 'Set a floor or a ceiling above ¤0.' };
  } else if (low > BRACKET_BAND_MAX || high > 10) return { ok: false, message: `The floor may be at most ${pct(BRACKET_BAND_MAX)} below the going price.` };
  const buyQty = Math.max(0, fin(a.buyQty ?? 0, 0));
  const sellQty = Math.max(0, fin(a.sellQty ?? 0, 0));
  if (!(buyQty > 0) && !(sellQty > 0)) return { ok: false, message: 'Set how much to buy or sell a day.' };
  const towns = Array.isArray(a.towns) ? [...new Set(a.towns.filter((t) => Number.isInteger(t) && t >= 0 && t < s.towns.length))] : [];
  if (Array.isArray(a.towns) && a.towns.length && !towns.length) return { ok: false, message: 'Unknown town.' };
  const rungs = clamp(Math.round(fin(a.rungs ?? 1, 1)), 1, BRACKET_MAX_RUNGS);
  const step = rungs > 1 ? clamp(fin(a.step ?? 0.05, 0.05), 0.005, BRACKET_STEP_MAX) : 0;
  const maxStock = isNum(a.maxStock) && a.maxStock >= 0 ? a.maxStock : -1;
  return { ok: true, value: { good: good!, towns, mode, low, high, buyQty, sellQty, maxStock, rungs, step } };
}
