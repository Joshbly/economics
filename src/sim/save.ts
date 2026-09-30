// ============================================================================
// Save / load. OWNER: stats agent.
//
// A save is the whole SimState as JSON. Loading validates the shape (version,
// required top-level keys, array lengths that other modules index blindly,
// numbers where JSON may have turned NaN into null), applies migrations for
// older versions, fills defaults for optional bookkeeping, and repairs a small
// bank balance-sheet drift. Problems are reported in plain words.
// Runtime caches (runtime.ts) are never saved; modules rebuild them on demand.
// ============================================================================
import { LAND_MUL_MAX, LAND_MUL_MIN, LOAN_FLOATING_PURPOSES, SIM_VERSION } from './config';
import { G, GOODS, N_GOODS } from './goods';
import { blankCouncil, checkLedger, councilTown, deposits, isCouncil, reconcileBank } from './ledger';
import type { SimState } from './types';

/** Serialise the whole state to JSON (compact). */
export function serialize(s: SimState): string {
  return JSON.stringify(s);
}

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Top-level keys every save must have, with their expected JSON type. */
const REQUIRED: [string, 'number' | 'array' | 'object'][] = [
  ['version', 'number'],
  ['seed', 'number'],
  ['rng', 'array'],
  ['day', 'number'],
  ['startDay', 'number'],
  ['map', 'object'],
  ['towns', 'array'],
  ['buildings', 'array'],
  ['people', 'array'],
  ['firms', 'array'],
  ['loans', 'array'],
  ['shipments', 'array'],
  ['projects', 'array'],
  ['markets', 'array'],
  ['iouMarket', 'object'],
  ['goldMarket', 'object'],
  ['bank', 'object'],
  ['treasury', 'object'],
  ['foreign', 'object'],
  ['policy', 'object'],
  ['stats', 'object'],
  ['news', 'array'],
  ['ids', 'object'],
  ['settings', 'object'],
];

const MAP_ARRAYS = ['terrain', 'elev', 'fert', 'deposit', 'river', 'road', 'occ', 'district'];
const BANK_NUMS = ['reserves', 'windowDebt', 'iou', 'iouBook', 'equity', 'baseRate', 'depositRate'];
const TREASURY_NUMS = ['purse', 'minted', 'burned', 'gold', 'iouOutstanding', 'reserveRate', 'lendRate'];
const FOREIGN_ARRAYS = ['world', 'world0', 'shipCap', 'importsQty', 'exportsQty'];
const IDS = ['person', 'firm', 'building', 'loan', 'shipment', 'project', 'policy'];
/** Fields that may legitimately be null in saved records. */
const NULLABLE = new Set(['curve', 'trade', 'build', 'route']);

function typeOf(x: unknown): string {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  return typeof x;
}

/** Check that every numeric slot of a record (and of its number arrays) holds a finite number. */
function scanRecord(rec: Obj, where: string, out: string[]): void {
  for (const k in rec) {
    const v = rec[k];
    if (v === null) {
      if (!NULLABLE.has(k)) out.push(`${where}.${k} is empty (a number was expected)`);
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) out.push(`${where}.${k} is not a finite number`);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x === null || (typeof x === 'number' && !Number.isFinite(x))) {
          out.push(`${where}.${k}[${i}] is not a number`);
          break;
        }
      }
    }
    if (out.length > 40) return;
  }
}

/**
 * Validate the shape of a parsed save. Returns a list of problems (empty = fine).
 * Checks the version, required keys and their types, the map's per-tile arrays,
 * one market per town × good, id ↔ index consistency of people/firms/buildings,
 * and that the key numeric fields of people, firms, markets, the bank and the
 * Treasury are finite numbers (JSON writes NaN as null).
 */
