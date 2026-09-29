// ============================================================================
// The player's primitives: validation + execution of PlayerActions, Treasury
// orders in markets, carry rules between the Treasury's stores (their daily running
// lives in policy/carry.ts), Treasury workforce, transfers (money, or goods in kind),
// freight lines (open / change / close; their daily running lives in policy/lines.ts).
// See DESIGN §5.
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
  AIM_MAX_CAP,
  AIM_MAX_DEFAULT,
  MARKET_SESSIONS,
  SESSION_TIMES,
  PLAYER_MAX_PCT,
  PLAYER_MAX_PRICE,
  PLAYER_MAX_QTY,
  PLAYER_MAX_RATE,
  PLAYER_MAX_RULES,
  PLAYER_MAX_UNIT_RATE,
  PLAYER_MAX_WORKERS,
  PLAYER_MIN_RATE,
  WAGON_CAPACITY,
  PRICE_MIN,
  IOU_SELL_FLOOR_MIN_SHARE,
  SELL_FLOOR_WARN_SHARE,
  ORDER_ANY_FLOOR_SHARE,
  ORDER_ANY_BUDGET_MULT,
  ORDER_ANY_MULT,
  ORDER_BAND_MAX,
  ORDER_PATIENT_STEP_MIN,
  ORDER_PATIENT_STEP_SHARE,
  BANK_MIN_CAPITAL,
  BANK_OWN_MIN_CAPITAL,
  LIMIT_MOVE_MAX,
} from '../config';
import { dateLabel } from '../calendar';
import { fin } from '../util';
import { GOODS, N_GOODS, SECTORS } from '../goods';
import { burn, mint, pay } from '../ledger';
import { rt } from '../runtime';
import { BANK, FIRM_BASE, GOLD_GOOD, IOU_GOOD, STATE } from '../types';
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
  OrderPace,
  OrderPriceMode,
  CarryRule,
  PlayerAction,
  PlayerOrder,
  Sector,
  SimState,
  TownId,
  TransferGroup,
} from '../types';
import { addAsk, addBid, type Books } from '../market/markets';
import { aimedRateAt, bankClaimRoom, inGroup, isAimed, isTargetedSale, primeAimedRates, rateIn, steerLevies } from './levies';
import { carriesBeginDay, carryById, carryLabel, describeCarry, runCarries, shortTargets } from './carry';
import { news } from '../stats/events';
import { cancelProject, needCost, startProject, treasuryCrewWanted } from '../agents/construction';
import { deliverTreasuryDue, freightPerUnit, sendTreasuryCargo, traderOf } from '../agents/traders';
import { roadPlan, trackPlan } from '../world/paths';
import { nearestTown, townCentreTile } from '../world/layout';
import { LINE_MAX_FARE, LINE_MAX_WAGONS, TOOLS_PER_WAGON } from '../config';
import { G } from '../goods';
import type { FreightLine, LineFare } from '../types';
import {
  estimateLine,
  fareFor,
  lineBetween,
  lineById,
  lineDriversWanted,
  lineOffer,
  lineOrders,
  lineResult,
  linesAfterClear,
  linesBeginDay,
  newLine,
  returnSpareTools,
  takeStoredTools,
  usableRoute,
  wagonsOut,
  windUpLine,
} from './lines';

// ---------------------------------------------------------------------------
// Vocabulary & validation tables
// ---------------------------------------------------------------------------
const LEVY_BASES: LevyBase[] = ['sale', 'wage', 'profit', 'money', 'goods', 'head', 'rent', 'interest', 'shipment', 'import', 'export', 'building', 'estate'];
const LEVY_UNITS: LevyUnit[] = ['pct', 'perUnit', 'flat'];
const GROUPS: Group[] = ['all', 'employed', 'unemployed', 'homeless', 'owners', 'nonowners', 'hungry', 'persons', 'firms'];
const BUILDING_KINDS: BuildingKind[] = ['house', 'firm', 'market', 'bank', 'palace', 'port'];
const LIMIT_KINDS: LimitKind[] = [
  'priceMax',
  'priceMin',
  'priceMove',
  'wageMin',
  'wageMax',
  'rentMax',
  'rentMin',
  'rateMax',
  'rateMin',
  'importMax',
  'exportMax',
  'shipMax',
  'reserveMin',
  'capitalMin',
];
/** Price limits: they bind in the auction, and may also name the IOU or gold market. */
const PRICE_LIMIT_KINDS: LimitKind[] = ['priceMax', 'priceMin', 'priceMove'];
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

/**
 * Which filters are meaningful for each base (others are normalised to "any").
 * 'sale': a trade or a group makes the rule a targeted one (levies.isTargetedSale): it applies
 * only to the purchases (payer 'buyer') or sales (payer 'seller') of the traders it names.
 */
