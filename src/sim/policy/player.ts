// ============================================================================
// The player's primitives: validation + execution of PlayerActions, Treasury
// orders in markets, Treasury workforce, transfers. See DESIGN §5.
// OWNER: market-policy agent.
//
// Nothing here is a "policy": the player composes seven neutral primitives
// (Mint, Trade, Levy, Limit, Window, Build, Transfer) and the economy responds.
// All player-facing text describes mechanics plainly ("The Treasury now takes
// 10 % of the value of every bread sale in Millbrook, charged to buyers").
// ============================================================================
import {
  IOU_COUPON,
  IOU_PAR,
  PLAYER_MAX_MONEY,
  PLAYER_MAX_PCT,
  PLAYER_MAX_PRICE,
  PLAYER_MAX_QTY,
  PLAYER_MAX_RATE,
  PLAYER_MAX_RULES,
  PLAYER_MAX_UNIT_RATE,
  PLAYER_MAX_WORKERS,
  PLAYER_MIN_RATE,
  PRICE_MIN,
  IOU_SELL_FLOOR_MIN_SHARE,
  SELL_FLOOR_WARN_SHARE,
} from '../config';
import { dateLabel } from '../calendar';
import { GOODS, N_GOODS, SECTORS } from '../goods';
import { burn, mint, pay } from '../ledger';
import { rt } from '../runtime';
import { BANK, FIRM_BASE, STATE } from '../types';
import type {
  ActionResult,
  BuildingKind,
  Firm,
  Group,
  Levy,
  LevyBase,
  LevyPayer,
  LevyUnit,
  Limit,
  LimitKind,
  Order,
  OrderMarket,
  PlayerAction,
  PlayerOrder,
  Sector,
  SimState,
  TownId,
  TransferGroup,
} from '../types';
import { addAsk, addBid, type Books } from '../market/markets';
import { bankClaimRoom, inGroup } from './levies';
import { news } from '../stats/events';
import { cancelProject, estimateCost, startProject } from '../agents/construction';
import { shipTreasuryGoods } from '../agents/traders';
import { roadPlan } from '../world/paths';

// ---------------------------------------------------------------------------
// Vocabulary & validation tables
// ---------------------------------------------------------------------------
const LEVY_BASES: LevyBase[] = ['sale', 'wage', 'profit', 'money', 'goods', 'head', 'rent', 'interest', 'shipment', 'import', 'export', 'building', 'estate'];
const LEVY_UNITS: LevyUnit[] = ['pct', 'perUnit', 'flat'];
const GROUPS: Group[] = ['all', 'employed', 'unemployed', 'homeless', 'owners', 'nonowners', 'hungry', 'persons', 'firms'];
const BUILDING_KINDS: BuildingKind[] = ['house', 'firm', 'market', 'bank', 'palace', 'port'];
const LIMIT_KINDS: LimitKind[] = ['priceMax', 'priceMin', 'wageMin', 'wageMax', 'rentMax', 'rentMin', 'rateMax', 'importMax', 'exportMax', 'shipMax', 'reserveMin', 'capitalMin'];
const ALL_SECTOR_KEYS = Object.keys(SECTORS) as Sector[];

/** Units that make sense for each base (first = default). */
const UNITS_FOR: Record<LevyBase, LevyUnit[]> = {
  sale: ['pct', 'perUnit'],
  wage: ['pct', 'perUnit'],
  profit: ['pct'],
  money: ['pct', 'flat'],
  goods: ['perUnit', 'pct', 'flat'],
  head: ['flat'],
  rent: ['pct', 'perUnit'],
  interest: ['pct'],
  shipment: ['perUnit', 'pct'],
  import: ['pct', 'perUnit'],
  export: ['pct', 'perUnit'],
  building: ['flat', 'pct'],
  estate: ['pct', 'flat'],
};

/** Payer roles for each base (first = default). */
const PAYERS_FOR: Record<LevyBase, LevyPayer[]> = {
  sale: ['buyer', 'seller'],
  wage: ['worker', 'employer'],
  profit: ['owner'],
  money: ['holder'],
  goods: ['holder'],
  head: ['receiver'],
  rent: ['tenant', 'landlord'],
  interest: ['receiver'],
  shipment: ['owner'],
  import: ['buyer'],
  export: ['seller'],
  building: ['owner'],
  estate: ['receiver'],
};

/** Which filters are meaningful for each base (others are normalised to "any"). */
const FILTERS_FOR: Record<LevyBase, { good: boolean; town: boolean; toTown: boolean; sector: boolean; group: boolean; kind: boolean }> = {
  sale: { good: true, town: true, toTown: false, sector: false, group: false, kind: false },
  wage: { good: false, town: true, toTown: false, sector: true, group: true, kind: false },
  profit: { good: false, town: true, toTown: false, sector: true, group: false, kind: false },
  money: { good: false, town: true, toTown: false, sector: true, group: true, kind: false },
  goods: { good: true, town: true, toTown: false, sector: true, group: true, kind: false },
  head: { good: false, town: true, toTown: false, sector: false, group: true, kind: false },
  rent: { good: false, town: true, toTown: false, sector: false, group: true, kind: false },
  interest: { good: false, town: true, toTown: false, sector: false, group: true, kind: false },
  shipment: { good: true, town: true, toTown: true, sector: false, group: false, kind: false },
  import: { good: true, town: false, toTown: false, sector: false, group: false, kind: false },
  export: { good: true, town: false, toTown: false, sector: false, group: false, kind: false },
  building: { good: false, town: true, toTown: false, sector: true, group: false, kind: true },
  estate: { good: false, town: true, toTown: false, sector: false, group: true, kind: false },
};

/** Stock bases: percentage rates are per YEAR. */
const STOCK_BASES: Partial<Record<LevyBase, true>> = { money: true, goods: true, building: true };

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => isNum(x) && Math.floor(x) === x;
const fail = (message: string): ActionResult => ({ ok: false, message });

function validTown(s: SimState, t: unknown): t is number {
  return isInt(t) && t >= 0 && t < s.towns.length;
}
function validGood(g: unknown): g is number {
  return isInt(g) && g >= 0 && g < N_GOODS;
}