export function validateSave(raw: unknown): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ['the file does not contain a saved game'];
  if (!('version' in raw) || !('towns' in raw) || !('people' in raw)) return ['this does not look like a Realm Ledger save'];
  const v = raw.version;
  if (!isNum(v) || v < 1 || Math.floor(v) !== v) out.push(`unknown save version "${String(v)}"`);
  else if (v > SIM_VERSION) out.push(`it was made by a newer version of the game (save version ${v}, this game reads up to ${SIM_VERSION})`);
  for (const [k, t] of REQUIRED) {
    if (!(k in raw)) {
      out.push(`the "${k}" section is missing`);
      continue;
    }
    const got = typeOf(raw[k]);
    if (t === 'number' ? !isNum(raw[k]) : got !== t) out.push(`"${k}" should be ${t === 'array' ? 'a list' : t === 'object' ? 'a record' : 'a number'} but is ${got}`);
  }
  if (out.length) return out;

  // rng
  const rng = raw.rng as unknown[];
  if (rng.length !== 4 || !rng.every((x) => isNum(x) && x >= 0 && x <= 0xffffffff)) out.push('the random-number state is damaged');
  if ((raw.day as number) < 0) out.push('the day counter is negative');

  // map
  const map = raw.map as Obj;
  const w = map.w;
  const h = map.h;
  if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) out.push('the map size is missing');
  else {
    const n = w * h;
    for (const k of MAP_ARRAYS) {
      const a = map[k];
      if (!Array.isArray(a)) out.push(`the map layer "${k}" is missing`);
      else if (a.length !== n) out.push(`the map layer "${k}" has ${a.length} tiles, expected ${n}`);
    }
  }

  // towns & markets
  const towns = raw.towns as unknown[];
  if (towns.length === 0) out.push('the realm has no towns');
  towns.forEach((t, i) => {
    if (!isObj(t) || t.id !== i || typeof t.name !== 'string') out.push(`town ${i} is damaged`);
  });
  const markets = raw.markets as unknown[];
  if (markets.length !== towns.length * N_GOODS) out.push(`there are ${markets.length} markets, expected ${towns.length * N_GOODS} (one per town and good)`);
  markets.forEach((m, i) => {
    if (!isObj(m)) {
      out.push(`market ${i} is damaged`);
      return;
    }
    for (const k of ['price', 'ema', 'gross', 'net']) if (!isNum(m[k])) out.push(`market ${i} has no valid ${k}`);
    if (!Array.isArray(m.hist)) out.push(`market ${i} has no price history`);
  });
  for (const k of ['iouMarket', 'goldMarket']) {
    const m = raw[k] as Obj;
    if (!isNum(m.price) || !isNum(m.ema)) out.push(`the ${k === 'iouMarket' ? 'IOU' : 'gold'} market has no valid price`);
  }

  // records indexed by id
  const indexed: [string, string][] = [
    ['people', 'person'],
    ['firms', 'firm'],
    ['buildings', 'building'],
  ];
  for (const [k, label] of indexed) {
    const arr = raw[k] as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (r === null || r === undefined) continue; // sparse slots are tolerated
      if (!isObj(r) || r.id !== i) {
        out.push(`${label} record ${i} is out of place`);
        break;
      }
    }
  }
  const people = raw.people as Obj[];
  for (let i = 0; i < people.length && out.length < 40; i++) {
    const p = people[i];
    if (!isObj(p)) continue;
    if (!Array.isArray(p.pantry) || p.pantry.length !== N_GOODS) out.push(`person ${i} has a damaged pantry`);
    scanRecord(p, `people[${i}]`, out);
  }
  const firms = raw.firms as Obj[];
  for (let i = 0; i < firms.length && out.length < 40; i++) {
    const f = firms[i];
    if (!isObj(f)) continue;
    if (!Array.isArray(f.inv) || f.inv.length !== N_GOODS) out.push(`firm ${i} has a damaged inventory`);
    if (!Array.isArray(f.workers)) out.push(`firm ${i} has no worker list`);
    scanRecord(f, `firms[${i}]`, out);
  }

  // bank, Treasury, foreign desk
  const bank = raw.bank as Obj;
  for (const k of BANK_NUMS) if (!isNum(bank[k])) out.push(`the bank's ${k} is not a number`);
  const tr = raw.treasury as Obj;
  for (const k of TREASURY_NUMS) if (!isNum(tr[k])) out.push(`the Treasury's ${k} is not a number`);
  if (!Array.isArray(tr.goods) || tr.goods.length !== towns.length) out.push("the Treasury's store of goods does not match the towns");
  const fo = raw.foreign as Obj;
  for (const k of FOREIGN_ARRAYS) {
    const a = fo[k];
    if (!Array.isArray(a) || a.length !== N_GOODS) out.push(`the foreign desk's "${k}" list is damaged`);
  }
  if (!isNum(fo.coin) || !isNum(fo.goldPrice)) out.push("the foreign desk's balances are damaged");

  // policy, stats, ids
  const pol = raw.policy as Obj;
  for (const k of ['levies', 'limits', 'orders']) if (!Array.isArray(pol[k])) out.push(`the list of ${k} is missing`);
  const st = raw.stats as Obj;
  for (const k of ['daily', 'monthly']) if (!isObj(st[k])) out.push(`the ${k} statistics are missing`);
  if (!Array.isArray(st.basket) || !Array.isArray(st.basePrices)) out.push('the price-index basket is missing');
  const ids = raw.ids as Obj;
  for (const k of IDS) if (!isNum(ids[k])) out.push(`the id counter "${k}" is missing`);
  if (isNum(ids.person) && ids.person < people.length) out.push('the person id counter is behind the records');
  if (isNum(ids.firm) && ids.firm < firms.length) out.push('the firm id counter is behind the records');
  if (isNum(ids.building) && ids.building < (raw.buildings as unknown[]).length) out.push('the building id counter is behind the records');
  return out;
}