const FILTERS_FOR: Record<LevyBase, { good: boolean; town: boolean; toTown: boolean; sector: boolean; group: boolean; kind: boolean }> = {
  sale: { good: true, town: true, toTown: false, sector: true, group: true, kind: false },
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

/** Who a targeted sale rule names, as buyers or sellers: "coal mines", "hungry households". */
const SALE_GROUP_TEXT: Record<Group, string> = {
  all: 'everyone',
  persons: 'households',
  employed: 'households in work',
  unemployed: 'households without work',
  homeless: 'people without a home',
  owners: 'property owners',
  nonowners: 'households who own no property',
  hungry: 'hungry households',
  firms: 'firms',
};

function saleTargetText(l: Levy): string {
  const sec = sectorPlural(l.sector);
  if (sec) return sec;
  return SALE_GROUP_TEXT[l.group] ?? 'households';
}

/** Body of the sentence for a targeted sale rule (after "The Treasury now "), without the place. */
function targetedSaleBody(l: Levy, where: string): string {
  const take = l.dir === 1;
  const pct = l.unit === 'pct';
  const amt = pct ? pctText(l.rate) : moneyText(l.rate);
  const g = l.good;
  const gt = g >= 0 ? goodLower(g) : 'goods';
  const u = g >= 0 ? unitName(g, 1) : 'unit';
  const every = g >= 0 ? `every ${u} of ${gt}` : 'every unit of goods';
  const who = saleTargetText(l);
  if (l.payer === 'seller') {
    if (take) return pct ? `takes ${amt} of the price of ${gt} sold by ${who}${where}, out of what they receive` : `takes ${amt} for ${every} sold by ${who}${where}, out of what they receive`;
    return pct ? `pays ${who} an extra ${amt} of the price of the ${gt} they sell${where}` : `pays ${who} an extra ${amt} for ${every} they sell${where}`;
  }
  if (take) return pct ? `takes ${amt} on top of the price of ${gt} bought by ${who}${where}` : `takes ${amt} on top of the price of ${every} bought by ${who}${where}`;
  return pct ? `pays ${amt} of the price of ${gt} bought by ${who}${where}` : `pays ${amt} toward ${every} bought by ${who}${where}`;
}

/**
 * Body of the sentence for an aimed sale rule, e.g. "pays part of the price of bread bought
 * by households — re-set each morning in each town so that they pay about ¤2.50 a loaf, and
 * never more than 50 % of the price".
 */
function aimedSaleBody(s: SimState, l: Levy, where: string): string {
  const gt = goodLower(l.good);
  const u = unitName(l.good, 1);
  const who = isTargetedSale(l) ? saleTargetText(l) : l.payer === 'seller' ? 'sellers' : 'buyers';
  const cap = pctText(l.aimMax ?? 0);
  const each = l.town >= 0 ? 'each morning' : 'each morning in each town';
  const aim = `about ${moneyText(l.aim ?? 0)} a ${u}`;
  const take = l.dir === 1;
  if (l.payer === 'seller') {
    if (take) return `takes part of the price of ${gt} sold${isTargetedSale(l) ? ` by ${who}` : ''}${where}, out of what the sellers receive — re-set ${each} so that they receive ${aim}, and never more than ${cap} of the price`;
    return `pays ${who} an extra part of the price of the ${gt} they sell${where} — re-set ${each} so that they receive ${aim}, and never more than ${cap} of the price`;
  }
  if (take) return `takes a part on top of the price of ${gt} bought by ${who}${where} — re-set ${each} so that they pay ${aim}, and never more than ${cap} of the price`;
  return `pays part of the price of ${gt} bought by ${who}${where} — re-set ${each} so that they pay ${aim}, and never more than ${cap} of the price`;
}

/** Today's rates of an aimed rule, e.g. "Kingsbridge 12 %, Millbrook none, …". */
export function aimedRatesText(s: SimState, l: Levy): string {
  const parts: string[] = [];
  for (let t = 0; t < s.towns.length; t++) {
    if (l.town >= 0 && l.town !== t) continue;
    const r = rateIn(l, t);
    parts.push(`${townName(s, t)} ${r > 0 ? pctText(r) : 'none'}`);
  }
  return parts.join(', ');
}

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
  if (isAimed(l)) {
    body = aimedSaleBody(s, l, where);
  } else if (isTargetedSale(l)) {
    body = targetedSaleBody(l, where);
  } else if (l.base === 'head') {
    body = take ? `takes ${moneyText(l.rate)} a day from ${GROUP_EACH[l.group] ?? 'every person'}` : `pays ${moneyText(l.rate)} a day to ${GROUP_EACH[l.group] ?? 'every person'}`;
    body += where;
  } else {
    body = `${take ? 'takes' : 'pays'} ${amt} ${levyObject(s, l)}${where}`;
    const who = payerText(l);
    body += take ? `, charged to ${who}` : `, paid to ${who}`;
  }
  if (f.group && l.base !== 'head' && l.base !== 'sale' && l.group && l.group !== 'all') body += ` (only ${GROUP_TEXT[l.group] ?? l.group})`;
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
  const amt = isAimed(l) ? `≤${pctText(l.aimMax ?? 0)}` : l.unit === 'pct' ? pctText(l.rate) + (STOCK_BASES[l.base] ? '/yr' : '') : moneyText(l.rate) + per;
  const g = l.good >= 0 ? goodLower(l.good) : 'all goods';
  const secP = sectorPlural(l.sector);
  const atSec = secP ? ` at ${secP}` : '';
  let what: string;
  switch (l.base) {
    case 'sale':
      what = isTargetedSale(l) ? `${l.good >= 0 ? g : 'goods'} ${l.payer === 'seller' ? 'sold' : 'bought'} by ${saleTargetText(l)}` : `${g} sales (${payerText(l)})`;
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
  if (isAimed(l)) return `${verb} ${amt} · ${what}${where} · aim ${moneyText(l.aim ?? 0)}`;
  return `${verb} ${amt} · ${what}${where}`;
}

/** Plain sentence describing a limit. */
export function describeLimit(s: SimState, l: Limit): string {
  const inst = l.good === IOU_GOOD || l.good === GOLD_GOOD;
  const where = l.town >= 0 && !inst ? ` in ${townName(s, l.town)}` : '';
  const g = l.good === IOU_GOOD ? 'IOUs' : l.good === GOLD_GOOD ? 'gold' : l.good >= 0 ? goodLower(l.good) : 'any good';
  // Price of an instrument: per IOU / per ounce; goods prices are before levies.
  const per = l.good === IOU_GOOD ? ' each' : l.good === GOLD_GOOD ? ' an ounce' : ' (before levies)';
  // Quantity limits with no good count each good separately: "No goods may…", "N units of each good…".
  const qNone = l.good >= 0 ? g : 'goods';
  const qSome = l.good >= 0 ? g : 'each good';
  let t: string;
  switch (l.kind) {
    case 'priceMax':
      t = `No one may trade ${g}${where} above ${moneyText(l.value)}${per}`;
      break;
    case 'priceMin':
      t = `No one may trade ${g}${where} below ${moneyText(l.value)}${per}`;
      break;
    case 'priceMove': {
      const what =
        l.good === GOLD_GOOD
          ? 'The gold price'
          : l.good === IOU_GOOD
            ? 'The price of IOUs'
            : `The price of ${l.good >= 0 ? g : 'every good'}${inst ? '' : where || ' in every town'}`;
      t = l.value <= 0 ? `${what} is held where it stands: it may not move from one day to the next` : `${what} may move at most ${pctText(l.value)} a day, up or down`;
      break;
    }
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
    case 'rateMin':
      t = `The Bank may not charge less than ${pctText(l.value)} a year on its loans`;
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
      if (Math.abs(l.value - BANK_MIN_CAPITAL) > 1e-9) t += `, in place of the standing ${pctText(BANK_MIN_CAPITAL)}`;
      if (l.value < BANK_OWN_MIN_CAPITAL) t += ` — though the Bank itself never lets it fall below ${pctText(BANK_OWN_MIN_CAPITAL)}`;
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
  const when = o.session === 0 ? ' at the opening' : o.session === 1 ? ' at midday' : o.session === 2 ? ' at the close' : '';
  if (m.kind === 'labor') {
    const lcap = o.total >= 0 ? ` (at most ${qtyText(o.total)} worker-days in all)` : '';
    if (o.staff === 'projects')
      return `The Treasury will employ as many people in ${townName(s, m.town)} as its building projects there can use — ${qtyText(o.staffToday ?? 0)} today, never more than ${qtyText(o.qty)} — ${priceTerms(s, o, '')}${span}${lcap}, and let them go as the projects finish.`;
    return `The Treasury will employ up to ${qtyText(o.qty)} people in ${townName(s, m.town)} ${priceTerms(s, o, '')}${span}${lcap}. They work on the Treasury's building projects there, or wait idle.`;
  }
  if (m.kind === 'good') {
    const what = amountOf(m.good, o.qty);
    return o.side === 'buy'
      ? `The Treasury will buy up to ${what} a day${when} in ${townName(s, m.town)}, ${priceTerms(s, o, ' each')}${span}${cap}.`
      : `The Treasury will sell up to ${what} a day${when} in ${townName(s, m.town)}, ${priceTerms(s, o, ' each')}${span}${cap}.`;
  }
  if (m.kind === 'iou')
    return o.side === 'buy'
      ? `The Treasury will buy back up to ${qtyText(o.qty)} of its IOUs a day, ${priceTerms(s, o, ' each')}${span}${cap}.`
      : `The Treasury will sell up to ${qtyText(o.qty)} new IOUs a day (each pays ${moneyText(5)} a year forever), ${priceTerms(s, o, ' each')}${span}${cap}.`;
  return o.side === 'buy'
    ? `The Treasury will buy up to ${qtyText(o.qty)} oz of gold a day, ${priceTerms(s, o, ' an ounce')}${span}${cap}.`
    : `The Treasury will sell up to ${qtyText(o.qty)} oz of gold a day, ${priceTerms(s, o, ' an ounce')}${span}${cap}.`;
}

function orderShortLabel(s: SimState, side: 'buy' | 'sell', m: OrderMarket, price: number, qty: number, mode: OrderPriceMode = 'fixed', band = 0, staff?: 'projects', pace?: OrderPace): string {
  if (m.kind === 'labor') {
    const wage = mode === 'follow' ? `going wage${band > 0 ? ' +' + pctText(band) : ''}` : `${moneyText(price)}/day`;
    return staff === 'projects' ? `Staff projects · ${townName(s, m.town)} · ≤${qtyText(qty)} · ${wage}` : `Employ ${qtyText(qty)} · ${townName(s, m.town)} · ${wage}`;
  }
  const lim =
    mode === 'any'
      ? 'any price'
      : mode === 'follow'
        ? `market ${pace === 'patient' ? (side === 'buy' ? '≤ +' : '≥ −') : side === 'buy' ? '+' : '−'}${pctText(band)}`
        : `${side === 'buy' ? '≤' : '≥'} ${moneyText(price)}`;
  return `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyText(qty)}/day · ${marketText(s, m)} · ${lim}`;
}

function policyNews(s: SimState, text: string, town = -1): void {
  news(s, text, 'policy', town);
}

function ruleCount(s: SimState): number {
  return s.policy.levies.length + s.policy.limits.length + s.policy.orders.length + (s.policy.lines?.length ?? 0) + (s.policy.carries?.length ?? 0);
}

// ---------------------------------------------------------------------------
// Validation of levies, limits and orders
// ---------------------------------------------------------------------------
type LevyDraft = Omit<Levy, 'id' | 'created' | 'today' | 'month' | 'lastMonth' | 'total'>;
type LevyRaw = Partial<LevyDraft>;
type Checked<T> = { ok: true; value: T; note: string } | { ok: false; message: string };

function checkLevy(s: SimState, raw: LevyRaw | undefined): Checked<LevyDraft> {
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
  // aimed rate: the rate follows a price (sale rules in %, on one good)
  const aimed = raw.aim !== undefined && raw.aim !== null && !(isNum(raw.aim) && raw.aim <= 0);
  if (aimed) {
    if (!isNum(raw.aim) || raw.aim > PLAYER_MAX_PRICE) return { ok: false, message: `The price to aim at must be a number between ${moneyText(0.01)} and ${moneyText(PLAYER_MAX_PRICE)}.` };
    if (base !== 'sale') return { ok: false, message: 'Only a rule on sales can aim at a price.' };
    if (unit !== 'pct') return { ok: false, message: 'A rule that aims at a price is set as a percentage of the price.' };
    if (!isInt(raw.good) || raw.good < 0 || raw.good >= N_GOODS) return { ok: false, message: 'Choose the good whose price the rule aims at.' };
    const mx = raw.aimMax === undefined ? AIM_MAX_DEFAULT : raw.aimMax;
    if (!isNum(mx) || mx <= 0 || mx > AIM_MAX_CAP) return { ok: false, message: `The most the rule may reach must be above 0 % and at most ${pctText(AIM_MAX_CAP)} of the price.` };
    if (!isNum(raw.rate)) raw = { ...raw, rate: 0 };
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
  if (base === 'sale') {
    // Targeting (levies.isTargetedSale): a trade → that trade's firms; a group → people in it
    // ('persons' every household, 'firms' every firm). People do not sell goods in the markets.
    const people = group !== 'all' && group !== 'firms';
    if (sector === 'stateworks') return { ok: false, message: "The Treasury's own workforce does not trade in the markets; choose another trade." };
    if (payer === 'seller' && people)
      return { ok: false, message: 'Goods are sold by firms and merchants, not by households: on the selling side a rule can single out a trade (or all firms), not a group of people.' };
    if (sector !== 'any' && people) return { ok: false, message: 'A rule on purchases can single out a trade or a group of people, not both.' };
    if (sector !== 'any' && group === 'firms') group = 'all'; // a trade already means its firms
  }
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
  if (aimed) {
    draft.aim = raw.aim as number;
    draft.aimMax = raw.aimMax === undefined ? AIM_MAX_DEFAULT : (raw.aimMax as number);
    draft.aimRates = Array.isArray(raw.aimRates) ? raw.aimRates.slice() : [];
  }
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
  const instrument = PRICE_LIMIT_KINDS.includes(kind) && (good === IOU_GOOD || good === GOLD_GOOD);
  if (!isInt(good) || good < -1 || (good >= N_GOODS && !instrument)) return { ok: false, message: 'Unknown good.' };
  if (!isInt(town) || town < -1 || town >= s.towns.length) return { ok: false, message: 'Unknown town.' };
  if (!isInt(toTown) || toTown < -1 || toTown >= s.towns.length) return { ok: false, message: 'Unknown destination town.' };
  let v = value;
  switch (kind) {
    case 'priceMax':
    case 'priceMin':
      if (good < 0) return { ok: false, message: 'Choose which good the price bound applies to.' };
      if (v > PLAYER_MAX_PRICE) return { ok: false, message: `A price can be at most ${moneyText(PLAYER_MAX_PRICE)}.` };
      if (kind === 'priceMax' && v < PRICE_MIN) v = PRICE_MIN;
      if (instrument) town = -1; // the IOU and gold markets are national
      toTown = -1;
      break;
    case 'priceMove':
      // a share of yesterday's price (any good, or every good; one town or every town)
      if (v > LIMIT_MOVE_MAX) return { ok: false, message: `A daily move can be at most ${pctText(LIMIT_MOVE_MAX)}.` };
      if (instrument) town = -1;
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
    case 'rateMin':
      if (v > PLAYER_MAX_RATE) return { ok: false, message: `A loan-rate bound can be at most ${pctText(PLAYER_MAX_RATE)} a year.` };
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
  if (kind === 'rateMax' || kind === 'rateMin') {
    for (const o of s.policy.limits) {
      if (!o.enabled) continue;
      if (kind === 'rateMax' && o.kind === 'rateMin' && o.value > v) note = 'it sits below an existing lowest loan rate, so the highest will prevail';
      if (kind === 'rateMin' && o.kind === 'rateMax' && o.value < v) note = 'it sits above an existing highest loan rate, which will prevail';
    }
  }
  if (kind === 'capitalMin' && v < BANK_OWN_MIN_CAPITAL) note = `the Bank never lets its own capital fall below ${pctText(BANK_OWN_MIN_CAPITAL)} of its loans, so that is the least it will keep`;
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
 *  openLine/updateLine/closeLine → s.policy.lines (policy/lines.ts; ids from s.ids.policy)
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
      const next = { price: o.price, qty: o.qty, enabled: o.enabled, total: o.total, until: o.until, priceMode: o.priceMode ?? 'fixed', band: fin(o.band) };
      // pace of an order that follows the market (labour follows the going wage without one)
      let pace: OrderPace | undefined = o.pace;
      let offset = (o.offset ?? 0);
      if (p.pace !== undefined && p.pace !== 'patient' && p.pace !== 'eager') return fail('Choose a patient or an eager order.');
      if (p.session !== undefined && p.session !== -1 && !(isInt(p.session) && p.session >= 0 && p.session < MARKET_SESSIONS))
        return fail('Choose the opening, midday or the close — or all day.');
      if (p.session !== undefined && p.session >= 0 && o.market.kind === 'labor') return fail('Treasury workers are hired for the day.');
      if (p.priceMode !== undefined || p.band !== undefined || p.pace !== undefined) {
        const pm = checkPriceMode(p.priceMode ?? next.priceMode, p.band ?? (next.priceMode === 'follow' ? next.band : undefined), o.market);
        if (!pm.ok) return fail(pm.message);
        const newlyFollowing = pm.mode === 'follow' && next.priceMode !== 'follow';
        next.priceMode = pm.mode;
        next.band = pm.band;
        if (pm.mode === 'follow' && o.market.kind !== 'labor') {
          const want = p.pace ?? (newlyFollowing ? 'patient' : pace ?? 'eager');
          if (want === 'patient' && (pace !== 'patient' || newlyFollowing)) offset = 0; // a patient order starts at the going price
          pace = want;
        } else pace = undefined;
        if (pm.mode !== 'fixed') {
          const lim = effectiveOrderLimit(s, { market: o.market, side: o.side, price: 0, priceMode: pm.mode, band: pm.band, pace, offset });
          if (!(lim > 0)) return fail('That market has no going price yet to follow; keep a fixed price.');
          next.price = lim;
        }
      }
      let staff: 'projects' | undefined = o.staff;
      if (p.staff !== undefined) {
        if (p.staff !== 'projects' && p.staff !== 'fixed') return fail('Staffing is either automatic (for the projects) or a set number.');
        if (o.market.kind !== 'labor') return fail('Only an order for workers can staff projects.');
        staff = p.staff === 'projects' ? 'projects' : undefined;
      }
      if (p.price !== undefined && next.priceMode === 'fixed') {
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
      if (pace) {
        o.pace = pace;
        o.offset = pace === 'patient' ? offset : 0;
      } else {
        delete o.pace;
        delete o.offset;
      }
      if (p.session !== undefined) {
        if (p.session >= 0) o.session = p.session;
        else delete o.session;
      }
      if (staff === 'projects') {
        o.staff = 'projects';
        o.staffToday = Math.min(o.qty, treasuryCrewWanted(s, (o.market as { town: TownId }).town));
      } else {
        delete o.staff;
        delete o.staffToday;
      }
      if (o.total >= 0 && o.filled >= o.total && o.enabled) o.enabled = false;
      o.label = orderShortLabel(s, o.side, o.market, o.price, o.qty, o.priceMode, o.band, o.staff, o.pace);
      return { ok: true, message: o.enabled ? describeOrder(s, o) : 'Order paused.', id: o.id };
    }
    case 'cancelOrder': {
      const i = s.policy.orders.findIndex((x) => x.id === a.id);
      if (i < 0) return fail('No such order.');
      const o = s.policy.orders[i];
      s.policy.orders.splice(i, 1);
      return { ok: true, message: `Order withdrawn (${qtyText(o.filled)} filled in all).`, id: o.id };
    }
    case 'carry':
      return carry(s, a);
    case 'updateCarry':
      return updateCarry(s, a);
    case 'removeCarry': {
      const cs = s.policy.carries ?? [];
      const i = cs.findIndex((x) => x.id === a.id);
      if (i < 0) return fail('No such carry rule.');
      const [c] = cs.splice(i, 1);
      return { ok: true, message: `Carry rule removed (${amountOf(c.good, c.carried)} carried in all). Goods already on the road still arrive.`, id: c.id };
    }
    case 'addLevy': {
      if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
      const c = checkLevy(s, a.levy);
      if (!c.ok) return fail(c.message);
      const levy: Levy = { id: s.ids.policy++, created: s.day, today: 0, month: 0, lastMonth: 0, total: 0, ...c.value };
      if (isAimed(levy)) primeAimedRates(s, levy);
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
      if (c.value.aim === undefined) {
        delete l.aim;
        delete l.aimMax;
        delete l.aimRates;
      }
      if (isAimed(l)) primeAimedRates(s, l);
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
    case 'openLine':
      return openLine(s, a);
    case 'updateLine':
      return updateLine(s, a);
    case 'closeLine':
      return closeLine(s, a);
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
/** The going wage in a town: its workshops' average posted wage (else the founding wage). */
export function goingWage(s: SimState, town: TownId): number {
  const t = s.towns[town];
  const w = t ? fin(t.avgWage) : 0;
  return w > 0 ? w : fin(s.stats?.baseWage);
}

function orderRefPrice(s: SimState, m: OrderMarket): number {
  if (m.kind === 'labor') return goingWage(s, m.town);
  const mk = m.kind === 'good' ? s.markets[m.town * N_GOODS + m.good] : m.kind === 'iou' ? s.iouMarket : m.kind === 'gold' ? s.goldMarket : undefined;
  // The market's own going price (without the Treasury's orders), so an order that follows the
  // market does not chase the price its own buying or selling moved.
  const own = mk?.ownEma ?? 0;
  const p = mk ? (own > 0 && Number.isFinite(own) ? own : mk.ema > 0 ? mk.ema : mk.price) : 0;
  if (p > 0 && Number.isFinite(p)) return p;
  return m.kind === 'iou' ? IOU_PAR : 0;
}

/** Lowest floor an 'any price' / following sell order may use (IOU issuance keeps its own guard). */
function sellFloorShare(m: OrderMarket): number {
  return m.kind === 'iou' ? Math.max(ORDER_ANY_FLOOR_SHARE, IOU_SELL_FLOOR_MIN_SHARE) : ORDER_ANY_FLOOR_SHARE;
}

/**
 * Today's limit for an order that follows the market: the going price (the market's
 * smoothed clearing price) plus the band for buys, minus it for sells; 'any' buys bid
 * ORDER_ANY_MULT × the going price, 'any' sells take a token floor. 0 if the market has
 * no price yet. Fixed orders return their own price.
 */
type LimitSpec = Pick<PlayerOrder, 'market' | 'side' | 'price' | 'priceMode' | 'band'> & Partial<Pick<PlayerOrder, 'pace' | 'offset'>>;

/** How far a following order sits from the going price today: the band's edge, or a patient order's own step. */
function followOffset(o: LimitSpec): number {
  const b = Math.min(ORDER_BAND_MAX, Math.max(0, fin(o.band)));
  if (o.pace !== 'patient') return b;
  const x = (o.offset ?? 0);
  return x < -b ? -b : x > b ? b : x;
}

/** A patient order's step for its band. */
function patientStep(band: number): number {
  return Math.max(ORDER_PATIENT_STEP_MIN, Math.max(0, band) * ORDER_PATIENT_STEP_SHARE);
}

export function effectiveOrderLimit(s: SimState, o: LimitSpec): number {
  const mode = o.priceMode ?? 'fixed';
  if (mode === 'fixed' || (o.market.kind === 'labor' && mode !== 'follow')) return o.price;
  const ref = orderRefPrice(s, o.market);
  if (o.market.kind === 'labor') return ref > 0 ? ref * (1 + Math.min(ORDER_BAND_MAX, Math.max(0, fin(o.band)))) : o.price;
  if (!(ref > 0)) return 0;
  const floor = ref * sellFloorShare(o.market);
  if (mode === 'follow') {
    const b = followOffset(o);
    return o.side === 'buy' ? ref * (1 + b) : Math.max(floor, ref * (1 - b));
  }
  return o.side === 'buy' ? ref * ORDER_ANY_MULT : floor;
}

/** The price part of an order's description, in words. */
function priceTerms(s: SimState, o: LimitSpec, unit: string): string {
  const mode = o.priceMode ?? 'fixed';
  if (o.market.kind === 'labor')
    return mode === 'follow'
      ? `at the going wage${o.band > 0 ? ` plus ${pctText(o.band)}` : ''} (${moneyText(effectiveOrderLimit(s, o))} a day today)`
      : `at ${moneyText(o.price)} a day`;
  if (mode === 'any') return o.side === 'buy' ? 'at whatever price the market asks' : 'for whatever the market pays';
  if (mode === 'follow' && o.pace === 'patient') {
    const b = pctText(o.band);
    const today = moneyText(effectiveOrderLimit(s, o));
    return o.side === 'buy'
      ? `bidding as low as it can — it opens near the going price (${today}${unit} today), bids higher at midday and the close only when a session leaves it short, never more than ${b} above the going price, and each day opens a step below what it needed the day before`
      : `asking as much as it can — it opens near the going price (${today}${unit} today), asks less at midday and the close only when a session leaves it unsold, never less than ${b} below the going price, and each day opens a step above what it needed the day before`;
  }
  if (mode === 'follow') {
    const b = pctText(o.band);
    const today = moneyText(effectiveOrderLimit(s, o));
    return o.side === 'buy' ? `paying at most ${b} above the going price (${today}${unit} today), following the market` : `for no less than ${b} below the going price (${today}${unit} today), following the market`;
  }
  return o.side === 'buy' ? `paying at most ${moneyText(o.price)}${unit}` : `for no less than ${moneyText(o.price)}${unit}`;
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
  const pm = checkPriceMode(a.priceMode, a.band, m);
  if (!pm.ok) return fail(pm.message);
  const mode = pm.mode;
  const band = pm.band;
  if (a.pace !== undefined && a.pace !== 'patient' && a.pace !== 'eager') return fail('Choose a patient or an eager order.');
  if (a.session !== undefined && a.session !== -1 && !(isInt(a.session) && a.session >= 0 && a.session < MARKET_SESSIONS))
    return fail('Choose the opening, midday or the close — or all day.');
  if (m.kind === 'labor' && a.session !== undefined && a.session >= 0) return fail('Treasury workers are hired for the day.');
  const pace: OrderPace | undefined = mode === 'follow' && m.kind !== 'labor' ? (a.pace ?? 'patient') : undefined;
  let price = a.price;
  if (mode === 'fixed') {
    if (!isNum(a.price) || a.price < 0 || a.price > PLAYER_MAX_PRICE) return fail(`The price must be a number between 0 and ${moneyText(PLAYER_MAX_PRICE)}.`);
    if ((a.side === 'buy' || m.kind === 'labor') && a.price <= 0) return fail(m.kind === 'labor' ? 'The daily wage must be above zero.' : 'A buying price must be above zero.');
  } else {
    price = effectiveOrderLimit(s, { market: m, side: a.side, price: 0, priceMode: mode, band, pace, offset: 0 });
    if (!(price > 0)) return fail('That market has no going price yet to follow; set a fixed price instead.');
  }
  if (!isNum(a.qty) || a.qty <= 0) return fail('The quantity must be a positive number.');
  if (m.kind === 'iou' && a.side === 'sell' && mode === 'fixed') {
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
  if (a.staff !== undefined && a.staff !== 'projects') return fail('Staffing is either automatic (for the projects) or a set number.');
  if (a.staff === 'projects' && m.kind !== 'labor') return fail('Only an order for workers can staff projects.');
  const staff = a.staff === 'projects' ? 'projects' : undefined;
  const lbl = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : orderShortLabel(s, a.side, m, price, qty, mode, band, staff, pace);
  const market: OrderMarket =
    m.kind === 'good' ? { kind: 'good', town: m.town, good: m.good } : m.kind === 'labor' ? { kind: 'labor', town: m.town } : { kind: m.kind };
  const o: PlayerOrder = {
    id: s.ids.policy++,
    label: lbl,
    enabled: true,
    market,
    side: a.side,
    price,
    qty,
    total,
    until,
    once,
    filled: 0,
    value: 0,
    filledToday: 0,
    created: s.day,
    priceMode: mode,
    band,
  };
  if (pace) {
    o.pace = pace;
    o.offset = 0;
  }
  if (a.session !== undefined && a.session >= 0) o.session = a.session;
  if (staff && m.kind === 'labor') {
    o.staff = staff;
    o.staffToday = Math.min(qty, treasuryCrewWanted(s, m.town));
  }
  s.policy.orders.push(o);
  let note = '';
  if (m.kind === 'good' && a.side === 'sell' && (s.treasury.goods[m.town]?.[m.good] ?? 0) <= 1e-9)
    note = ` The Treasury holds no ${goodLower(m.good)} in ${townName(s, m.town)} yet, so nothing will be offered until it does.`;
  if (m.kind === 'gold' && a.side === 'sell' && s.treasury.gold <= 1e-9) note = ' The Treasury holds no gold yet.';
  if (m.kind === 'iou' && a.side === 'buy' && s.treasury.iouOutstanding <= 1e-9) note = ' No IOUs are in public hands yet, so there is nothing to buy back.';
  if (a.side === 'buy' && !s.treasury.autoMint && !(s.treasury.purse > 0))
    note = m.kind === 'labor' ? ' The Purse is empty, so these workers cannot be paid until money comes in.' : ' The Purse is empty, so nothing will be bought until money comes in.';
  if (m.kind === 'labor' && !findStateworks(s, m.town)) note = ' (There is no Treasury workforce in that town.)';
  if (a.side === 'sell' && m.kind !== 'labor' && mode === 'fixed') {
    const ref = orderRefPrice(s, m);
    if (ref > 0 && a.price < SELL_FLOOR_WARN_SHARE * ref)
      note += ` Note: the lowest price is far below today's price of about ${moneyText(ref)}; when buyers are few, a large offer will sell for next to nothing.`;
  }
  const text = describeOrder(s, o);
  policyNews(s, text, m.kind === 'good' || m.kind === 'labor' ? m.town : -1);
  return { ok: true, message: text + note, id: o.id };
}

/** Validate an order's price mode and band. */
function checkPriceMode(mode: unknown, band: unknown, m: OrderMarket): { ok: true; mode: OrderPriceMode; band: number } | { ok: false; message: string } {
  if (mode === undefined || mode === 'fixed') return { ok: true, mode: 'fixed', band: 0 };
  if (mode !== 'follow' && mode !== 'any') return { ok: false, message: 'Choose a fixed price, a price that follows the market, or any price.' };
  if (m.kind === 'labor' && mode === 'any') return { ok: false, message: 'Treasury workers are hired at a daily wage: a fixed one, or the going wage plus a margin.' };
  if (mode === 'any') return { ok: true, mode, band: 0 };
  const b = band === undefined ? 0.1 : band;
  if (!isNum(b) || b < 0 || b > ORDER_BAND_MAX) return { ok: false, message: `The band around the going price must lie between 0% and ${pctText(ORDER_BAND_MAX)} (0.1 = 10%).` };
  return { ok: true, mode, band: b };
}

/** Validate the towns and good of a carry (between two stores linked by a wagon road). */
function checkCarryPath(s: SimState, from: unknown, to: unknown, good: unknown): string | null {
  if (!validTown(s, from) || !validTown(s, to)) return 'Unknown town.';
  if (from === to) return 'Choose two different towns.';
  if (!validGood(good)) return 'Unknown good.';
  if (!(freightPerUnit(s, from, to) >= 0)) return `No wagon road links ${townName(s, from)} and ${townName(s, to)}.`;
  return null;
}

/**
 * carry: move Treasury goods between its stores. `once` sends now (qty, or −1 for everything held)
 * and keeps no rule; otherwise a standing CarryRule (policy/carry.ts) loads after every session.
 */
function carry(s: SimState, a: Extract<PlayerAction, { type: 'carry' }>): ActionResult {
  // to −1: wherever it runs short (a standing rule; policy/carry.ts shortTargets)
  const short = a.to === -1;
  if (short && a.once) return fail('Carrying once needs a town to carry to.');
  // several stores to pull from, equally (standing rules)
  let sources: number[] | undefined;
  if (a.sources !== undefined && a.sources !== null) {
    if (!Array.isArray(a.sources) || a.sources.some((t) => !validTown(s, t))) return fail('Unknown town among the stores to carry from.');
    const uniq = [...new Set(a.sources)];
    if (uniq.includes(a.to)) return fail('A store cannot carry to itself: take the destination out of the towns to carry from.');
    if (uniq.length >= 2) {
      if (a.once) return fail('Carrying once takes one town to carry from.');
      if (!uniq.includes(a.from)) return fail('The first town to carry from must be among the stores.');
      sources = [a.from, ...uniq.filter((t) => t !== a.from)];
    }
  }
  if (a.need !== undefined && typeof a.need !== 'boolean') return fail('Say whether it carries only what the destination needs.');
  if (a.need && a.once) return fail('Carrying once takes a set amount (or everything held).');
  const err = short || sources ? (!validTown(s, a.from) ? 'Unknown town.' : !validGood(a.good) ? 'Unknown good.' : !short && !validTown(s, a.to) ? 'Unknown town.' : null) : checkCarryPath(s, a.from, a.to, a.good);
  if (err) return fail(err);
  if (sources && !short && !sources.some((f) => freightPerUnit(s, f, a.to) >= 0)) return fail(`No wagon road links any of those towns with ${townName(s, a.to)}.`);
  if (!isNum(a.qty) || (a.qty !== -1 && a.qty <= 0)) return fail('The quantity must be a positive number (or all of it).');
  if (a.qty > PLAYER_MAX_QTY) return fail(`The quantity can be at most ${qtyText(PLAYER_MAX_QTY)}${a.once ? '' : ' a day'}.`);
  if (a.wagons !== undefined && a.wagons !== 'full' && a.wagons !== 'now') return fail('Wagons leave either when full or right away.');
  const have = s.treasury.goods[a.from]?.[a.good] ?? 0;
  if (a.once) {
    if (have <= 1e-9) return fail(`The Treasury holds no ${goodLower(a.good)} in ${townName(s, a.from)}.`);
    const r = sendTreasuryCargo(s, a.from, a.to, a.good, a.qty === -1 ? have : Math.min(a.qty, have));
    if (!r.ok) return { ok: false, message: r.message };
    policyNews(s, `The Treasury sent ${amountOf(a.good, r.qty)} from ${townName(s, a.from)} to ${townName(s, a.to)}.`, a.from);
    return { ok: true, message: r.message, id: r.id };
  }
  if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
  let until = -1;
  if (a.days !== undefined && a.days !== 0) {
    if (!isNum(a.days) || a.days < 0) return fail('The number of days must be positive (or 0 for no end).');
    until = s.day + Math.max(1, Math.round(a.days)) - 1;
  }
  const c: CarryRule = {
    id: s.ids.policy++,
    label: '',
    enabled: true,
    from: a.from,
    to: a.to,
    good: a.good,
    qty: a.qty,
    wagons: a.wagons === 'now' ? 'now' : 'full',
    until,
    created: s.day,
    allow: a.qty >= 0 ? a.qty : 0,
    heldSince: -1,
    carriedToday: 0,
    carried: 0,
    freightToday: 0,
    freight: 0,
  };
  if (sources) c.sources = sources;
  if (a.need && !short) c.need = true;
  c.label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : carryLabel(s, c);
  (s.policy.carries ??= []).push(c);
  let note = '';
  const heldAll = (sources ?? [a.from]).reduce((x, t) => x + Math.max(0, s.treasury.goods[t]?.[a.good] ?? 0), 0);
  if (heldAll <= 1e-9) note = ` The Treasury holds no ${goodLower(a.good)} in ${sources ? 'those towns' : townName(s, a.from)} yet; the rule carries it as it comes in (an order buying it there, or cargo landing).`;
  if (!traderOf(s, a.from) && (short || !lineBetween(s, a.from, a.to))) note += ` There is no trading house in ${townName(s, a.from)} yet to carry it.`;
  if (short) {
    const served = shortTargets(s, c).map((x) => townName(s, x.town));
    note += served.length
      ? ` It serves ${served.join(', ')} — the towns where the Treasury sells ${goodLower(a.good)}; a sell order in another town adds it.`
      : ` The Treasury sells ${goodLower(a.good)} in no other town yet: place a sell order in each town it should serve.`;
  }
  const text = describeCarry(s, c);
  policyNews(s, text, a.from);
  return { ok: true, message: text + note, id: c.id };
}

function updateCarry(s: SimState, a: Extract<PlayerAction, { type: 'updateCarry' }>): ActionResult {
  const c = carryById(s, a.id);
  if (!c) return fail('No such carry rule.');
  const p = a.patch ?? {};
  if (p.qty !== undefined && (!isNum(p.qty) || (p.qty !== -1 && p.qty <= 0) || p.qty > PLAYER_MAX_QTY))
    return fail(`The quantity must be a positive number up to ${qtyText(PLAYER_MAX_QTY)} a day (or all of it).`);
  if (p.wagons !== undefined && p.wagons !== 'full' && p.wagons !== 'now') return fail('Wagons leave either when full or right away.');
  if (p.until !== undefined && (!isInt(p.until) || (p.until !== -1 && p.until < s.day))) return fail('The end day must be today or later (or −1 for none).');
  if (p.need !== undefined && typeof p.need !== 'boolean') return fail('Say whether it carries only what the destination needs.');
  const auto = c.label === carryLabel(s, c);
  if (p.qty !== undefined && p.qty !== c.qty) {
    c.qty = p.qty;
    c.allow = p.qty >= 0 ? p.qty : 0;
  }
  if (p.wagons !== undefined) c.wagons = p.wagons;
  if (p.until !== undefined) c.until = p.until;
  if (p.need !== undefined) {
    if (p.need && c.to >= 0) {
      c.need = true;
      c.qty = -1; // what it needs, from all it holds
    } else delete c.need;
  }
  if (p.qty !== undefined && p.need === undefined) delete c.need; // a set amount again
  if (p.enabled !== undefined) c.enabled = !!p.enabled;
  if (auto) c.label = carryLabel(s, c);
  return { ok: true, message: c.enabled ? describeCarry(s, c) : 'Carry rule paused.', id: c.id };
}

function build(s: SimState, a: Extract<PlayerAction, { type: 'build' }>): ActionResult {
  switch (a.kind) {
    case 'road': {
      if (!validTown(s, a.from) || !validTown(s, a.to)) return fail('Unknown town.');
      if (a.from === a.to) return fail('Choose two different towns.');
      if (a.grade !== undefined && a.grade !== 1 && a.grade !== 2) return fail('A road is either a dirt track or paved.');
      const dirt = a.grade === 1;
      const plan = dirt ? trackPlan(s, townCentreTile(s, a.from), townCentreTile(s, a.to), 1).tiles : roadPlan(s, a.from, a.to);
      if (!plan || plan.length === 0)
        return fail(dirt ? `A road already runs between ${townName(s, a.from)} and ${townName(s, a.to)} (or there is no way through).` : `The road between ${townName(s, a.from)} and ${townName(s, a.to)} is already paved (or there is no route).`);
      const tiles = notBusy(s, plan, dirt ? 1 : 2);
      if (tiles.length === 0) return fail(`Already under way: the builders are at work on the road between ${townName(s, a.from)} and ${townName(s, a.to)}.`);
      const label = `${dirt ? 'Track' : 'Paved road'} ${townName(s, a.from)}–${townName(s, a.to)}`;
      const r = startProject(s, { kind: 'road', town: a.from, owner: STATE, tiles: tiles.slice(), grade: dirt ? 1 : 2, label });
      return projectResult(s, r, label, a.from, `${tiles.length} tiles of ${dirt ? 'new track' : 'paving'}`);
    }
    case 'track': {
      const n = s.map.w * s.map.h;
      if (!isInt(a.a) || !isInt(a.b) || a.a < 0 || a.b < 0 || a.a >= n || a.b >= n) return fail('Choose two places on the map.');
      if (a.a === a.b) return fail('Choose two different places.');
      if (a.grade !== undefined && a.grade !== 1 && a.grade !== 2) return fail('A road is either a dirt track or paved.');
      const grade = a.grade === 1 ? 1 : 2;
      const plan = trackPlan(s, a.a, a.b, grade);
      if (!plan.path.length) return fail('No road can be laid between those places: open water or the mountains are in the way.');
      if (!plan.tiles.length) return fail(grade === 1 ? 'A road already runs all the way between those places.' : 'The road between those places is already paved all the way.');
      const tiles = notBusy(s, plan.tiles, grade);
      if (!tiles.length) return fail('Already under way: the builders are at work on that road.');
      const w = s.map.w;
      const town = nearestTown(s, a.a % w, Math.floor(a.a / w));
      if (!validTown(s, town)) return fail('Unknown town.');
      const label = `${grade === 1 ? 'Track' : 'Paved road'} ${placeName(s, a.a)}–${placeName(s, a.b)}`;
      const r = startProject(s, { kind: 'road', town, owner: STATE, tiles: tiles.slice(), grade, label });
      return projectResult(s, r, label, town, `${tiles.length} tiles of ${grade === 1 ? 'new track' : 'paving'}; the builders of ${townName(s, town)}`);
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

/** Of `tiles`, those an unfinished road project does not already bring to `grade` (or the same road is built, and billed, twice). */
function notBusy(s: SimState, tiles: readonly number[], grade: 1 | 2): number[] {
  const busy = new Set<number>();
  for (const p of s.projects) if (p && p.kind === 'road' && p.status !== 'done' && p.status !== 'cancelled' && (p.grade === 1 ? 1 : 2) >= grade) for (const i of p.tiles) busy.add(i);
  return tiles.filter((i) => !busy.has(i));
}

/** A place on the map in words: a town (within its houses), or the side of the nearest town it lies on. */
export function placeName(s: SimState, tile: number): string {
  const w = s.map.w;
  const x = tile % w;
  const y = Math.floor(tile / w);
  const t = s.towns[nearestTown(s, x, y)];
  if (!t) return 'the wilds';
  const dx = x - t.x;
  const dy = y - t.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.max(3, t.radius) + 1) return t.name;
  const ang = (Math.atan2(-dy, dx) * 180) / Math.PI; // map y grows southward
  const dirs = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  const dir = dirs[((Math.round(ang / 45) % 8) + 8) % 8];
  return `${Math.round(d)} tiles ${dir} of ${t.name}`;
}

function projectResult(s: SimState, r: ReturnType<typeof startProject>, label: string, town: number, what: string): ActionResult {
  if (typeof r === 'string') return fail(r || 'The project could not be started.');
  if (!r) return fail('The project could not be started.');
  let cost = 0;
  try {
    cost = needCost(s, r.town, r.need);
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
// Freight lines (policy/lines.ts)
// ---------------------------------------------------------------------------
const LINE_FARES: LineFare[] = ['fixed', 'cost', 'free'];
const TOOLS_GOOD = G.tools;
const OIL_GOOD = G.oil;

/** How a line charges, in words: "¤0.40 a unit carried", "what the line costs to run per unit carried (about ¤0.62 today)", "nothing". */
function fareText(L: Pick<FreightLine, 'fare' | 'farePrice' | 'fareToday'>): string {
  if (L.fare === 'free') return 'nothing';
  if (L.fare === 'fixed') return `${moneyText(L.farePrice)} a unit carried`;
  return `what the line costs to run per unit carried (about ${moneyText(L.fareToday)} today)`;
}

/** Plain sentence describing a freight line. */
export function describeLine(s: SimState, L: FreightLine): string {
  const A = townName(s, L.a);
  const B = townName(s, L.b);
  const n = L.wagonsWanted;
  const paused = L.enabled ? '' : ' It is paused: it takes no loads until it is resumed.';
  return (
    `The Treasury runs a freight line between ${A} and ${B}: ${qtyText(n)} wagon${n === 1 ? '' : 's'} kept in ${A}, ${L.staffing === 'permanent' ? `each with its own driver, a Treasury worker hired there and kept on,` : 'driven by Treasury workers hired there as the loads need them,'} burning oil bought there. ` +
    `Trading houses of both towns may load their goods onto it and pay ${fareText(L)}; the Treasury's own goods between the two towns ride it too.${paused}`
  );
}

/** Short label: "Freight line Kingsbridge ⇄ Millbrook". */
function lineLabel(s: SimState, a: TownId, b: TownId): string {
  return `Freight line ${townName(s, a)} ⇄ ${townName(s, b)}`;
}

function checkFare(fare: unknown, price: unknown): { ok: true; fare: LineFare; price: number } | { ok: false; message: string } {
  if (!LINE_FARES.includes(fare as LineFare)) return { ok: false, message: 'Choose what the line charges: a fixed amount per unit, what it costs to run, or nothing.' };
  if (fare !== 'fixed') return { ok: true, fare: fare as LineFare, price: 0 };
  if (!isNum(price) || price < 0 || price > LINE_MAX_FARE) return { ok: false, message: `The fare per unit must be a number between ${moneyText(0)} and ${moneyText(LINE_MAX_FARE)}.` };
  return { ok: true, fare: 'fixed', price };
}

function checkStaffing(x: unknown): string | null {
  if (x !== undefined && x !== 'asNeeded' && x !== 'permanent') return 'A line keeps its drivers either as the loads need them or permanently, one a wagon.';
  return null;
}

function checkWagons(n: unknown): string | null {
  if (!isInt(n) || n < 1 || n > LINE_MAX_WAGONS) return `The number of wagons must be a whole number from 1 to ${LINE_MAX_WAGONS}.`;
  return null;
}

/** openLine: a Treasury freight line between two towns (wagons, drivers and fuel kept in `a`). */
function openLine(s: SimState, a: Extract<PlayerAction, { type: 'openLine' }>): ActionResult {
  if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
  if (!validTown(s, a.a) || !validTown(s, a.b)) return fail('Unknown town.');
  if (a.a === a.b) return fail('Choose two different towns.');
  if (!usableRoute(s, a.a, a.b)) return fail(`No wagon road links ${townName(s, a.a)} and ${townName(s, a.b)}.`);
  const we = checkWagons(a.wagons);
  if (we) return fail(we);
  const fc = checkFare(a.fare, a.farePrice);
  if (!fc.ok) return fail(fc.message);
  const se = checkStaffing(a.staffing);
  if (se) return fail(se);
  if (lineBetween(s, a.a, a.b)) return fail(`A Treasury freight line already runs between ${townName(s, a.a)} and ${townName(s, a.b)}; change its wagons or its fare instead.`);
  if (!s.policy.lines) s.policy.lines = [];
  const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : lineLabel(s, a.a, a.b);
  const L = newLine(s.ids.policy++, a.a, a.b, a.wagons, fc.fare, fc.price, s.day, label, a.staffing === 'permanent' ? 'permanent' : 'asNeeded');
  s.policy.lines.push(L);
  const took = takeStoredTools(s, L);
  L.fareToday = fareFor(s, L);
  const est = estimateLine(s, a.a, a.b, a.wagons);
  const A = townName(s, a.a);
  const notes: string[] = [];
  const short = Math.max(0, (a.wagons + 0.5) * TOOLS_PER_WAGON - L.tools);
  if (took > 1e-6) notes.push(`It takes ${amountOf(TOOLS_GOOD, took)} from the Treasury's stores in ${A} for its wagons${short > 0.05 ? ` and buys the rest there (about ${moneyText(est.wagonCost)} a wagon)` : ''}.`);
  else notes.push(`Its wagons are bought in ${A} as tools (${TOOLS_PER_WAGON} a wagon, about ${moneyText(est.wagonCost)} a wagon at today's price).`);
  if (!findStateworks(s, a.a)) notes.push(`There is no Treasury workforce in ${A}, so it has no drivers.`);
  if (!s.treasury.autoMint && !(s.treasury.purse > 0)) notes.push('The Purse is empty, so it cannot buy wagons or pay drivers until money comes in.');
  const text = describeLine(s, L);
  policyNews(s, text, a.a);
  return { ok: true, message: `${text} ${notes.join(' ')}`.trim(), id: L.id };
}

function updateLine(s: SimState, a: Extract<PlayerAction, { type: 'updateLine' }>): ActionResult {
  const L = isInt(a.id) ? lineById(s, a.id) : undefined;
  if (!L) return fail('No such freight line.');
  const p = a.patch ?? {};
  if (p.wagons !== undefined) {
    const we = checkWagons(p.wagons);
    if (we) return fail(we);
  }
  let fare: { fare: LineFare; price: number } | null = null;
  if (p.fare !== undefined || p.farePrice !== undefined) {
    const mode = p.fare ?? L.fare;
    const fc = checkFare(mode, p.farePrice ?? (mode === 'fixed' ? L.farePrice : undefined));
    if (!fc.ok) return fail(fc.message);
    fare = fc;
  }
  const se = checkStaffing(p.staffing);
  if (se) return fail(se);
  const before = describeLine(s, L);
  const notes: string[] = [];
  if (p.wagons !== undefined && p.wagons !== L.wagonsWanted) {
    L.wagonsWanted = p.wagons;
    const took = takeStoredTools(s, L);
    const back = returnSpareTools(s, L);
    if (took > 1e-6) notes.push(`It takes ${amountOf(TOOLS_GOOD, took)} from the Treasury's stores in ${townName(s, L.a)}.`);
    if (back > 1e-6) notes.push(`${amountOf(TOOLS_GOOD, back)} from its spare wagons go to the Treasury's stores in ${townName(s, L.a)}.`);
  }
  if (fare) {
    L.fare = fare.fare;
    L.farePrice = fare.price;
    L.fareToday = fareFor(s, L);
  }
  if (p.staffing !== undefined) L.staffing = p.staffing;
  if (p.enabled !== undefined) L.enabled = !!p.enabled;
  if (p.enabled !== undefined && Object.keys(p).length === 1) {
    policyNews(
      s,
      L.enabled
        ? `The Treasury's freight line between ${townName(s, L.a)} and ${townName(s, L.b)} takes loads again.`
        : `The Treasury has paused its freight line between ${townName(s, L.a)} and ${townName(s, L.b)}: it takes no new loads, and wagons on the road finish their trips.`,
      L.a,
    );
    return { ok: true, message: L.enabled ? 'Line resumed.' : 'Line paused.', id: L.id };
  }
  const after = describeLine(s, L);
  if (after !== before) policyNews(s, after, L.a);
  return { ok: true, message: `${after}${notes.length ? ' ' + notes.join(' ') : ''}`, id: L.id };
}

function closeLine(s: SimState, a: Extract<PlayerAction, { type: 'closeLine' }>): ActionResult {
  const ls = s.policy.lines ?? [];
  const i = isInt(a.id) ? ls.findIndex((x) => x.id === a.id) : -1;
  if (i < 0) return fail('No such freight line.');
  const L = ls[i];
  const out = wagonsOut(s, L);
  const [tools, oil] = windUpLine(s, L);
  ls.splice(i, 1);
  const { cost } = lineResult(L);
  const A = townName(s, L.a);
  const parts = [`${amountOf(TOOLS_GOOD, tools)} (its wagons)`];
  if (oil > 1e-3) parts.push(amountOf(OIL_GOOD, oil));
  const text =
    `The Treasury has closed its freight line between ${A} and ${townName(s, L.b)}. In all it carried ${qtyText(L.carried)} units for ${moneyText(L.fares)} in fares; its drivers, fuel and wear cost ${moneyText(cost)}. ` +
    `${parts.join(' and ')} go to the Treasury's stores in ${A}.${out > 0 ? ' Goods already on the road still arrive.' : ''}`;
  policyNews(s, text, L.a);
  return { ok: true, message: text, id: L.id };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
const TRANSFER_GROUPS: TransferGroup[] = [...GROUPS, 'bank'];

/** Validate a transfer's optional trade filter: only with group 'firms'. Returns an error or null. */
function checkTransferSector(a: Extract<PlayerAction, { type: 'transfer' }>): string | null {
  if (a.sector === undefined || a.sector === null) return null;
  if (a.group !== 'firms') return 'A trade can only be chosen when handing out to firms.';
  if (!ALL_SECTOR_KEYS.includes(a.sector) || a.sector === 'stateworks') return `Unknown trade "${String(a.sector)}".`;
  return null;
}

/** "firms" / "coal mines" — the recipients of a transfer to firms, in words. */
function firmsText(sector: Sector | undefined): string {
  return sector ? sectorPlural(sector) || 'firms' : 'firms';
}

/** "each of 3 coal mines" — or "the one coal mine" when a trade's firms number one. */
function eachOf(n: number, who: string, group: TransferGroup, sector: Sector | undefined): string {
  if (n === 1 && group === 'firms') return `the one ${sector ? (SECTORS[sector]?.name ?? 'firm').toLowerCase() : 'firm'}`;
  return `each of ${withCommas(n)} ${who}`;
}

function transfer(s: SimState, a: Extract<PlayerAction, { type: 'transfer' }>): ActionResult {
  if (!TRANSFER_GROUPS.includes(a.group)) return fail('Unknown group.');
  if (a.good !== undefined && a.good !== null) return transferGoods(s, a);
  if (a.town !== -1 && !validTown(s, a.town)) return fail('Unknown town.');
  if (!isNum(a.amount) || a.amount <= 0) return fail('The amount must be a positive number.');
  if (a.amount > PLAYER_MAX_MONEY) return fail(`At most ${moneyText(PLAYER_MAX_MONEY)} at once.`);
  if (a.dir !== 1 && a.dir !== -1) return fail('Direction must be 1 (pay) or −1 (take).');
  const se = checkTransferSector(a);
  if (se) return fail(se);
  const sector = a.group === 'firms' ? (a.sector ?? undefined) : undefined;
  const t = s.treasury;
  if (a.dir === 1 && !t.autoMint && !(t.purse > 0)) return fail('The Purse is empty. Create money first, or turn on auto-mint.');
  if (a.group === 'bank' && a.dir === -1 && !(bankClaimRoom(s) > 0)) return fail('The Bank has no capital of its own to spare, so there is nothing to take.');
  const n = a.group === 'bank' ? 1 : countRecipients(s, a.group, a.town, sector);
  const who = a.group === 'firms' ? firmsText(sector) : (GROUP_PLURAL[a.group as Group] ?? 'recipients');
  if (n === 0) return fail(`Nobody matches: there are no ${a.group === 'bank' ? 'recipients' : who}${a.town >= 0 ? ' in ' + townName(s, a.town) : ''}.`);
  const total = executeTransfer(s, a.group, a.town, a.amount, a.dir, sector);
  const where = a.town >= 0 ? ` in ${townName(s, a.town)}` : '';
  let text: string;
  if (a.group === 'bank') {
    const short = total < a.amount - 1e-6 ? ' — all the capital the Bank could spare' : '';
    text = a.dir === 1 ? `The Treasury paid ${moneyText(total)} into the Bank's own capital.` : `The Treasury took ${moneyText(total)} out of the Bank's own capital${short}.`;
  } else if (a.dir === 1) {
    const each = n > 0 ? total / n : 0;
    const scaled = each < a.amount - 1e-6 ? ' — all the Purse could spare' : '';
    text = `The Treasury handed ${moneyText(each)} to ${eachOf(n, who, a.group, sector)}${where} (${moneyText(total)} in all${scaled}).`;
  } else {
    text = `The Treasury collected up to ${moneyText(a.amount)} from ${eachOf(n, who, a.group, sector)}${where} (${moneyText(total)} in all).`;
  }
  policyNews(s, text, a.town);
  return { ok: true, message: text };
}

/**
 * Handing out goods from the Treasury's stores in a town (transfer with `good`): `amount`
 * units to each member of the group there — people's pantries, or firms' stores (group
 * 'firms', optionally one trade; tools handed to a workshop join its tool stock that evening,
 * firms.absorbTools). With too little in store every member gets an equal share of what is
 * held. No money moves.
 */
function transferGoods(s: SimState, a: Extract<PlayerAction, { type: 'transfer' }>): ActionResult {
  const g = a.good as number;
  if (!validGood(g)) return fail('Unknown good.');
  if (a.dir !== 1) return fail('Goods can only be handed out; to gather goods, the Treasury buys them in the market.');
  if (a.group === 'bank') return fail('The Bank takes no goods; hand them to people or firms.');
  if (!validTown(s, a.town)) return fail('Choose the town whose Treasury stores the goods come from.');
  if (!isNum(a.amount) || a.amount <= 0) return fail('The quantity for each recipient must be a positive number.');
  if (a.amount > PLAYER_MAX_QTY) return fail(`At most ${qtyText(PLAYER_MAX_QTY)} units each.`);
  const se = checkTransferSector(a);
  if (se) return fail(se);
  const group = a.group as Group;
  const sector = group === 'firms' ? (a.sector ?? undefined) : undefined;
  if (group !== 'firms' && !GOODS[g].consumer) return fail(`People have no use for ${goodLower(g)} at home; hand it to firms instead.`);
  const town = a.town;
  const have = s.treasury.goods[town]?.[g] ?? 0;
  if (!(have > 1e-9)) return fail(`The Treasury holds no ${goodLower(g)} in ${townName(s, town)}. Buy some there first (or carry some there).`);
  const n = countRecipients(s, group, town, sector);
  const who = group === 'firms' ? firmsText(sector) : (GROUP_PLURAL[group] ?? 'people');
  if (n === 0) return fail(`Nobody matches: there are no ${who} in ${townName(s, town)}.`);
  const total = executeGoodsTransfer(s, group, town, g, a.amount, sector);
  const each = total / n;
  const short = each < a.amount - 1e-6 ? ' — all its stores there held' : '';
  const text = `The Treasury handed ${amountOf(g, each)} from its stores in ${townName(s, town)} to ${eachOf(n, who, group, sector)} there (${qtyText(total)} in all${short}).`;
  policyNews(s, text, town);
  return { ok: true, message: text };
}

/**
 * In kind: move `amount` units of good `g` per member of `group` in `town` from the Treasury's
 * stores there (equal shares of what is held if that is less) into people's pantries / firms'
 * stores. Group 'firms' may be narrowed to one trade. Records stats.acc.transfer_goods_<g>
 * (units) and transfer_goods_value (¤ at the town's price). Returns the units handed out.
 */
export function executeGoodsTransfer(s: SimState, group: Group, town: TownId, g: number, amount: number, sector?: Sector): number {
  if (!(amount > 0) || !Number.isFinite(amount) || !validGood(g) || !validTown(s, town)) return 0;
  const tg = s.treasury.goods[town];
  const have = tg ? Math.max(0, tg[g]) : 0;
  if (!(have > 1e-12)) return 0;
  const n = countRecipients(s, group, town, sector);
  if (n === 0) return 0;
  const each = Math.min(amount, have / n);
  if (!(each > 0)) return 0;
  let total = 0;
  transferMembers(
    s,
    group,
    town,
    (ref, isFirm) => {
      const inv = isFirm ? s.firms[ref - FIRM_BASE]?.inv : s.people[ref]?.pantry;
      if (!inv) return;
      inv[g] += each;
      total += each;
    },
    sector,
  );
  tg[g] = Math.max(0, tg[g] - total);
  if (tg[g] < 1e-9) tg[g] = 0;
  const acc = s.stats.acc;
  const k = 'transfer_goods_' + g;
  acc[k] = (acc[k] || 0) + total;
  const m = s.markets[town * N_GOODS + g];
  const price = m && m.ema > 0 && Number.isFinite(m.ema) ? m.ema : 0;
  acc.transfer_goods_value = (acc.transfer_goods_value || 0) + total * price;
  return total;
}

function transferMembers(s: SimState, group: Group, town: TownId, fn: (ref: number, isFirm: boolean) => void, sector?: Sector): void {
  if (group === 'firms') {
    for (const f of s.firms) {
      if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks' || f.owner === STATE) continue;
      if (town >= 0 && f.town !== town) continue;
      if (sector && f.sector !== sector) continue;
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

function countRecipients(s: SimState, group: TransferGroup, town: TownId, sector?: Sector): number {
  if (group === 'bank') return 1;
  let n = 0;
  transferMembers(s, group, town, () => n++, sector);
  return n;
}

/**
 * One-off transfer: dir 1 = give `amount` to every member of the group (in
 * `town`, or all towns if -1); dir −1 = take up to `amount` from each.
 * 'bank' group → pay to/from BANK (a recapitalisation / levy on the bank).
 * 'all' and 'persons' mean every person; 'firms' every active private firm (of
 * `sector` only, when given).
 * If the Purse cannot cover a payment to everyone (auto-mint off), each member
 * gets an equal share of what it holds. Payments to people count as income
 * (person.earned). Returns total ¤ moved.
 */
export function executeTransfer(s: SimState, group: TransferGroup, town: TownId, amount: number, dir: 1 | -1, sector?: Sector): number {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  if (group === 'bank') {
    // Stats count Bank transfers from the 'recap'/'transfer' flows (stats.ts), not here.
    if (dir === 1) return pay(s, STATE, BANK, amount, 'recap');
    // A seizure takes at most the Bank's own capital (and reserves): the ledger lets the Bank
    // pay any sum, which would sink its capital below zero and bail in every depositor.
    const take = Math.min(amount, bankClaimRoom(s));
    return take > 0 ? pay(s, BANK, STATE, take, 'transfer') : 0;
  }
  const sec = group === 'firms' ? sector : undefined;
  let each = amount;
  if (dir === 1 && !s.treasury.autoMint) {
    const n = countRecipients(s, group, town, sec);
    if (n === 0) return 0;
    const avail = Math.max(0, s.treasury.purse);
    if (avail < each * n) each = avail / n;
    if (!(each > 0)) return 0;
  }
  let total = 0;
  transferMembers(
    s,
    group as Group,
    town,
    (ref, isFirm) => {
      const moved = dir === 1 ? pay(s, STATE, ref, each, 'transfer') : pay(s, ref, STATE, each, 'transfer');
      if (!moved) return;
      total += moved;
      if (!isFirm) {
        const p = s.people[ref];
        if (p) p.earned += dir === 1 ? moved : -moved;
      }
    },
    sec,
  );
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
 * Morning: drop expired levies/limits/orders/carry rules; reset order.filledToday (and the
 * carry rules' day, policy/carry.ts);
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
    steerLevies(s); // aimed rules: today's rate in each town
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
  carriesBeginDay(s);

  const t = s.treasury;
  const was = t.givesSuspended;
  t.givesSuspended = !t.autoMint && !(t.purse > 1e-9);
  if (t.givesSuspended && !was) policyNews(s, 'The Purse is empty: every payment the Treasury has promised is on hold until money comes in.');
  else if (!t.givesSuspended && was) policyNews(s, "The Purse holds money again; the Treasury's promised payments resume.");

  // Freight lines: wagons home, wear, fare, drivers wanted (policy/lines.ts).
  linesBeginDay(s);

  // Treasury workforce per town. With auto-mint off the crews are capped at what the Purse
  // can pay today (none while payments are on hold): otherwise the Treasury keeps hiring
  // people it cannot pay, who then count as employed while earning nothing. The drivers of
  // the freight lines based in the town join the crew (after the labour orders), and the
  // crew is offered at least the lines' wage.
  let budget = t.autoMint ? Infinity : t.givesSuspended ? 0 : Math.max(0, t.purse);
  for (const f of s.firms) {
    if (!f || !f.alive || f.sector !== 'stateworks') continue;
    let target = 0;
    let wage = 0;
    for (const o of P.orders) {
      if (!o.enabled || o.market.kind !== 'labor' || o.market.town !== f.town || o.side !== 'buy') continue;
      if (orderExhausted(o)) continue;
      // The going wage + band, re-set each morning.
      if (o.priceMode === 'follow') {
        const w = effectiveOrderLimit(s, o);
        if (w > 0) o.price = w;
      }
      // Staffing the town's projects: as many as they can use today, within the order's maximum.
      let want = o.qty;
      if (o.staff === 'projects') {
        want = Math.min(o.qty, treasuryCrewWanted(s, f.town));
        o.staffToday = want;
      }
      // Never more workers than the order's remaining worker-days.
      target += o.total >= 0 ? Math.min(want, Math.max(0, Math.ceil(o.total - o.filled - 1e-9))) : want;
      if (want > 0 && o.price > wage) wage = o.price;
    }
    if (P.lines?.length) {
      const d = lineDriversWanted(s, f.town);
      if (d.n > 0) {
        target += d.n;
        if (d.wage > wage) wage = d.wage;
      }
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
  /** Today so far: released to the market, cancelled against the Treasury's own orders, filled. */
  askedDay?: number;
  nettedDay?: number;
  filledDay?: number;
  /** Patient orders: the step the day opened at, and the lowest step at which a session filled in full. */
  open?: number;
  firstFull?: number;
}

/** A patient order that follows the market (goods, IOUs, gold): it steps within the day and learns where to open. */
function isPatient(po: PlayerOrder): boolean {
  return po.pace === 'patient' && po.priceMode === 'follow' && po.market.kind !== 'labor';
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
  const t = s.treasury;
  if (orders.length === 0) {
    if (s.policy.lines?.length) lineOrders(s, books, t.autoMint ? 1e15 : Math.max(0, t.purse));
    return;
  }
  let budget = t.autoMint ? 1e15 : Math.max(0, t.purse);
  const committed: Record<number, number> = {};
  let iouBuyCommitted = 0;
  let goldCommitted = 0;
  for (const po of orders) {
    if (!po.enabled || po.market.kind === 'labor') continue;
    if (po.until >= 0 && po.until < s.day) continue;
    let q = po.qty;
    if (po.total >= 0) q = Math.min(q, po.total - po.filled);
    // Orders that follow the market re-set their limit to today's going price ± band.
    const mode = po.priceMode ?? 'fixed';
    if (mode !== 'fixed') {
      const lim = effectiveOrderLimit(s, po);
      if (!(lim > 0)) continue;
      po.price = lim;
    }
    if (!(q > 1e-9) || !(po.price >= 0)) continue;
    const m = po.market;
    const buy = po.side === 'buy';
    // What a unit is budgeted at: its limit, except 'any price' buys, budgeted near the going
    // price (their limit is only a formality; settlement scales any fill the Purse cannot pay).
    // A patient buy may step up to the band's edge by the close: it is budgeted there.
    const perUnit = buy && mode === 'any' ? orderRefPrice(s, m) * ORDER_ANY_BUDGET_MULT : buy && isPatient(po) ? orderRefPrice(s, m) * (1 + Math.min(ORDER_BAND_MAX, Math.max(0, fin(po.band)))) : po.price;
    if (buy) {
      if (!(po.price > 0) || !(perUnit > 0)) continue;
      q = Math.min(q, budget / perUnit);
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
    if (buy) budget -= q * perUnit;
    const opt = { exempt: true, tag: po.id, session: po.session };
    const ord = buy ? addBid(book, STATE, po.price, q, opt) : addAsk(book, STATE, po.price, q, opt);
    sub.push({ po, ord, open: isPatient(po) ? (po.offset ?? 0) : undefined });
  }
  // Freight lines: the tools and oil they lack, in their depot towns (policy/lines.ts).
  if (s.policy.lines?.length) lineOrders(s, books, budget);
}

/** Credit one order's fills of a session (or, without sessions, of the day) to its record. */
function creditFill(x: Submitted, f: number, paid: number, netted: number): void {
  const { po } = x;
  x.filledDay = (x.filledDay ?? 0) + f;
  x.nettedDay = (x.nettedDay ?? 0) + netted;
  po.nettedToday = x.nettedDay > 1e-9 ? x.nettedDay : 0;
  po.filledToday += f;
  po.filled += f;
  if (f > 0) po.value += po.side === 'buy' ? paid : -paid;
}

/**
 * Before market session k (markets.clearAll hook): Treasury cargo due by then lands (the
 * opening's was delivered in the morning) and the Treasury's sell orders are re-sized to what
 * its stores hold now — cargo that landed during the day is on sale in the next session.
 */
export function playerBeforeSession(s: SimState, books: Books, k: number): void {
  if (k > 0 && s.shipments.length) deliverTreasuryDue(s, s.day + (SESSION_TIMES[k] ?? 1));
  const sub = rt(s).bag.playerSubmitted as Submitted[] | undefined;
  if (sub && k > 0) resizeTreasurySales(s, books, sub);
}

/**
 * Before a later session: the Treasury's goods sell orders offer what it holds now — what an
 * earlier session bought (or cargo that landed) can be sold later the same day — never more than
 * the order's day still allows (and what a carry loaded after an earlier session has left).
 */
function resizeTreasurySales(s: SimState, books: Books, sub: Submitted[]): void {
  const t = s.treasury;
  const byId = new Map<number, Submitted>();
  for (const x of sub) byId.set(x.po.id, x);
  const committed: Record<number, number> = {};
  for (const po of s.policy.orders) {
    if (!po.enabled || po.side !== 'sell' || po.market.kind !== 'good') continue;
    if (po.until >= 0 && po.until < s.day) continue;
    const m = po.market;
    if (!validTown(s, m.town) || !validGood(m.good)) continue;
    const kk = m.town * N_GOODS + m.good;
    const x = byId.get(po.id);
    // what the day still allows: less what sold and what cancelled against the Treasury's own purchases
    let want = Math.max(0, po.qty - po.filledToday - (x?.nettedDay ?? 0));
    if (po.total >= 0) want = Math.min(want, Math.max(0, po.total - po.filled));
    const have = Math.max(0, (t.goods[m.town]?.[m.good] ?? 0) - (committed[kk] || 0));
    const q = Math.min(want, have);
    committed[kk] = (committed[kk] || 0) + q;
    if (x) x.ord.left = q;
    else if (q > 1e-9) {
      const book = books.goods[kk];
      if (!book) continue;
      const ord = addAsk(book, STATE, po.price, q, { exempt: true, tag: po.id, session: po.session });
      ord.dayQty = ord.left = q;
      ord.filledDay = ord.paidDay = 0;
      sub.push({ po, ord });
    }
  }
}

/**
 * A patient order after session k: a session that filled what it brought (after any cancelling
 * against the Treasury's own orders) records the step it filled at; one that left it short raises
 * the limit for the rest of the day — by at least a step, and far enough that the close bids the
 * band's edge (max(step, room left ÷ sessions left)). It never goes beyond the band.
 */
function stepPatient(s: SimState, x: Submitted, k: number): void {
  const po = x.po;
  const o = x.ord;
  const asked = o.qty; // this session's quantity after cancelling
  if (!(asked > 1e-9)) return;
  const short = (o.filled > 0 ? o.filled : 0) < asked * (1 - 1e-3);
  const off = po.offset ?? 0;
  if (!short) {
    if (x.firstFull === undefined) x.firstFull = off;
    return;
  }
  const left = MARKET_SESSIONS - 1 - k;
  if (left <= 0 || po.session !== undefined) return; // the close (or a one-session order): tomorrow learns
  const b = Math.min(ORDER_BAND_MAX, Math.max(0, fin(po.band)));
  const next = Math.min(b, off + Math.max(patientStep(b), (b - off) / left));
  if (!(next > off + 1e-12)) return;
  po.offset = next;
  const lim = effectiveOrderLimit(s, po);
  if (lim > 0) {
    po.price = lim;
    o.limit = lim;
  }
}

/**
 * After market session k (markets.clearAll hook): credit the session's fills to the Treasury's
 * orders, then let the carry rules load what the stores now hold (their wagons leave after the
 * session, by each rule's wagons setting: policy/carry.ts).
 */
export function playerAfterSession(s: SimState, k: number): void {
  const bag = rt(s).bag;
  bag.playerSessionsDay = s.day;
  const sub = bag.playerSubmitted as Submitted[] | undefined;
  if (sub) {
    for (const x of sub) {
      const o = x.ord;
      const released = o.released ?? 0;
      x.askedDay = (x.askedDay ?? 0) + released;
      creditFill(x, o.filled > 0 ? o.filled : 0, o.paid, Math.max(0, released - o.qty));
      if (x.open !== undefined) stepPatient(s, x, k);
    }
  }
  runCarries(s, k);
}

/**
 * After clearing: update order.filled/filledToday/value, run the carry rules, step patient
 * orders, attribute Treasury workers, disable once-orders and exhausted totals. With market
 * sessions (engine) the fills were credited (and carries run) session by session; without them
 * (a bare clearAll) the day is credited here.
 */
export function playerAfterClear(s: SimState, books: Books): void {
  void books;
  const bag = rt(s).bag;
  const sessions = bag.playerSessionsDay === s.day;
  const sub = bag.playerSubmitted as Submitted[] | undefined;
  if (!sessions) {
    if (sub)
      for (const x of sub) {
        x.askedDay = x.ord.dayQty ?? x.ord.qty;
        creditFill(x, x.ord.filled > 0 ? x.ord.filled : 0, x.ord.paid, 0);
      }
    runCarries(s, MARKET_SESSIONS - 1);
  }
  if (sub) {
    for (const x of sub) {
      const po = x.po;
      // A patient order: tomorrow opens a step below the lowest step at which a session filled in
      // full today (it keeps probing for a lower price); a day with no full session opens a step
      // higher. Within the day it steps up only when short (stepPatient).
      const want = (x.askedDay ?? 0) - (x.nettedDay ?? 0);
      if (x.open !== undefined && isPatient(po) && want > 1e-9) {
        if (!sessions && x.firstFull === undefined && (x.filledDay ?? 0) >= want * (1 - 1e-3)) x.firstFull = x.open;
        const b = Math.min(ORDER_BAND_MAX, Math.max(0, fin(po.band)));
        const step = patientStep(b);
        po.reached = po.offset ?? x.open;
        po.offset = x.firstFull !== undefined ? Math.max(-b, x.firstFull - step) : Math.min(b, x.open + step);
      } else if (x.open !== undefined) po.offset = x.open;
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
        const wanted = o.staff === 'projects' ? (o.staffToday ?? 0) : o.qty;
        const room = o.total >= 0 ? Math.max(0, o.total - o.filled) : wanted;
        const n = Math.min(wanted, left, room);
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
  // Freight lines: their purchases join their stores; today's loads leave (policy/lines.ts).
  if (s.policy.lines?.length) linesAfterClear(s);
}