// ---------------------------------------------------------------------------
// Text helpers (neutral, plain language)
// ---------------------------------------------------------------------------
function withCommas(n: number): string {
  const s = Math.round(n).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "¤1,234" / "¤12.50" */
export function moneyText(x: number): string {
  const a = Math.abs(x);
  const body = a >= 1000 ? withCommas(a) : a >= 100 ? a.toFixed(0) : a.toFixed(2);
  return (x < 0 ? '−' : '') + '¤' + body;
}

/** "12%", "2.5%" */
export function pctText(x: number): string {
  const v = x * 100;
  const t = Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
  return (t.endsWith('.0') ? t.slice(0, -2) : t) + '%';
}

function qtyText(x: number): string {
  if (x >= 100) return withCommas(x);
  const t = x.toFixed(x >= 10 ? 1 : 2);
  return t.replace(/\.?0+$/, '');
}

function unitName(g: number, n: number): string {
  const u = GOODS[g]?.unit ?? 'unit';
  if (n === 1) return u;
  if (u === 'loaf') return 'loaves';
  return u.endsWith('s') ? u : u + 's';
}

function goodLower(g: number): string {
  return g >= 0 ? (GOODS[g]?.name ?? 'goods').toLowerCase() : 'goods';
}

/** "20 loaves of bread" */
function amountOf(g: number, q: number): string {
  return `${qtyText(q)} ${unitName(g, q)} of ${goodLower(g)}`;
}

function townName(s: SimState, t: number): string {
  return s.towns[t]?.name ?? 'the realm';
}

function sectorPlural(sec: Sector | 'any' | ''): string {
  if (!sec || sec === 'any') return '';
  const n = SECTORS[sec]?.name ?? sec;
  if (n.endsWith('s')) return n.toLowerCase();
  if (n.endsWith('y')) return n.slice(0, -1).toLowerCase() + 'ies';
  return n.toLowerCase() + 's';
}

const GROUP_TEXT: Record<Group, string> = {
  all: 'everyone',
  persons: 'everyone',
  employed: 'people in work',
  unemployed: 'people without work',
  homeless: 'people without a home',
  owners: 'people who own property',
  nonowners: 'people who own no property',
  hungry: 'hungry people',
  firms: 'firms',
};

/** Plural nouns that follow a count ("each of 611 people"); GROUP_TEXT reads wrong there ("611 everyone"). */
const GROUP_PLURAL: Record<Group, string> = {
  all: 'people',
  persons: 'people',
  employed: 'people in work',
  unemployed: 'people without work',
  homeless: 'people without a home',
  owners: 'property owners',
  nonowners: 'people who own no property',
  hungry: 'hungry people',
  firms: 'firms',
};

const GROUP_EACH: Record<Group, string> = {
  all: 'every person',
  persons: 'every person',
  employed: 'every person in work',
  unemployed: 'every person without work',
  homeless: 'every person without a home',
  owners: 'every property owner',
  nonowners: 'every person who owns no property',
  hungry: 'every hungry person',
  firms: 'every firm',
};

function payerText(l: Levy): string {
  switch (l.payer) {
    case 'buyer':
      return 'buyers';
    case 'seller':
      return 'sellers';
    case 'worker':
      return 'workers';
    case 'employer':
      return 'employers';
    case 'holder':
      return 'holders';
    case 'tenant':
      return 'tenants';
    case 'landlord':
      return 'landlords';
    case 'owner':
      return l.base === 'profit' ? 'firms' : l.base === 'shipment' ? 'shippers' : 'owners';
    case 'receiver':
      return l.base === 'interest' ? 'savers' : l.base === 'estate' ? 'heirs' : 'recipients';
    default:
      return 'payers';
  }
}

function kindText(l: Levy): string {
  if (l.sector && l.sector !== 'any') return (SECTORS[l.sector]?.name ?? 'building').toLowerCase();
  if (l.buildingKind === 'house') return 'house';
  if (l.buildingKind === 'firm') return 'workplace';
  if (l.buildingKind && l.buildingKind !== 'any') return l.buildingKind;
  return 'building';
}

/** What the rule applies to, e.g. "of the value of every bread sale". */
function levyObject(s: SimState, l: Levy): string {
  const g = l.good;
  const gt = goodLower(g);
  const u = g >= 0 ? unitName(g, 1) : 'unit';
  const sec = sectorPlural(l.sector);
  const inSec = sec ? ` at ${sec}` : '';
  const pct = l.unit === 'pct';
  switch (l.base) {
    case 'sale':
      return pct ? `of the value of every ${g >= 0 ? gt + ' ' : ''}sale` : `for every ${u} of ${gt} sold`;
    case 'wage':
      return pct ? `of every wage paid${inSec}` : `per worker per day${inSec}`;
    case 'profit':
      return `of monthly profits${inSec}`;
    // money / goods: a trade filter limits the rule to those firms (levies.stockLevies).
    case 'money':
      return pct ? `a year on money held${inSec}` : `a day from every holder of money${inSec}`;
    case 'goods':
      return l.unit === 'perUnit'
        ? `each day per ${u} of ${gt} kept in store${inSec}`
        : pct
          ? `a year of the value of ${gt} kept in store${inSec}`
          : `a day for every kind of goods kept in store${inSec}`;
    case 'rent':
      return pct ? 'of all rent paid' : 'per rented home per day';
    case 'interest':
      return 'of all interest earned on savings and IOUs';
    case 'shipment': {
      const route =
        l.town >= 0 && l.toTown >= 0
          ? ` from ${townName(s, l.town)} to ${townName(s, l.toTown)}`
          : l.town >= 0
            ? ` out of ${townName(s, l.town)}`
            : l.toTown >= 0
              ? ` into ${townName(s, l.toTown)}`
              : ' between towns';
      return pct ? `of the value of ${gt} carried${route}` : `for every ${u} of ${gt} carried${route}`;
    }
    case 'import':
      return pct ? `of the value of ${gt} coming in through the port` : `for every ${u} of ${gt} coming in through the port`;
    case 'export':
      return pct ? `of the value of ${gt} going out through the port` : `for every ${u} of ${gt} going out through the port`;
    case 'building':
      return pct ? `a year of the value of every ${kindText(l)}` : `a day for every ${kindText(l)}`;
    case 'estate':
      return pct ? 'of every estate left by those who die' : 'from every estate left by those who die';
    default:
      return 'of the flow';
  }
}

/** Plain sentence describing a levy rule. */
export function describeLevy(s: SimState, l: Levy): string {
  const take = l.dir === 1;
  const amt = l.unit === 'pct' ? pctText(l.rate) : moneyText(l.rate);
  const f = FILTERS_FOR[l.base];
  const where = f.town && l.town >= 0 && l.base !== 'shipment' ? ` in ${townName(s, l.town)}` : '';
  let body: string;
  if (l.base === 'head') {
    body = take ? `takes ${moneyText(l.rate)} a day from ${GROUP_EACH[l.group] ?? 'every person'}` : `pays ${moneyText(l.rate)} a day to ${GROUP_EACH[l.group] ?? 'every person'}`;
    body += where;
  } else {
    body = `${take ? 'takes' : 'pays'} ${amt} ${levyObject(s, l)}${where}`;
    const who = payerText(l);
    body += take ? `, charged to ${who}` : `, paid to ${who}`;
  }
  if (f.group && l.base !== 'head' && l.group && l.group !== 'all') body += ` (only ${GROUP_TEXT[l.group] ?? l.group})`;
  if (l.threshold > 0) {
    if (l.base === 'goods' && l.unit !== 'pct') body += `, beyond the first ${qtyText(l.threshold)} units`;
    else if (l.unit === 'pct') body += `, on the part above ${moneyText(l.threshold)}`;
    else if (l.base === 'head') body += `, only when they hold more than ${moneyText(l.threshold)}`;
    else body += `, only above ${moneyText(l.threshold)}`;
  }
  if (l.until >= 0) body += `, until ${dateLabel(l.until)}`;
  return `The Treasury now ${body}.`;
}

/** Short label for lists, e.g. "Take 10% · bread sales · Millbrook". */
export function levyShortLabel(s: SimState, l: Levy): string {
  const verb = l.dir === 1 ? 'Take' : 'Give';
  const per =
    l.unit === 'flat'
      ? l.base === 'estate'
        ? ' each'
        : '/day'
      : l.base === 'wage'
        ? '/worker-day'
        : l.base === 'rent'
          ? '/home-day'
          : l.base === 'goods'
            ? '/unit/day'
            : '/unit';
  const amt = l.unit === 'pct' ? pctText(l.rate) + (STOCK_BASES[l.base] ? '/yr' : '') : moneyText(l.rate) + per;
  const g = l.good >= 0 ? goodLower(l.good) : 'all goods';
  const secP = sectorPlural(l.sector);
  const atSec = secP ? ` at ${secP}` : '';
  let what: string;
  switch (l.base) {
    case 'sale':
      what = `${g} sales (${payerText(l)})`;
      break;
    case 'wage':
      what = `wages${atSec} (${payerText(l)})`;
      break;
    case 'profit':
      what = `profits${atSec}`;
      break;
    case 'money':
      what = `money held${atSec}`;
      break;
    case 'goods':
      what = `${g} in store${atSec}`;
      break;
    case 'head':
      what = `per head · ${GROUP_TEXT[l.group] ?? 'everyone'}`;
      break;
    case 'rent':
      what = `rent (${payerText(l)})`;
      break;
    case 'interest':
      what = 'interest earned';
      break;
    case 'shipment':
      what = `${g} carried`;
      break;
    case 'import':
      what = `${g} arriving by sea`;
      break;
    case 'export':
      what = `${g} leaving by sea`;
      break;
    case 'building':
      what = `${kindText(l)}s`;
      break;
    case 'estate':
      what = 'estates';
      break;
    default:
      what = l.base;
  }
  const where = l.town >= 0 && FILTERS_FOR[l.base]?.town ? ` · ${townName(s, l.town)}` : '';
  return `${verb} ${amt} · ${what}${where}`;
}

/** Plain sentence describing a limit. */
export function describeLimit(s: SimState, l: Limit): string {
  const where = l.town >= 0 ? ` in ${townName(s, l.town)}` : '';
  const g = l.good >= 0 ? goodLower(l.good) : 'any good';
  // Quantity limits with no good count each good separately: "No goods may…", "N units of each good…".
  const qNone = l.good >= 0 ? g : 'goods';
  const qSome = l.good >= 0 ? g : 'each good';
  let t: string;
  switch (l.kind) {
    case 'priceMax':
      t = `No one may trade ${g}${where} above ${moneyText(l.value)} (before levies)`;
      break;
    case 'priceMin':
      t = `No one may trade ${g}${where} below ${moneyText(l.value)} (before levies)`;
      break;
    case 'wageMin':
      t = `No one${where || ' in the realm'} may be paid less than ${moneyText(l.value)} a day`;
      break;
    case 'wageMax':
      t = `No one${where || ' in the realm'} may be paid more than ${moneyText(l.value)} a day`;
      break;
    case 'rentMax':
      t = `No home${where} may be let for more than ${moneyText(l.value)} a day`;
      break;
    case 'rentMin':
      t = `No home${where} may be let for less than ${moneyText(l.value)} a day`;
      break;
    case 'rateMax':
      t = `The Bank may not charge more than ${pctText(l.value)} a year on its loans`;
      break;
    case 'importMax':
      t = l.value <= 0 ? `No ${qNone} may come in through the port` : `At most ${qtyText(l.value)} units of ${qSome} may come in through the port each day`;
      break;
    case 'exportMax':
      t = l.value <= 0 ? `No ${qNone} may leave through the port` : `At most ${qtyText(l.value)} units of ${qSome} may leave through the port each day`;
      break;
    case 'shipMax': {
      const route =
        l.town >= 0 && l.toTown >= 0
          ? ` from ${townName(s, l.town)} to ${townName(s, l.toTown)}`
          : l.town >= 0
            ? ` out of ${townName(s, l.town)}`
            : l.toTown >= 0
              ? ` into ${townName(s, l.toTown)}`
              : ' between towns';
      // The quota applies to each (good, origin, destination) separately (limits.quota).
      const each = l.town >= 0 && l.toTown >= 0 ? '' : ' on each route';
      t = l.value <= 0 ? `No ${qNone} may be carried${route}` : `At most ${qtyText(l.value)} units of ${qSome} may be carried${route}${each} each day`;
      break;
    }
    case 'reserveMin':
      t = `The Bank must keep reserves of at least ${pctText(l.value)} of its deposits`;
      break;
    case 'capitalMin':
      t = `The Bank's own capital must stay above ${pctText(l.value)} of its loans`;
      break;
    default:
      t = 'A new rule applies';
  }
  if (l.until >= 0) t += `, until ${dateLabel(l.until)}`;
  return t + '.';
}

function marketText(s: SimState, m: OrderMarket): string {
  if (m.kind === 'good') return `${goodLower(m.good)} in ${townName(s, m.town)}`;
  if (m.kind === 'labor') return `workers in ${townName(s, m.town)}`;
  if (m.kind === 'iou') return 'IOUs';
  return 'gold';
}

/** Plain sentence describing a Treasury order. */
export function describeOrder(s: SimState, o: PlayerOrder): string {
  const m = o.market;
  const span = o.once ? ' today' : o.until >= 0 ? ` until ${dateLabel(o.until)}` : '';
  const cap = o.total >= 0 ? ` (at most ${qtyText(o.total)} in all)` : '';
  if (m.kind === 'labor') {
    const lcap = o.total >= 0 ? ` (at most ${qtyText(o.total)} worker-days in all)` : '';
    return `The Treasury will employ up to ${qtyText(o.qty)} people in ${townName(s, m.town)} at ${moneyText(o.price)} a day${span}${lcap}. They work on the Treasury's building projects there, or wait idle.`;
  }
  if (m.kind === 'good') {
    const what = amountOf(m.good, o.qty);
    return o.side === 'buy'
      ? `The Treasury will buy up to ${what} a day in ${townName(s, m.town)}, paying at most ${moneyText(o.price)} each${span}${cap}.`
      : `The Treasury will sell up to ${what} a day in ${townName(s, m.town)}, for no less than ${moneyText(o.price)} each${span}${cap}.`;
  }
  if (m.kind === 'iou')
    return o.side === 'buy'
      ? `The Treasury will buy back up to ${qtyText(o.qty)} of its IOUs a day, paying at most ${moneyText(o.price)} each${span}${cap}.`
      : `The Treasury will sell up to ${qtyText(o.qty)} new IOUs a day (each pays ${moneyText(5)} a year forever), for no less than ${moneyText(o.price)} each${span}${cap}.`;
  return o.side === 'buy'
    ? `The Treasury will buy up to ${qtyText(o.qty)} oz of gold a day, paying at most ${moneyText(o.price)} an ounce${span}${cap}.`
    : `The Treasury will sell up to ${qtyText(o.qty)} oz of gold a day, for no less than ${moneyText(o.price)} an ounce${span}${cap}.`;
}

function orderShortLabel(s: SimState, side: 'buy' | 'sell', m: OrderMarket, price: number, qty: number): string {
  if (m.kind === 'labor') return `Employ ${qtyText(qty)} · ${townName(s, m.town)} · ${moneyText(price)}/day`;
  return `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyText(qty)}/day · ${marketText(s, m)} · ${side === 'buy' ? '≤' : '≥'} ${moneyText(price)}`;
}

function policyNews(s: SimState, text: string, town = -1): void {
  news(s, text, 'policy', town);
}

function ruleCount(s: SimState): number {
  return s.policy.levies.length + s.policy.limits.length + s.policy.orders.length;
}

// ---------------------------------------------------------------------------
// Validation of levies, limits and orders
// ---------------------------------------------------------------------------
type LevyDraft = Omit<Levy, 'id' | 'created' | 'today' | 'month' | 'lastMonth' | 'total'>;
type Checked<T> = { ok: true; value: T; note: string } | { ok: false; message: string };

function checkLevy(s: SimState, raw: Partial<LevyDraft> | undefined): Checked<LevyDraft> {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'No levy given.' };
  const notes: string[] = [];
  const base = raw.base as LevyBase;
  if (!LEVY_BASES.includes(base)) return { ok: false, message: `Unknown flow "${String(raw.base)}". Choose one of: ${LEVY_BASES.join(', ')}.` };
  const dir = raw.dir === undefined ? 1 : raw.dir;
  if (dir !== 1 && dir !== -1) return { ok: false, message: 'Direction must be 1 (the Treasury takes) or −1 (the Treasury pays).' };
  let unit = (raw.unit ?? UNITS_FOR[base][0]) as LevyUnit;
  if (!LEVY_UNITS.includes(unit)) return { ok: false, message: `Unknown rate unit "${String(raw.unit)}".` };
  if (!UNITS_FOR[base].includes(unit)) {
    if ((base === 'head' || base === 'building') && unit === 'perUnit') unit = 'flat';
    else if (base === 'money' && unit === 'perUnit') unit = 'flat';
    else return { ok: false, message: `A levy on ${base} can be set as: ${UNITS_FOR[base].map(unitWord).join(' or ')}.` };
  }
  if (!isNum(raw.rate)) return { ok: false, message: 'The rate must be a number.' };
  if (raw.rate < 0) return { ok: false, message: 'The rate must be zero or more — to pay instead of take, set the direction to "pay".' };
  const maxRate = unit === 'pct' ? PLAYER_MAX_PCT : PLAYER_MAX_UNIT_RATE;
  if (raw.rate > maxRate) return { ok: false, message: unit === 'pct' ? `A percentage rate can be at most ${pctText(maxRate)}.` : `A rate can be at most ${moneyText(maxRate)}.` };
  let payer = (raw.payer ?? PAYERS_FOR[base][0]) as LevyPayer;
  if (!PAYERS_FOR[base].includes(payer)) {
    if (PAYERS_FOR[base].length === 1) payer = PAYERS_FOR[base][0];
    else return { ok: false, message: `For ${base}, choose who pays: ${PAYERS_FOR[base].join(' or ')}.` };
  }
  const f = FILTERS_FOR[base];
  let good = raw.good ?? -1;
  if (!isInt(good) || good < -1 || good >= N_GOODS) return { ok: false, message: 'Unknown good.' };
  if (!f.good) good = -1;
  let town = raw.town ?? -1;
  if (!isInt(town) || town < -1 || town >= s.towns.length) return { ok: false, message: 'Unknown town.' };
  if (!f.town) town = -1;
  let toTown = raw.toTown ?? -1;
  if (!isInt(toTown) || toTown < -1 || toTown >= s.towns.length) return { ok: false, message: 'Unknown destination town.' };
  if (!f.toTown) toTown = -1;
  if (base === 'shipment' && town >= 0 && town === toTown) return { ok: false, message: 'Origin and destination must differ.' };
  let sector = (raw.sector ?? 'any') as Sector | 'any';
  if (sector !== 'any' && !ALL_SECTOR_KEYS.includes(sector)) return { ok: false, message: `Unknown trade "${String(raw.sector)}".` };
  if (!f.sector) sector = 'any';
  let group = (raw.group ?? 'all') as Group;
  if (!GROUPS.includes(group)) return { ok: false, message: `Unknown group "${String(raw.group)}".` };
  if (!f.group && group !== 'all') {
    notes.push('this flow applies to everyone, so the group was ignored');
    group = 'all';
  }
  if (base === 'head' && group === 'firms') return { ok: false, message: 'A per-head rule applies to people; use a money or building rule for firms.' };
  let buildingKind = (raw.buildingKind ?? 'any') as BuildingKind | 'any';
  if (buildingKind !== 'any' && !BUILDING_KINDS.includes(buildingKind)) return { ok: false, message: `Unknown kind of building "${String(raw.buildingKind)}".` };
  if (!f.kind) buildingKind = 'any';
  if (base === 'building' && sector !== 'any') buildingKind = 'firm';
  const threshold = raw.threshold ?? 0;
  if (!isNum(threshold) || threshold < 0) return { ok: false, message: 'The threshold must be zero or more.' };
  const until = raw.until ?? -1;
  if (!isInt(until) || (until !== -1 && until < s.day)) return { ok: false, message: 'The end day must be today or later (or none).' };
  const enabled = raw.enabled === undefined ? true : !!raw.enabled;
  const draft: LevyDraft = {
    label: '',
    enabled,
    dir,
    base,
    unit,
    rate: raw.rate,
    payer,
    threshold,
    good,
    town,
    toTown,
    sector,
    group,
    buildingKind,
    until,
  };
  const lbl = typeof raw.label === 'string' ? raw.label.trim().slice(0, 80) : '';
  draft.label = lbl || levyShortLabel(s, draft as Levy);
  return { ok: true, value: draft, note: notes.join('; ') };
}