/** Version migrations: MIGRATIONS[v] upgrades a save from version v to v + 1 (in place). */
const MIGRATIONS: Record<number, (raw: Obj) => void> = {};

function migrate(raw: Obj): void {
  let v = raw.version as number;
  while (v < SIM_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`This save (version ${v}) is too old for this game (version ${SIM_VERSION}).`);
    m(raw);
    v += 1;
    raw.version = v;
  }
}

const CARRY_NUMS = ['qty', 'until', 'created', 'allow', 'heldSince', 'carriedToday', 'carried', 'freightToday', 'freight'] as const;

/** A good's name for labels written while loading ("bread"). */
function goodWords(g: number): { name: string } {
  return { name: GOODS[g]?.name.toLowerCase() ?? 'goods' };
}

/**
 * Treasury orders and carry rules. Orders from before prices could follow the market are
 * fixed-price orders; `policy.carries` defaults to [] and `Shipment.order` to −1; a damaged carry
 * rule is repaired (missing counters → 0) or, when its towns or good are unusable, dropped.
 *
 * Saves from before carry rules could hold supply routes: a buy order with a `route` (carry what
 * it buys to another town and offer it there). Each becomes the three primitives it was made of —
 * the buy order itself; a carry rule from its town to the destination (everything held, same
 * wagons); and a sell order there for the route's daily amount (a fixed floor stays; landed cost
 * + margin becomes a fixed floor at today's landed cost + margin; "whatever it fetches" sells at
 * any price). Goods waiting at either end are ordinary holdings already; cargo on the road is
 * re-tagged to the carry rule.
 */
