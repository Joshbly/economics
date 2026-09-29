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
import { SIM_VERSION } from './config';
import { G, N_GOODS } from './goods';
import { checkLedger, deposits, reconcileBank } from './ledger';
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

const ROUTE_NUMS = ['sellPrice', 'sellMargin', 'inTransit', 'waiting', 'landed', 'shippedToday', 'soldToday', 'shippedTotal', 'soldTotal', 'freightPaid', 'revenue'] as const;

/**
 * Treasury orders and shipments from before supply routes: `route` defaults to null and
 * `Shipment.order` to −1. A damaged route record is repaired (missing counters → 0) or, when
 * its destination or selling rule is unusable, dropped (its goods stay ordinary holdings).
 */
function fillRoutes(s: SimState): void {
  const nT = s.towns.length;
  for (const o of s.policy.orders as unknown as Obj[]) {
    if (!isObj(o)) continue;
    // Orders from before prices could follow the market are fixed-price orders.
    if (o.priceMode !== 'fixed' && o.priceMode !== 'follow' && o.priceMode !== 'any') o.priceMode = 'fixed';
    if (!isNum(o.band) || o.band < 0) o.band = 0;
    const r = o.route;
    if (!isObj(r)) {
      o.route = null;
      continue;
    }
    const m = o.market as Obj | undefined;
    const okTo = isNum(r.to) && r.to >= 0 && r.to < nT && Math.floor(r.to) === r.to;
    const okSell = r.sell === 'fixed' || r.sell === 'cost' || r.sell === 'market';
    if (!okTo || !okSell || !isObj(m) || m.kind !== 'good' || o.side !== 'buy') {
      o.route = null;
      continue;
    }
    for (const k of ROUTE_NUMS) if (!isNum(r[k])) r[k] = 0;
  }
  for (const sh of s.shipments as unknown as Obj[]) if (isObj(sh) && !isNum(sh.order)) sh.order = -1;
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
    if (L.fare !== 'fixed' && L.fare !== 'cost' && L.fare !== 'free') L.fare = 'cost';
    if (typeof L.enabled !== 'boolean') L.enabled = true;
    if (typeof L.label !== 'string') L.label = 'Freight line';
    L.busy = Array.isArray(L.busy) ? (L.busy as unknown[]).filter(isNum) : [];
    if (!(L.wagonsWanted as number >= 1)) L.wagonsWanted = 1;
    out.push(L as unknown as SimState['policy']['lines'][number]);
  }
  s.policy.lines = out;
  for (const sh of s.shipments as unknown as Obj[]) if (isObj(sh) && !isNum(sh.line)) sh.line = -1;
}

/** Fill optional bookkeeping that older or hand-edited saves may lack. */
function fillDefaults(s: SimState): void {
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
  fillRoutes(s);
  fillLines(s);
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