function unitWord(u: LevyUnit): string {
  return u === 'pct' ? 'a percentage' : u === 'perUnit' ? '¤ per unit' : '¤ per day';
}

type LimitDraft = Omit<Limit, 'id' | 'created' | 'binding'>;

function checkLimit(s: SimState, raw: Partial<LimitDraft> | undefined): Checked<LimitDraft> {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'No limit given.' };
  const kind = raw.kind as LimitKind;
  if (!LIMIT_KINDS.includes(kind)) return { ok: false, message: `Unknown kind of limit "${String(raw.kind)}".` };
  const value = raw.value;
  if (!isNum(value) || value < 0) return { ok: false, message: 'The limit value must be a number, zero or more.' };
  let good = raw.good ?? -1;
  let town = raw.town ?? -1;
  let toTown = raw.toTown ?? -1;
  if (!isInt(good) || good < -1 || good >= N_GOODS) return { ok: false, message: 'Unknown good.' };
  if (!isInt(town) || town < -1 || town >= s.towns.length) return { ok: false, message: 'Unknown town.' };
  if (!isInt(toTown) || toTown < -1 || toTown >= s.towns.length) return { ok: false, message: 'Unknown destination town.' };
  let v = value;
  switch (kind) {
    case 'priceMax':
    case 'priceMin':
      if (good < 0) return { ok: false, message: 'Choose which good the price bound applies to.' };
      if (v > PLAYER_MAX_PRICE) return { ok: false, message: `A price can be at most ${moneyText(PLAYER_MAX_PRICE)}.` };
      if (kind === 'priceMax' && v < PRICE_MIN) v = PRICE_MIN;
      toTown = -1;
      break;
    case 'wageMin':
    case 'wageMax':
    case 'rentMax':
    case 'rentMin':
      if (v > PLAYER_MAX_PRICE) return { ok: false, message: `The amount can be at most ${moneyText(PLAYER_MAX_PRICE)}.` };
      good = -1;
      toTown = -1;
      break;
    case 'rateMax':
      if (v > PLAYER_MAX_RATE) return { ok: false, message: `A rate cap can be at most ${pctText(PLAYER_MAX_RATE)} a year.` };
      good = -1;
      town = -1;
      toTown = -1;
      break;
    case 'importMax':
    case 'exportMax':
      if (v > PLAYER_MAX_QTY) return { ok: false, message: 'That quantity is too large.' };
      town = -1;
      toTown = -1;
      break;
    case 'shipMax':
      if (v > PLAYER_MAX_QTY) return { ok: false, message: 'That quantity is too large.' };
      if (town >= 0 && town === toTown) return { ok: false, message: 'Origin and destination must differ.' };
      break;
    case 'reserveMin':
    case 'capitalMin':
      if (v > 1) return { ok: false, message: 'A ratio must be between 0 and 1 (0.10 = 10%).' };
      good = -1;
      town = -1;
      toTown = -1;
      break;
  }
  const until = raw.until ?? -1;
  if (!isInt(until) || (until !== -1 && until < s.day)) return { ok: false, message: 'The end day must be today or later (or none).' };
  const draft: LimitDraft = {
    label: '',
    enabled: raw.enabled === undefined ? true : !!raw.enabled,
    kind,
    good,
    town,
    toTown,
    value: v,
    until,
  };
  const lbl = typeof raw.label === 'string' ? raw.label.trim().slice(0, 80) : '';
  draft.label = lbl || describeLimit(s, draft as Limit).replace(/\.$/, '');
  // Conflict note (the ceiling wins in the auction).
  let note = '';
  if (kind === 'priceMax' || kind === 'priceMin') {
    for (const o of s.policy.limits) {
      if (!o.enabled || o.good !== good || (o.town >= 0 && town >= 0 && o.town !== town)) continue;
      if (kind === 'priceMax' && o.kind === 'priceMin' && o.value > v) note = 'it sits below an existing lower bound, so the upper bound will prevail';
      if (kind === 'priceMin' && o.kind === 'priceMax' && o.value < v) note = 'it sits above an existing upper bound, which will prevail';
    }
  }
  return { ok: true, value: draft, note };
}