function fillOrders(s: SimState): void {
  const nT = s.towns.length;
  const pol = s.policy as unknown as Obj;
  if (!Array.isArray(pol.carries)) pol.carries = [];
  const okTown = (x: unknown): x is number => isNum(x) && x >= 0 && x < nT && Math.floor(x) === x;
  const okGood = (x: unknown): x is number => isNum(x) && x >= 0 && x < N_GOODS && Math.floor(x) === x;
  const added: Obj[] = [];
  const newCarries: Obj[] = [];
  const retag: Record<number, number> = {};
  for (const o of s.policy.orders as unknown as Obj[]) {
    if (!isObj(o)) continue;
    if (o.priceMode !== 'fixed' && o.priceMode !== 'follow' && o.priceMode !== 'any') o.priceMode = 'fixed';
    if (!isNum(o.band) || o.band < 0) o.band = 0;
    const r = o.route;
    delete o.route;
    const m = o.market as Obj | undefined;
    if (!isObj(r) || !isObj(m) || m.kind !== 'good' || o.side !== 'buy' || !okTown(m.town) || !okGood(m.good) || !okTown(r.to) || r.to === m.town) continue;
    const g = m.good;
    const to = r.to;
    const w = goodWords(g);
    const from = s.towns[m.town]?.name ?? 'town';
    const dest = s.towns[to]?.name ?? 'town';
    const id = s.ids.policy++;
    newCarries.push({
      id,
      label: `Carry ${w.name} · ${from} → ${dest} · all${r.dispatch === 'daily' ? ' · right away' : ''}`,
      enabled: true,
      from: m.town,
      to,
      good: g,
      qty: -1,
      wagons: r.dispatch === 'daily' ? 'now' : 'full',
      until: -1,
      created: s.day,
      allow: 0,
      heldSince: -1,
      carriedToday: 0,
      carried: isNum(r.shippedTotal) ? r.shippedTotal : 0,
      freightToday: 0,
      freight: isNum(r.freightPaid) ? r.freightPaid : 0,
    });
    retag[o.id as number] = id;
    const qty = isNum(o.qty) && o.qty > 0 ? o.qty : 1;
    const landed = isNum(r.landed) && r.landed > 0 ? r.landed : isNum(o.price) ? o.price : 0;
    const fixed = r.sell === 'fixed' && isNum(r.sellPrice) && r.sellPrice > 0 ? r.sellPrice : r.sell === 'cost' && landed > 0 ? landed * (1 + (isNum(r.sellMargin) ? r.sellMargin : 0)) : 0;
    const any = !(fixed > 0);
    added.push({
      id: s.ids.policy++,
      label: `Sell ${qty >= 10 ? Math.round(qty) : qty}/day · ${w.name} in ${dest} · ${any ? 'any price' : `≥ ¤${fixed.toFixed(2)}`}`,
      enabled: true,
      market: { kind: 'good', town: to, good: g },
      side: 'sell',
      price: any ? 0 : Math.round(fixed * 100) / 100,
      qty,
      total: -1,
      until: -1,
      once: false,
      filled: isNum(r.soldTotal) ? r.soldTotal : 0,
      value: isNum(r.revenue) ? -r.revenue : 0,
      filledToday: 0,
      created: s.day,
      priceMode: any ? 'any' : 'fixed',
      band: 0,
    });
  }
  for (const x of added) (s.policy.orders as unknown as Obj[]).push(x);
  const carries: Obj[] = [];
  for (const c of [...(pol.carries as unknown[]), ...newCarries]) {
    if (!isObj(c) || !isNum(c.id) || !okTown(c.from) || !(okTown(c.to) || c.to === -1) || c.from === c.to || !okGood(c.good)) continue;
    for (const k of CARRY_NUMS) if (!isNum(c[k])) c[k] = k === 'qty' || k === 'until' || k === 'heldSince' ? -1 : 0;
    if (c.wagons !== 'full' && c.wagons !== 'now') c.wagons = 'full';
    if (c.sources !== undefined) {
      const src = Array.isArray(c.sources) ? [...new Set((c.sources as unknown[]).filter((t): t is number => okTown(t) && t !== c.to))] : [];
      if (src.length >= 2 && src.includes(c.from as number)) c.sources = src;
      else delete c.sources;
    }
    if (c.need !== undefined && c.need !== true) delete c.need;
    if (typeof c.enabled !== 'boolean') c.enabled = true;
    if (typeof c.label !== 'string') c.label = `Carry ${goodWords(c.good).name}`;
    carries.push(c);
  }
  pol.carries = carries;
  for (const sh of s.shipments as unknown as Obj[]) {
    if (!isObj(sh)) continue;
    if (!isNum(sh.order)) sh.order = -1;
    else if (retag[sh.order] !== undefined) sh.order = retag[sh.order];
  }
}

const LINE_NUMS = [
  'wagonsWanted', 'farePrice', 'fareToday', 'wage', 'created', 'tools', 'wagons', 'oil', 'oilBasis', 'drivers', 'crew', 'useEma', 'costEma', 'unitsEma',
  'carriedToday', 'legsToday', 'faresToday', 'costToday', 'carried', 'legs', 'fares', 'wages', 'fuelCost', 'wear', 'oilSpent', 'toolsSpent',
] as const;

/**
 * Saves from before freight lines: `policy.lines` defaults to [] and `Shipment.line` to −1. A
 * damaged line is repaired (missing counters → 0, a bad fare rule → 'cost') or, when its towns are
 * unusable, dropped — its wagons and fuel go to the Treasury's stores in its first town if that exists.
 */