function checkMarket(s: SimState, m: OrderMarket | undefined): string | null {
  if (!m || typeof m !== 'object') return 'No market given.';
  switch (m.kind) {
    case 'good':
      if (!validTown(s, m.town)) return 'Unknown town.';
      if (!validGood(m.good)) return 'Unknown good.';
      return null;
    case 'labor':
      if (!validTown(s, m.town)) return 'Unknown town.';
      return null;
    case 'iou':
    case 'gold':
      return null;
    default:
      return 'Unknown market.';
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
/**
 * Validate and apply an action. Must never throw; returns {ok:false, message}
 * for invalid input. Emits a 'policy' news item for notable actions.
 *  mint/burn            → ledger.mint / ledger.burn
 *  placeOrder/update/cancel → s.policy.orders (ids from s.ids.policy)
 *  moveGoods            → traders.shipTreasuryGoods
 *  add/update/removeLevy, add/update/removeLimit → s.policy.*
 *  setWindow            → treasury.reserveRate/lendRate (lendRate ≥ reserveRate enforced)
 *  build                → construction.startProject (owner STATE; road via world/paths route)
 *  cancelProject        → construction.cancelProject
 *  transfer             → executeTransfer
 *  setAutoMint/setEvents
 */
export function dispatch(s: SimState, a: PlayerAction): ActionResult {
  try {
    return dispatchInner(s, a);
  } catch (e) {
    return fail(`That could not be done: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function dispatchInner(s: SimState, a: PlayerAction): ActionResult {
  if (!a || typeof a !== 'object') return fail('No action given.');
  const t = s.treasury;
  switch (a.type) {
    case 'mint': {
      if (!isNum(a.amount) || a.amount <= 0) return fail('The amount to create must be a positive number.');
      if (a.amount > PLAYER_MAX_MONEY) return fail(`At most ${moneyText(PLAYER_MAX_MONEY)} can be created at once.`);
      mint(s, a.amount);
      if (t.givesSuspended && t.purse > 0) t.givesSuspended = false;
      policyNews(s, `The Treasury created ${moneyText(a.amount)} of new money. The Purse now holds ${moneyText(t.purse)}.`);
      return { ok: true, message: `Created ${moneyText(a.amount)}. Purse: ${moneyText(t.purse)}.` };
    }
    case 'burn': {
      if (!isNum(a.amount) || a.amount <= 0) return fail('The amount to destroy must be a positive number.');
      if (!(t.purse > 0)) return fail('The Purse is empty; there is nothing to destroy.');
      const done = burn(s, Math.min(a.amount, PLAYER_MAX_MONEY));
      const partial = done < a.amount - 1e-9 ? ` (all the Purse held)` : '';
      policyNews(s, `The Treasury destroyed ${moneyText(done)} from its Purse${partial}.`);
      return { ok: true, message: `Destroyed ${moneyText(done)}${partial}. Purse: ${moneyText(t.purse)}.` };
    }
    case 'placeOrder':
      return placeOrder(s, a);
    case 'updateOrder': {
      const o = s.policy.orders.find((x) => x.id === a.id);
      if (!o) return fail('No such order.');
      const p = a.patch ?? {};
      const next = { price: o.price, qty: o.qty, enabled: o.enabled, total: o.total, until: o.until };
      if (p.price !== undefined) {
        if (!isNum(p.price) || p.price < 0 || p.price > PLAYER_MAX_PRICE) return fail('The price must be a number between 0 and ' + moneyText(PLAYER_MAX_PRICE) + '.');
        if (o.side === 'buy' && p.price <= 0) return fail('A buying price must be above zero.');
        if (o.side === 'sell' && o.market.kind === 'iou') {
          const e = iouFloorError(s, p.price);
          if (e) return fail(e);
        }
        next.price = p.price;
      }
      if (p.qty !== undefined) {
        if (!isNum(p.qty) || p.qty <= 0) return fail('The quantity must be a positive number.');
        const max = o.market.kind === 'labor' ? PLAYER_MAX_WORKERS : PLAYER_MAX_QTY;
        if (p.qty > max) return fail(`The quantity can be at most ${qtyText(max)}.`);
        next.qty = o.market.kind === 'labor' ? Math.max(1, Math.round(p.qty)) : p.qty;
      }
      if (p.enabled !== undefined) next.enabled = !!p.enabled;
      if (p.total !== undefined) {
        if (!isNum(p.total) || (p.total !== -1 && p.total <= 0)) return fail('The overall cap must be positive (or −1 for none).');
        next.total = p.total;
      }
      if (p.until !== undefined) {
        if (!isInt(p.until) || (p.until !== -1 && p.until < s.day)) return fail('The end day must be today or later (or −1 for none).');
        next.until = p.until;
      }
      Object.assign(o, next);
      if (o.total >= 0 && o.filled >= o.total && o.enabled) o.enabled = false;
      o.label = orderShortLabel(s, o.side, o.market, o.price, o.qty);
      return { ok: true, message: o.enabled ? describeOrder(s, o) : 'Order paused.', id: o.id };
    }
    case 'cancelOrder': {
      const i = s.policy.orders.findIndex((x) => x.id === a.id);
      if (i < 0) return fail('No such order.');
      const [o] = s.policy.orders.splice(i, 1);
      return { ok: true, message: `Order withdrawn (${qtyText(o.filled)} filled in all).`, id: o.id };
    }
    case 'moveGoods': {
      if (!validTown(s, a.from) || !validTown(s, a.to)) return fail('Unknown town.');
      if (a.from === a.to) return fail('Choose two different towns.');
      if (!validGood(a.good)) return fail('Unknown good.');
      if (!isNum(a.qty) || a.qty <= 0) return fail('The quantity must be a positive number.');
      const have = t.goods[a.from]?.[a.good] ?? 0;
      if (have <= 1e-9) return fail(`The Treasury holds no ${goodLower(a.good)} in ${townName(s, a.from)}.`);
      const q = Math.min(a.qty, have);
      const r = shipTreasuryGoods(s, a.from, a.to, a.good, q);
      if (r && r.ok) policyNews(s, `The Treasury sent ${amountOf(a.good, q)} from ${townName(s, a.from)} to ${townName(s, a.to)}.`, a.from);
      return r ?? fail('The goods could not be moved.');
    }
    case 'addLevy': {
      if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
      const c = checkLevy(s, a.levy);
      if (!c.ok) return fail(c.message);
      const levy: Levy = { id: s.ids.policy++, created: s.day, today: 0, month: 0, lastMonth: 0, total: 0, ...c.value };
      s.policy.levies.push(levy);
      const text = describeLevy(s, levy);
      if (levy.enabled) policyNews(s, text, levy.town);
      return { ok: true, message: c.note ? `${text} (Note: ${c.note}.)` : text, id: levy.id };
    }
    case 'updateLevy': {
      const l = s.policy.levies.find((x) => x.id === a.id);
      if (!l) return fail('No such levy.');
      const p = (a.patch ?? {}) as Partial<Levy>;
      const keys = Object.keys(p).filter((k) => !['id', 'created', 'today', 'month', 'lastMonth', 'total'].includes(k));
      if (keys.length === 1 && keys[0] === 'enabled') {
        l.enabled = !!p.enabled;
        policyNews(s, l.enabled ? describeLevy(s, l) : `The Treasury has suspended the rule “${l.label}”.`, l.town);
        return { ok: true, message: l.enabled ? 'Rule resumed.' : 'Rule suspended.', id: l.id };
      }
      const merged: Partial<LevyDraft> = { ...l, ...pick(p, keys) };
      if (p.label === undefined && l.label === levyShortLabel(s, l)) merged.label = ''; // regenerate an auto label
      const c = checkLevy(s, merged);
      if (!c.ok) return fail(c.message);
      const before = describeLevy(s, l);
      Object.assign(l, c.value);
      const after = describeLevy(s, l);
      if (after !== before && l.enabled) policyNews(s, after, l.town);
      return { ok: true, message: c.note ? `${after} (Note: ${c.note}.)` : after, id: l.id };
    }
    case 'removeLevy': {
      const i = s.policy.levies.findIndex((x) => x.id === a.id);
      if (i < 0) return fail('No such levy.');
      const [l] = s.policy.levies.splice(i, 1);
      policyNews(s, `The Treasury has scrapped the rule “${l.label}”.`, l.town);
      return { ok: true, message: `Rule removed. Over its life it ${l.total >= 0 ? 'raised' : 'cost'} ${moneyText(Math.abs(l.total))}.`, id: l.id };
    }
    case 'addLimit': {
      if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
      const c = checkLimit(s, a.limit);
      if (!c.ok) return fail(c.message);
      const lim: Limit = { id: s.ids.policy++, created: s.day, binding: 0, ...c.value };
      s.policy.limits.push(lim);
      const text = describeLimit(s, lim);
      if (lim.enabled) policyNews(s, `New rule: ${lowerFirst(text)}`, lim.town);
      return { ok: true, message: c.note ? `${text} (Note: ${c.note}.)` : text, id: lim.id };
    }
    case 'updateLimit': {
      const l = s.policy.limits.find((x) => x.id === a.id);
      if (!l) return fail('No such limit.');
      const p = (a.patch ?? {}) as Partial<Limit>;
      const keys = Object.keys(p).filter((k) => !['id', 'created', 'binding'].includes(k));
      const merged: Partial<LimitDraft> = { ...l, ...pick(p, keys) };
      if (p.label === undefined && l.label === describeLimit(s, l).replace(/\.$/, '')) merged.label = '';
      const c = checkLimit(s, merged);
      if (!c.ok) return fail(c.message);
      const before = describeLimit(s, l);
      Object.assign(l, c.value);
      const after = describeLimit(s, l);
      if (keys.length === 1 && keys[0] === 'enabled') policyNews(s, l.enabled ? `Rule restored: ${lowerFirst(after)}` : `Rule lifted for now: ${lowerFirst(before)}`, l.town);
      else if (after !== before && l.enabled) policyNews(s, `Rule changed: ${lowerFirst(after)}`, l.town);
      return { ok: true, message: c.note ? `${after} (Note: ${c.note}.)` : after, id: l.id };
    }
    case 'removeLimit': {
      const i = s.policy.limits.findIndex((x) => x.id === a.id);
      if (i < 0) return fail('No such limit.');
      const [l] = s.policy.limits.splice(i, 1);
      policyNews(s, `Rule lifted: ${lowerFirst(describeLimit(s, l).replace(/\.$/, ''))} no longer applies.`, l.town);
      return { ok: true, message: 'Limit removed.', id: l.id };
    }
    case 'setWindow': {
      if (!isNum(a.reserveRate) || !isNum(a.lendRate)) return fail('Both rates must be numbers (0.03 = 3% a year).');
      for (const r of [a.reserveRate, a.lendRate])
        if (r < PLAYER_MIN_RATE || r > PLAYER_MAX_RATE) return fail(`Rates must lie between ${pctText(PLAYER_MIN_RATE)} and ${pctText(PLAYER_MAX_RATE)} a year.`);
      let lend = a.lendRate;
      let note = '';
      if (lend < a.reserveRate) {
        lend = a.reserveRate;
        note = ' The lending rate cannot be below the reserve rate, so it was raised to match.';
      }
      const changed = Math.abs(t.reserveRate - a.reserveRate) > 1e-9 || Math.abs(t.lendRate - lend) > 1e-9;
      t.reserveRate = a.reserveRate;
      t.lendRate = lend;
      const text = `The Treasury now pays ${pctText(t.reserveRate)} a year on the Bank's reserves and charges ${pctText(t.lendRate)} a year on what the Bank borrows at its window.`;
      if (changed) policyNews(s, text);
      return { ok: true, message: text + note };
    }
    case 'build':
      return build(s, a);
    case 'cancelProject': {
      const p = s.projects.find((x) => x.id === a.id);
      if (!p) return fail('No such project.');
      if (p.owner !== STATE) return fail('The Treasury can only cancel projects it commissioned.');
      if (p.status === 'done' || p.status === 'cancelled') return fail('That project is already finished.');
      const ok = cancelProject(s, a.id);
      if (!ok) return fail('The project could not be cancelled.');
      policyNews(s, `The Treasury called off “${p.label}”. ${moneyText(p.billed)} had been spent on it.`, p.town);
      return { ok: true, message: `Project cancelled (${moneyText(p.billed)} already spent).`, id: p.id };
    }
    case 'transfer':
      return transfer(s, a);
    case 'setAutoMint': {
      t.autoMint = !!a.value;
      if (t.autoMint) t.givesSuspended = false;
      policyNews(
        s,
        t.autoMint
          ? 'The Treasury will now create whatever money it needs to meet its payments.'
          : 'The Treasury will now pay only from what the Purse holds.',
      );
      return { ok: true, message: t.autoMint ? 'Auto-mint on: the Purse can never run dry.' : 'Auto-mint off: payments stop when the Purse is empty.' };
    }
    case 'setEvents': {
      s.settings.events = !!a.value;
      return { ok: true, message: s.settings.events ? 'Chance events (droughts, shocks, accidents) are on.' : 'Chance events are off.' };
    }
    default:
      return fail(`Unknown action "${String((a as { type?: unknown }).type)}".`);
  }
}

function pick<T extends object>(o: T, keys: string[]): Partial<T> {
  const r: Partial<T> = {};
  for (const k of keys) (r as Record<string, unknown>)[k] = (o as Record<string, unknown>)[k];
  return r;
}

function lowerFirst(t: string): string {
  return t.length ? t[0].toLowerCase() + t.slice(1) : t;
}

// Sell-floor guards (local to the order checks). A sell order clears at whatever the bids
// reach down to its floor, so a ¤0 floor with a large quantity sells at PRICE_MIN.

/** Today's reference price of a Treasury order's market (0 if none known). */
function orderRefPrice(s: SimState, m: OrderMarket): number {
  const mk = m.kind === 'good' ? s.markets[m.town * N_GOODS + m.good] : m.kind === 'iou' ? s.iouMarket : m.kind === 'gold' ? s.goldMarket : undefined;
  const p = mk ? (mk.ema > 0 ? mk.ema : mk.price) : 0;
  if (p > 0 && Number.isFinite(p)) return p;
  return m.kind === 'iou' ? IOU_PAR : 0;
}

/** Refusal text if a new-IOU floor is too low to be a sale, else null. */
function iouFloorError(s: SimState, price: number): string | null {
  const ref = orderRefPrice(s, { kind: 'iou' });
  const min = IOU_SELL_FLOOR_MIN_SHARE * ref;
  if (price >= min - 1e-9) return null;
  return `New IOUs need a lowest price of at least ${moneyText(min)} (a tenth of today's IOU price of about ${moneyText(ref)}). Each pays ${moneyText(IOU_COUPON)} a year forever, so selling below that would give them away for next to nothing.`;
}

function placeOrder(s: SimState, a: Extract<PlayerAction, { type: 'placeOrder' }>): ActionResult {
  if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
  const err = checkMarket(s, a.market);
  if (err) return fail(err);
  if (a.side !== 'buy' && a.side !== 'sell') return fail('Choose buy or sell.');
  const m = a.market;
  if (m.kind === 'labor' && a.side !== 'buy') return fail('In the labour market the Treasury can only employ people.');
  if (!isNum(a.price) || a.price < 0 || a.price > PLAYER_MAX_PRICE) return fail(`The price must be a number between 0 and ${moneyText(PLAYER_MAX_PRICE)}.`);
  if ((a.side === 'buy' || m.kind === 'labor') && a.price <= 0) return fail(m.kind === 'labor' ? 'The daily wage must be above zero.' : 'A buying price must be above zero.');
  if (!isNum(a.qty) || a.qty <= 0) return fail('The quantity must be a positive number.');
  if (m.kind === 'iou' && a.side === 'sell') {
    const e = iouFloorError(s, a.price);
    if (e) return fail(e);
  }
  const maxQ = m.kind === 'labor' ? PLAYER_MAX_WORKERS : PLAYER_MAX_QTY;
  if (a.qty > maxQ) return fail(`The quantity can be at most ${qtyText(maxQ)} a day.`);
  const qty = m.kind === 'labor' ? Math.max(1, Math.round(a.qty)) : a.qty;
  let total = -1;
  if (a.total !== undefined && a.total !== -1) {
    if (!isNum(a.total) || a.total <= 0) return fail('The overall cap must be a positive number (or none).');
    total = a.total;
  }
  let until = -1;
  if (a.days !== undefined && a.days !== 0) {
    if (!isNum(a.days) || a.days < 0) return fail('The number of days must be positive (or 0 for no end).');
    until = s.day + Math.max(1, Math.round(a.days)) - 1;
  }
  const once = !!a.once;
  if (once) until = s.day;
  const lbl = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : orderShortLabel(s, a.side, m, a.price, qty);
  const market: OrderMarket =
    m.kind === 'good' ? { kind: 'good', town: m.town, good: m.good } : m.kind === 'labor' ? { kind: 'labor', town: m.town } : { kind: m.kind };
  const o: PlayerOrder = {
    id: s.ids.policy++,
    label: lbl,
    enabled: true,
    market,
    side: a.side,
    price: a.price,
    qty,
    total,
    until,
    once,
    filled: 0,
    value: 0,
    filledToday: 0,
    created: s.day,
  };
  s.policy.orders.push(o);
  let note = '';
  if (m.kind === 'good' && a.side === 'sell' && (s.treasury.goods[m.town]?.[m.good] ?? 0) <= 1e-9)
    note = ` The Treasury holds no ${goodLower(m.good)} in ${townName(s, m.town)} yet, so nothing will be offered until it does.`;
  if (m.kind === 'gold' && a.side === 'sell' && s.treasury.gold <= 1e-9) note = ' The Treasury holds no gold yet.';
  if (m.kind === 'iou' && a.side === 'buy' && s.treasury.iouOutstanding <= 1e-9) note = ' No IOUs are in public hands yet, so there is nothing to buy back.';
  if (a.side === 'buy' && !s.treasury.autoMint && !(s.treasury.purse > 0))
    note = m.kind === 'labor' ? ' The Purse is empty, so these workers cannot be paid until money comes in.' : ' The Purse is empty, so nothing will be bought until money comes in.';
  if (m.kind === 'labor' && !findStateworks(s, m.town)) note = ' (There is no Treasury workforce in that town.)';
  if (a.side === 'sell' && m.kind !== 'labor') {
    const ref = orderRefPrice(s, m);
    if (ref > 0 && a.price < SELL_FLOOR_WARN_SHARE * ref)
      note += ` Note: the lowest price is far below today's price of about ${moneyText(ref)}; when buyers are few, a large offer will sell for next to nothing.`;
  }
  const text = describeOrder(s, o);
  policyNews(s, text, m.kind === 'good' || m.kind === 'labor' ? m.town : -1);
  return { ok: true, message: text + note, id: o.id };
}

function build(s: SimState, a: Extract<PlayerAction, { type: 'build' }>): ActionResult {
  switch (a.kind) {
    case 'road': {
      if (!validTown(s, a.from) || !validTown(s, a.to)) return fail('Unknown town.');
      if (a.from === a.to) return fail('Choose two different towns.');
      const plan = roadPlan(s, a.from, a.to);
      if (!plan || plan.length === 0) return fail(`The road between ${townName(s, a.from)} and ${townName(s, a.to)} is already paved (or there is no route).`);
      // Skip tiles an unfinished road project already covers, or the same road is built (and billed) twice.
      const busy = new Set<number>();
      for (const p of s.projects) if (p && p.kind === 'road' && p.status !== 'done' && p.status !== 'cancelled') for (const i of p.tiles) busy.add(i);
      const tiles = plan.filter((i) => !busy.has(i));
      if (tiles.length === 0) return fail(`Already being paved: the builders are at work on the road between ${townName(s, a.from)} and ${townName(s, a.to)}.`);
      const label = `Paved road ${townName(s, a.from)}–${townName(s, a.to)}`;
      const r = startProject(s, { kind: 'road', town: a.from, owner: STATE, tiles: tiles.slice(), label });
      return projectResult(s, r, label, a.from, `${tiles.length} tiles of paving`);
    }
    case 'house':
    case 'pier': {
      if (!validTown(s, a.town)) return fail('Unknown town.');
      if (a.kind === 'pier' && !s.towns[a.town].hasPort) return fail(`${townName(s, a.town)} has no port; piers can only be built at the harbour.`);
      const xy = checkXY(s, a.x, a.y);
      if (typeof xy === 'string') return fail(xy);
      const label = a.kind === 'house' ? `Treasury houses in ${townName(s, a.town)}` : `New pier at ${townName(s, a.town)}`;
      const r = startProject(s, { kind: a.kind, town: a.town, owner: STATE, x: xy?.x, y: xy?.y, label });
      return projectResult(s, r, label, a.town, a.kind === 'house' ? 'homes the Treasury will let' : 'more room for foreign ships');
    }
    case 'firm': {
      if (!validTown(s, a.town)) return fail('Unknown town.');
      if (!ALL_SECTOR_KEYS.includes(a.sector) || a.sector === 'stateworks') return fail('Unknown kind of workplace.');
      const xy = checkXY(s, a.x, a.y);
      if (typeof xy === 'string') return fail(xy);
      const label = `Treasury ${SECTORS[a.sector].name} in ${townName(s, a.town)}`;
      const r = startProject(s, { kind: 'firm', town: a.town, owner: STATE, sector: a.sector, x: xy?.x, y: xy?.y, label });
      return projectResult(s, r, label, a.town, 'its profits will flow to the Purse');
    }
    case 'expand': {
      const f = isInt(a.firm) ? s.firms[a.firm] : undefined;
      if (!f || !f.alive) return fail('No such workplace.');
      if (f.owner !== STATE) return fail('The Treasury can only enlarge workplaces it owns.');
      if (f.building < 0 || !s.buildings[f.building]) return fail('That workforce has no building to enlarge.');
      const label = `Enlarge ${f.name}`;
      const r = startProject(s, { kind: 'expand', town: f.town, owner: STATE, sector: f.sector, building: f.building, label });
      return projectResult(s, r, label, f.town, 'room for more workers');
    }
    default:
      return fail('Unknown kind of construction.');
  }
}

function checkXY(s: SimState, x: unknown, y: unknown): { x: number; y: number } | undefined | string {
  if (x === undefined && y === undefined) return undefined;
  if (!isInt(x) || !isInt(y)) return 'The site must be a whole tile position.';
  if (x < 0 || y < 0 || x >= s.map.w || y >= s.map.h) return 'That site is off the map.';
  return { x, y };
}

function projectResult(s: SimState, r: ReturnType<typeof startProject>, label: string, town: number, what: string): ActionResult {
  if (typeof r === 'string') return fail(r || 'The project could not be started.');
  if (!r) return fail('The project could not be started.');
  let cost = 0;
  try {
    cost = estimateCost(s, r.kind, r.town, r.sector || undefined, r.tiles.length);
  } catch {
    cost = 0;
  }
  const costText = cost > 0 ? ` Estimated cost ${moneyText(cost)}, billed as the work proceeds.` : ' Billed as the work proceeds.';
  policyNews(s, `The Treasury commissioned: ${label} (${what}).`, town);
  let warn = '';
  if (!s.treasury.autoMint && cost > 0 && s.treasury.purse < cost) warn = ' The Purse does not yet hold enough to pay for all of it; work stalls whenever the bills cannot be paid.';
  return { ok: true, message: `${label} queued with the builders.${costText}${warn}`, id: r.id };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
const TRANSFER_GROUPS: TransferGroup[] = [...GROUPS, 'bank'];

function transfer(s: SimState, a: Extract<PlayerAction, { type: 'transfer' }>): ActionResult {
  if (!TRANSFER_GROUPS.includes(a.group)) return fail('Unknown group.');
  if (a.town !== -1 && !validTown(s, a.town)) return fail('Unknown town.');
  if (!isNum(a.amount) || a.amount <= 0) return fail('The amount must be a positive number.');
  if (a.amount > PLAYER_MAX_MONEY) return fail(`At most ${moneyText(PLAYER_MAX_MONEY)} at once.`);
  if (a.dir !== 1 && a.dir !== -1) return fail('Direction must be 1 (pay) or −1 (take).');
  const t = s.treasury;
  if (a.dir === 1 && !t.autoMint && !(t.purse > 0)) return fail('The Purse is empty. Create money first, or turn on auto-mint.');
  if (a.group === 'bank' && a.dir === -1 && !(bankClaimRoom(s) > 0)) return fail('The Bank has no capital of its own to spare, so there is nothing to take.');
  const n = a.group === 'bank' ? 1 : countRecipients(s, a.group, a.town);
  if (n === 0) return fail(`Nobody matches: there are no ${GROUP_PLURAL[a.group as Group] ?? 'recipients'}${a.town >= 0 ? ' in ' + townName(s, a.town) : ''}.`);
  const total = executeTransfer(s, a.group, a.town, a.amount, a.dir);
  const where = a.town >= 0 ? ` in ${townName(s, a.town)}` : '';
  let text: string;
  if (a.group === 'bank') {
    const short = total < a.amount - 1e-6 ? ' — all the capital the Bank could spare' : '';
    text = a.dir === 1 ? `The Treasury paid ${moneyText(total)} into the Bank's own capital.` : `The Treasury took ${moneyText(total)} out of the Bank's own capital${short}.`;
  } else if (a.dir === 1) {
    const each = n > 0 ? total / n : 0;
    const scaled = each < a.amount - 1e-6 ? ' — all the Purse could spare' : '';
    text = `The Treasury handed ${moneyText(each)} to each of ${withCommas(n)} ${GROUP_PLURAL[a.group] ?? 'recipients'}${where} (${moneyText(total)} in all${scaled}).`;
  } else {
    text = `The Treasury collected up to ${moneyText(a.amount)} from each of ${withCommas(n)} ${GROUP_PLURAL[a.group] ?? 'people'}${where} (${moneyText(total)} in all).`;
  }
  policyNews(s, text, a.town);
  return { ok: true, message: text };
}

function transferMembers(s: SimState, group: Group, town: TownId, fn: (ref: number, isFirm: boolean) => void): void {
  if (group === 'firms') {
    for (const f of s.firms) {
      if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks' || f.owner === STATE) continue;
      if (town >= 0 && f.town !== town) continue;
      fn(FIRM_BASE + f.id, true);
    }
    return;
  }
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    if (town >= 0 && p.town !== town) continue;
    if (!inGroup(s, p, group)) continue;
    fn(p.id, false);
  }
}

function countRecipients(s: SimState, group: TransferGroup, town: TownId): number {
  if (group === 'bank') return 1;
  let n = 0;
  transferMembers(s, group, town, () => n++);
  return n;
}

/**
 * One-off transfer: dir 1 = give `amount` to every member of the group (in
 * `town`, or all towns if -1); dir −1 = take up to `amount` from each.
 * 'bank' group → pay to/from BANK (a recapitalisation / levy on the bank).
 * 'all' and 'persons' mean every person; 'firms' every active private firm.
 * If the Purse cannot cover a payment to everyone (auto-mint off), each member
 * gets an equal share of what it holds. Payments to people count as income
 * (person.earned). Returns total ¤ moved.
 */
export function executeTransfer(s: SimState, group: TransferGroup, town: TownId, amount: number, dir: 1 | -1): number {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  if (group === 'bank') {
    // Stats count Bank transfers from the 'recap'/'transfer' flows (stats.ts), not here.
    if (dir === 1) return pay(s, STATE, BANK, amount, 'recap');
    // A seizure takes at most the Bank's own capital (and reserves): the ledger lets the Bank
    // pay any sum, which would sink its capital below zero and bail in every depositor.
    const take = Math.min(amount, bankClaimRoom(s));
    return take > 0 ? pay(s, BANK, STATE, take, 'transfer') : 0;
  }
  let each = amount;
  if (dir === 1 && !s.treasury.autoMint) {
    const n = countRecipients(s, group, town);
    if (n === 0) return 0;
    const avail = Math.max(0, s.treasury.purse);
    if (avail < each * n) each = avail / n;
    if (!(each > 0)) return 0;
  }
  let total = 0;
  transferMembers(s, group as Group, town, (ref, isFirm) => {
    const moved = dir === 1 ? pay(s, STATE, ref, each, 'transfer') : pay(s, ref, STATE, each, 'transfer');
    if (!moved) return;
    total += moved;
    if (!isFirm) {
      const p = s.people[ref];
      if (p) p.earned += dir === 1 ? moved : -moved;
    }
  });
  const acc = s.stats.acc;
  if (dir === 1) acc.transfer_give = (acc.transfer_give || 0) + total;
  else acc.transfer_take = (acc.transfer_take || 0) + total;
  return total;
}

// ---------------------------------------------------------------------------
// Daily hooks
// ---------------------------------------------------------------------------
function findStateworks(s: SimState, town: TownId): Firm | null {
  for (const f of s.firms) if (f && f.alive && f.sector === 'stateworks' && f.town === town) return f;
  return null;
}

function orderExhausted(o: PlayerOrder): boolean {
  return o.total >= 0 && o.filled >= o.total - 1e-9;
}

/**
 * Morning: drop expired levies/limits/orders; reset order.filledToday;
 * set treasury.givesSuspended = !autoMint && purse <= 0;
 * apply labour orders: for each town, the stateworks firm's target = Σ qty of
 * enabled 'labor' buy orders there and its wage = the highest such price
 * (target 0 → it releases its workers gradually via labor.ts).
 */
export function policyBeginDay(s: SimState): void {
  const P = s.policy;
  const day = s.day;
  if (P.levies.length) {
    const keep: Levy[] = [];
    for (const l of P.levies) {
      if (l.until >= 0 && l.until < day) policyNews(s, `The rule “${l.label}” has lapsed.`, l.town);
      else keep.push(l);
    }
    if (keep.length !== P.levies.length) P.levies = keep;
    for (const l of P.levies) l.today = 0;
  }
  if (P.limits.length) {
    const keep: Limit[] = [];
    for (const l of P.limits) {
      if (l.until >= 0 && l.until < day) policyNews(s, `A rule has lapsed: ${lowerFirst(describeLimit(s, { ...l, until: -1 }).replace(/\.$/, ''))} no longer applies.`, l.town);
      else keep.push(l);
    }
    if (keep.length !== P.limits.length) P.limits = keep;
  }
  if (P.orders.length) {
    const keep: PlayerOrder[] = [];
    for (const o of P.orders) if (!(o.until >= 0 && o.until < day)) keep.push(o);
    if (keep.length !== P.orders.length) P.orders = keep;
    for (const o of P.orders) o.filledToday = 0;
  }

  const t = s.treasury;
  const was = t.givesSuspended;
  t.givesSuspended = !t.autoMint && !(t.purse > 1e-9);
  if (t.givesSuspended && !was) policyNews(s, 'The Purse is empty: every payment the Treasury has promised is on hold until money comes in.');
  else if (!t.givesSuspended && was) policyNews(s, "The Purse holds money again; the Treasury's promised payments resume.");

  // Treasury workforce per town. With auto-mint off the crews are capped at what the Purse
  // can pay today (none while payments are on hold): otherwise the Treasury keeps hiring
  // people it cannot pay, who then count as employed while earning nothing.
  let budget = t.autoMint ? Infinity : t.givesSuspended ? 0 : Math.max(0, t.purse);
  for (const f of s.firms) {
    if (!f || !f.alive || f.sector !== 'stateworks') continue;
    let target = 0;
    let wage = 0;
    for (const o of P.orders) {
      if (!o.enabled || o.market.kind !== 'labor' || o.market.town !== f.town || o.side !== 'buy') continue;
      if (orderExhausted(o)) continue;
      // Never more workers than the order's remaining worker-days.
      target += o.total >= 0 ? Math.min(o.qty, Math.max(0, Math.ceil(o.total - o.filled - 1e-9))) : o.qty;
      if (o.price > wage) wage = o.price;
    }
    target = Math.max(0, Math.round(target));
    if (target > 0 && wage > 0) f.wage = wage;
    if (target > 0 && budget < Infinity) {
      const w = f.wage > 0 ? f.wage : wage;
      const afford = w > 0 ? Math.floor(budget / w + 1e-9) : 0;
      if (afford < target) target = afford;
      budget -= target * w;
    }
    f.target = target;
  }
}

interface Submitted {
  po: PlayerOrder;
  ord: Order;
}

/**
 * Submit enabled Treasury orders for goods / IOU / gold markets (exempt from
 * levies, tag = order id). Buy qty is capped by what the Purse can afford at the
 * limit (unless autoMint); sell qty by holdings (IOU sells are issuance: no cap
 * except the order's own). Respect order.total. Buy orders for IOUs are also
 * capped by the IOUs in public hands.
 */
export function playerOrders(s: SimState, books: Books): void {
  const bag = rt(s).bag;
  let sub = bag.playerSubmitted as Submitted[] | undefined;
  if (!sub) bag.playerSubmitted = sub = [];
  sub.length = 0;
  const orders = s.policy.orders;
  if (orders.length === 0) return;
  const t = s.treasury;
  let budget = t.autoMint ? 1e15 : Math.max(0, t.purse);
  const committed: Record<number, number> = {};
  let iouBuyCommitted = 0;
  let goldCommitted = 0;
  for (const po of orders) {
    if (!po.enabled || po.market.kind === 'labor') continue;
    if (po.until >= 0 && po.until < s.day) continue;
    let q = po.qty;
    if (po.total >= 0) q = Math.min(q, po.total - po.filled);
    if (!(q > 1e-9) || !(po.price >= 0)) continue;
    const m = po.market;
    const buy = po.side === 'buy';
    if (buy) {
      if (!(po.price > 0)) continue;
      q = Math.min(q, budget / po.price);
    }
    let book;
    if (m.kind === 'good') {
      if (!validTown(s, m.town) || !validGood(m.good)) continue;
      book = books.goods[m.town * N_GOODS + m.good];
      if (!book) continue;
      if (!buy) {
        const k = m.town * N_GOODS + m.good;
        const have = (t.goods[m.town]?.[m.good] ?? 0) - (committed[k] || 0);
        q = Math.min(q, Math.max(0, have));
        if (q > 1e-9) committed[k] = (committed[k] || 0) + q;
      }
    } else if (m.kind === 'iou') {
      book = books.iou;
      if (buy) {
        q = Math.min(q, Math.max(0, t.iouOutstanding - iouBuyCommitted));
        iouBuyCommitted += Math.max(0, q);
      }
    } else if (m.kind === 'gold') {
      book = books.gold;
      if (!buy) {
        q = Math.min(q, Math.max(0, t.gold - goldCommitted));
        goldCommitted += Math.max(0, q);
      }
    } else continue;
    if (!book || !(q > 1e-9)) continue;
    if (buy) budget -= q * po.price;
    const ord = buy ? addBid(book, STATE, po.price, q, { exempt: true, tag: po.id }) : addAsk(book, STATE, po.price, q, { exempt: true, tag: po.id });
    sub.push({ po, ord });
  }
}

/** After clearing: update order.filled/filledToday/value; disable once-orders and exhausted totals. */
export function playerAfterClear(s: SimState, books: Books): void {
  const sub = rt(s).bag.playerSubmitted as Submitted[] | undefined;
  if (sub) {
    for (const { po, ord } of sub) {
      const f = ord.filled > 0 ? ord.filled : 0;
      po.filledToday += f;
      po.filled += f;
      if (f > 0) po.value += po.side === 'buy' ? ord.paid : -ord.paid;
    }
    sub.length = 0;
  }
  // Treasury workforce: attribute today's workers to the labour orders of each town (in order).
  const orders = s.policy.orders;
  if (orders.some((o) => o.market.kind === 'labor')) {
    for (const f of s.firms) {
      if (!f || !f.alive || f.sector !== 'stateworks') continue;
      let left = f.workers.length;
      for (const o of orders) {
        if (!o.enabled || o.market.kind !== 'labor' || o.market.town !== f.town) continue;
        const room = o.total >= 0 ? Math.max(0, o.total - o.filled) : o.qty;
        const n = Math.min(o.qty, left, room);
        left -= n;
        o.filledToday = n;
        o.filled += n;
        o.value += n * (f.wage > 0 ? f.wage : o.price);
      }
    }
  }
  for (const o of orders) {
    if (!o.enabled) continue;
    if (o.once || orderExhausted(o)) o.enabled = false;
  }
}