function fillLines(s: SimState): void {
  const nT = s.towns.length;
  const raw = (s.policy as unknown as Obj).lines;
  const out: SimState['policy']['lines'] = [];
  const okTown = (x: unknown): x is number => isNum(x) && x >= 0 && x < nT && Math.floor(x) === x;
  for (const L of Array.isArray(raw) ? (raw as unknown[]) : []) {
    if (!isObj(L) || !isNum(L.id)) continue;
    if (!okTown(L.a) || !okTown(L.b) || L.a === L.b) {
      if (okTown(L.a)) {
        const tg = s.treasury.goods[L.a as number];
        if (Array.isArray(tg)) {
          if (isNum(L.tools) && L.tools > 0) tg[G.tools] += L.tools;
          if (isNum(L.oil) && L.oil > 0) tg[G.oil] += L.oil;
        }
      }
      continue;
    }
    for (const k of LINE_NUMS) if (!isNum(L[k])) L[k] = 0;
    if (L.fare !== 'fixed' && L.fare !== 'cost' && L.fare !== 'under' && L.fare !== 'free') L.fare = 'cost';
    if (L.margin !== undefined && !isNum(L.margin)) delete L.margin;
    if (typeof L.enabled !== 'boolean') L.enabled = true;
    if (typeof L.label !== 'string') L.label = 'Freight line';
    if (L.staffing !== 'asNeeded' && L.staffing !== 'permanent') L.staffing = 'asNeeded';
    L.staff = Array.isArray(L.staff) ? (L.staff as unknown[]).filter((x): x is number => isNum(x) && x >= 0 && Math.floor(x) === x) : [];
    L.busy = Array.isArray(L.busy) ? (L.busy as unknown[]).filter(isNum) : [];
    if (!(L.wagonsWanted as number >= 1)) L.wagonsWanted = 1;
    out.push(L as unknown as SimState['policy']['lines'][number]);
  }
  s.policy.lines = out;
  for (const sh of s.shipments as unknown as Obj[]) if (isObj(sh) && !isNum(sh.line)) sh.line = -1;
}

/** Fill optional bookkeeping that older or hand-edited saves may lack. */
/**
 * Shares of firms and the realm's investment experience: a damaged holding (not a person or firm,
 * a share not in (0, 1)) is dropped — its share falls back to the controlling owner; damaged
 * network weights or records reset the experience (it is relearnt).
 */
function fillInvest(s: SimState): void {
  for (const f of s.firms) {
    if (!f || !f.partners) continue;
    const ok = Array.isArray(f.partners)
      ? (f.partners as unknown[]).filter((p): p is { ref: number; share: number } => isObj(p) && isNum((p as Obj).ref) && isNum((p as Obj).share) && ((p as Obj).share as number) > 0 && ((p as Obj).share as number) < 1)
      : [];
    let tot = 0;
    for (const p of ok) tot += p.share;
    if (!ok.length || tot >= 1) delete f.partners;
    else f.partners = ok;
  }
  for (const p of s.projects) {
    if (!p || !p.partners) continue;
    if (!Array.isArray(p.partners)) delete p.partners;
    else p.partners = (p.partners as unknown[]).filter((q): q is { ref: number; share: number; paid: number } => isObj(q) && isNum((q as Obj).ref) && isNum((q as Obj).share) && isNum((q as Obj).paid));
  }
  const inv = s.invest as unknown;
  if (inv === undefined) return;
  const n = isObj(inv) && isObj((inv as Obj).net) ? ((inv as Obj).net as Obj) : null;
  const arr = (x: unknown) => Array.isArray(x) && (x as unknown[]).every(isNum);
  if (!n || !arr(n.w1) || !arr(n.b1) || !arr(n.w2) || !isNum(n.b2) || !Array.isArray((inv as Obj).pending)) {
    delete s.invest;
    return;
  }
  if (!isNum(n.trained)) n.trained = 0;
  if (!isNum(n.err)) n.err = 0;
  s.invest!.pending = s.invest!.pending.filter((r) => isObj(r) && isNum(r.project) && isNum(r.firm) && isNum(r.day) && arr(r.x) && isNum(r.promised) && isNum(r.capital));
}

/** Town councils (agents/council.ts): saves from before them get an empty council each; damaged fields are repaired (a purse is kept as it was: it is a deposit the bank owes). */
function fillCouncils(s: SimState): void {
  const years = (y: unknown) => {
    const b = blankCouncil().year;
    if (!isObj(y)) return b;
    for (const k of Object.keys(b) as (keyof typeof b)[]) if (isNum((y as Obj)[k])) b[k] = (y as Obj)[k] as number;
    return b;
  };
  // a new building's plot: the council it is bought from, what was paid and what is owed
  for (const p of s.projects) {
    if (!p) continue;
    if (p.landTo !== undefined && !(isNum(p.landTo) && isCouncil(p.landTo as number) && s.towns[councilTown(p.landTo as number)])) {
      delete p.landTo;
      delete p.landDue;
      delete p.landPaid;
      continue;
    }
    if (p.landPaid !== undefined && !(isNum(p.landPaid) && (p.landPaid as number) >= 0)) p.landPaid = 0;
    if (p.landDue !== undefined && !(isNum(p.landDue) && (p.landDue as number) > 0)) delete p.landDue;
  }
  for (const t of s.towns) {
    if (!t) continue;
    if (t.evictions !== undefined && !isNum(t.evictions)) delete t.evictions;
    const c = t.council as unknown;
    if (!isObj(c)) {
      t.council = blankCouncil();
      continue;
    }
    const o = c as Obj;
    const mayor = isNum(o.mayor) && s.people[o.mayor as number]?.alive ? (o.mayor as number) : -1;
    const landMul = isNum(o.landMul) ? Math.min(LAND_MUL_MAX, Math.max(LAND_MUL_MIN, o.landMul as number)) : 1;
    t.council = { purse: isNum(o.purse) ? (o.purse as number) : 0, mayor, since: isNum(o.since) ? (o.since as number) : -1, landMul, year: years(o.year), last: years(o.last) };
  }
}

function fillDefaults(s: SimState): void {
  fillInvest(s);
  fillCouncils(s);
  if (s.drawSalt !== undefined && !isNum(s.drawSalt)) delete s.drawSalt;
  // the IOU market's memory (agents/bonds.ts): rebuilt from today's rate if damaged
  const dm = s.treasury.debt as unknown;
  if (dm !== undefined && !(isObj(dm) && isNum((dm as Obj).rateEma) && isNum((dm as Obj).stress) && isNum((dm as Obj).lastCut))) delete s.treasury.debt;
  const st = s.stats;
  st.acc = isObj(st.acc) ? st.acc : {};
  st.macc = isObj(st.macc) ? st.macc : {};
  st.latest = isObj(st.latest) ? st.latest : {};
  if (!isNum(st.dailyStart)) st.dailyStart = s.day;
  if (!isNum(st.monthlyStart)) st.monthlyStart = Math.floor(s.day / 30);
  if (!isNum(st.basketRent)) st.basketRent = 1;
  const t = s.treasury;
  t.flows = isObj(t.flows) ? t.flows : {};
  t.flowsMonth = isObj(t.flowsMonth) ? t.flowsMonth : {};
  t.flowsLastMonth = isObj(t.flowsLastMonth) ? t.flowsLastMonth : {};
  if (typeof t.autoMint !== 'boolean') t.autoMint = false;
  if (!Array.isArray(s.foreign.shocks)) s.foreign.shocks = [];
  if (!Array.isArray(s.bank.requests)) s.bank.requests = [];
  for (const f of s.firms) {
    if (!f) continue;
    if (!isNum(f.salesLong)) f.salesLong = 0;
    if (!Array.isArray(f.salesMonths) || f.salesMonths.length !== 12) f.salesMonths = new Array(12).fill(-1);
    if (!isNum(f.monthSold)) f.monthSold = 0;
    if (!isNum(f.profitLong)) f.profitLong = 0;
  }
  fillOrders(s);
  fillLines(s);
  // Loans from before fixed rates: term credit keeps the rate it carries now; credit lines float.
  for (const ln of s.loans) if (ln && typeof ln.fixed !== 'boolean') ln.fixed = !LOAN_FLOATING_PURPOSES.includes(ln.purpose);
  const set = s.settings;
  if (typeof set.events !== 'boolean') set.events = true;
  if (typeof set.scenario !== 'string') set.scenario = 'founding';
  if (typeof set.realmName !== 'string') set.realmName = 'The Realm';
}

/** Parse and validate a saved game; throws Error with a readable message if invalid. */
export function deserialize(json: string): SimState {
  if (typeof json !== 'string' || json.trim() === '') throw new Error('The save is empty.');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`This save file is damaged: it is not valid JSON (${e instanceof Error ? e.message : String(e)}).`);
  }
  const problems = validateSave(raw);
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('; ');
    const more = problems.length > 5 ? ` (and ${problems.length - 5} more problems)` : '';
    throw new Error(`This save cannot be loaded: ${shown}${more}.`);
  }
  migrate(raw as Obj);
  const s = raw as SimState;
  fillDefaults(s);
  // The bank's balance sheet must balance exactly; repair rounding drift from hand edits.
  const err = checkLedger(s);
  if (!Number.isFinite(err)) throw new Error('This save cannot be loaded: the bank ledger does not add up.');
  if (Math.abs(err) > 1e-6 * Math.max(1, deposits(s))) reconcileBank(s);
  return s;
}
