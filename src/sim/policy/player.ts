// ============================================================================
// The player's primitives: validation + execution of PlayerActions, Treasury
// orders in markets (incl. supply routes: buy → carry → offer, policy/routes.ts),
// Treasury workforce, transfers (money, or goods in kind), freight lines (open /
// change / close; their daily running lives in policy/lines.ts). See DESIGN §5.
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
  WAGON_CAPACITY,
  PRICE_MIN,
  IOU_SELL_FLOOR_MIN_SHARE,
  ROUTE_MARGIN_MAX,
  ROUTE_MARGIN_MIN,
  ROUTE_HOLD_DAYS,
  ROUTE_LOAD_SHARE,
  SELL_FLOOR_WARN_SHARE,
  ROUTE_MARKET_FLOOR_SHARE,
  ORDER_ANY_BUDGET_MULT,
  ORDER_ANY_MULT,
  ORDER_BAND_MAX,
} from '../config';
import { dateLabel } from '../calendar';
import { fin } from '../util';
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
  OrderPriceMode,
  OrderRoute,
  PlayerAction,
  PlayerOrder,
  Sector,
  SimState,
  TownId,
  TransferGroup,
} from '../types';
import { addAsk, addBid, type Books } from '../market/markets';
import { bankClaimRoom, inGroup, isTargetedSale } from './levies';
import { heldAtOrigin, isRouteOrder, marketFloor, newRoute, routeBusy, routeFloor } from './routes';
import { news } from '../stats/events';
import { cancelProject, estimateCost, startProject } from '../agents/construction';
import { freightPerUnit, sendTreasuryCargo, traderOf } from '../agents/traders';
import { roadPlan } from '../world/paths';
import { LINE_MAX_FARE, LINE_MAX_WAGONS, TOOLS_PER_WAGON } from '../config';
import { G } from '../goods';
import type { FreightLine, LineFare } from '../types';
import {
  estimateLine,
  fareFor,
  lineBetween,
  lineById,
  lineDriversWanted,
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
  if (isTargetedSale(l)) {
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
  const amt = l.unit === 'pct' ? pctText(l.rate) + (STOCK_BASES[l.base] ? '/yr' : '') : moneyText(l.rate) + per;
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

/** How a route (or a move with a sale) offers its goods: "at landed cost", "for no less than ¤3.20 each"... */
function sellRuleText(mode: OrderRoute['sell'], price: number, margin: number): string {
  if (mode === 'fixed') return `for no less than ${moneyText(price)} each`;
  if (mode === 'market') return 'for whatever it fetches';
  if (Math.abs(margin) < 1e-9) return 'at landed cost';
  return margin > 0 ? `at landed cost plus ${pctText(margin)}` : `at ${pctText(-margin)} below landed cost`;
}

/** Plain sentence describing a Treasury order. */
export function describeOrder(s: SimState, o: PlayerOrder): string {
  const m = o.market;
  const span = o.once ? ' today' : o.until >= 0 ? ` until ${dateLabel(o.until)}` : '';
  const cap = o.total >= 0 ? ` (at most ${qtyText(o.total)} in all)` : '';
  if (m.kind === 'good' && o.route) {
    const r = o.route;
    return `The Treasury will buy up to ${amountOf(m.good, o.qty)} a day in ${townName(s, m.town)}, ${priceTerms(s, o, ' each')}${span}${cap}, carry it to ${townName(s, r.to)} and offer it there ${sellRuleText(r.sell, r.sellPrice, r.sellMargin)}.`;
  }
  if (m.kind === 'labor') {
    const lcap = o.total >= 0 ? ` (at most ${qtyText(o.total)} worker-days in all)` : '';
    return `The Treasury will employ up to ${qtyText(o.qty)} people in ${townName(s, m.town)} at ${moneyText(o.price)} a day${span}${lcap}. They work on the Treasury's building projects there, or wait idle.`;
  }
  if (m.kind === 'good') {
    const what = amountOf(m.good, o.qty);
    return o.side === 'buy'
      ? `The Treasury will buy up to ${what} a day in ${townName(s, m.town)}, ${priceTerms(s, o, ' each')}${span}${cap}.`
      : `The Treasury will sell up to ${what} a day in ${townName(s, m.town)}, ${priceTerms(s, o, ' each')}${span}${cap}.`;
  }
  if (m.kind === 'iou')
    return o.side === 'buy'
      ? `The Treasury will buy back up to ${qtyText(o.qty)} of its IOUs a day, ${priceTerms(s, o, ' each')}${span}${cap}.`
      : `The Treasury will sell up to ${qtyText(o.qty)} new IOUs a day (each pays ${moneyText(5)} a year forever), ${priceTerms(s, o, ' each')}${span}${cap}.`;
  return o.side === 'buy'
    ? `The Treasury will buy up to ${qtyText(o.qty)} oz of gold a day, ${priceTerms(s, o, ' an ounce')}${span}${cap}.`
    : `The Treasury will sell up to ${qtyText(o.qty)} oz of gold a day, ${priceTerms(s, o, ' an ounce')}${span}${cap}.`;
}

function orderShortLabel(s: SimState, side: 'buy' | 'sell', m: OrderMarket, price: number, qty: number, route?: OrderRoute | null, mode: OrderPriceMode = 'fixed', band = 0): string {
  if (m.kind === 'labor') return `Employ ${qtyText(qty)} · ${townName(s, m.town)} · ${moneyText(price)}/day`;
  const lim =
    mode === 'any' ? 'any price' : mode === 'follow' ? `market ${side === 'buy' ? '+' : '−'}${pctText(band)}` : `${side === 'buy' ? '≤' : '≥'} ${moneyText(price)}`;
  const base = `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyText(qty)}/day · ${marketText(s, m)} · ${lim}`;
  return route ? `${base} → ${townName(s, route.to)}` : base;
}

function policyNews(s: SimState, text: string, town = -1): void {
  news(s, text, 'policy', town);
}

function ruleCount(s: SimState): number {
  return s.policy.levies.length + s.policy.limits.length + s.policy.orders.length + (s.policy.lines?.length ?? 0);
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
      if (p.priceMode !== undefined || p.band !== undefined) {
        const pm = checkPriceMode(p.priceMode ?? next.priceMode, p.band ?? (next.priceMode === 'follow' ? next.band : undefined), o.market);
        if (!pm.ok) return fail(pm.message);
        next.priceMode = pm.mode;
        next.band = pm.band;
        if (pm.mode !== 'fixed') {
          const lim = effectiveOrderLimit(s, { market: o.market, side: o.side, price: 0, priceMode: pm.mode, band: pm.band });
          if (!(lim > 0)) return fail('That market has no going price yet to follow; keep a fixed price.');
          next.price = lim;
        }
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
      let sellSpec: SellSpec | null = null;
      if (p.route !== undefined) {
        if (!isRouteOrder(o)) return fail('Only a supply route has a selling rule to change.');
        const c = checkSell(p.route?.sell, p.route?.sellPrice, p.route?.sellMargin);
        if (!c.ok) return fail(c.message);
        sellSpec = c.spec;
      }
      Object.assign(o, next);
      if (sellSpec && isRouteOrder(o)) {
        // Only the selling rule changes; goods on the road and waiting keep their landed cost.
        o.route.sell = sellSpec.mode;
        o.route.sellPrice = sellSpec.price;
        o.route.sellMargin = sellSpec.margin;
      }
      if (o.total >= 0 && o.filled >= o.total && o.enabled) o.enabled = false;
      o.label = orderShortLabel(s, o.side, o.market, o.price, o.qty, o.route, o.priceMode, o.band);
      return { ok: true, message: o.enabled ? describeOrder(s, o) : 'Order paused.', id: o.id };
    }
    case 'cancelOrder': {
      const i = s.policy.orders.findIndex((x) => x.id === a.id);
      if (i < 0) return fail('No such order.');
      const o = s.policy.orders[i];
      // A supply route stops buying; what it already bought stays in the Treasury's stores.
      const kept = isRouteOrder(o) ? routeLeftovers(s, o) : '';
      if (isRouteOrder(o)) o.route.waiting = 0; // waiting stock becomes ordinary holdings
      s.policy.orders.splice(i, 1);
      if (kept) policyNews(s, `The Treasury has stopped its supply route “${o.label}”. ${kept}`, o.market.kind === 'good' ? o.market.town : -1);
      return { ok: true, message: `Order withdrawn (${qtyText(o.filled)} filled in all).${kept ? ' ' + kept : ''}`, id: o.id };
    }
    case 'moveGoods':
      return moveGoods(s, a);
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
function orderRefPrice(s: SimState, m: OrderMarket): number {
  const mk = m.kind === 'good' ? s.markets[m.town * N_GOODS + m.good] : m.kind === 'iou' ? s.iouMarket : m.kind === 'gold' ? s.goldMarket : undefined;
  const p = mk ? (mk.ema > 0 ? mk.ema : mk.price) : 0;
  if (p > 0 && Number.isFinite(p)) return p;
  return m.kind === 'iou' ? IOU_PAR : 0;
}

/** Lowest floor an 'any price' / following sell order may use (IOU issuance keeps its own guard). */
function sellFloorShare(m: OrderMarket): number {
  return m.kind === 'iou' ? Math.max(ROUTE_MARKET_FLOOR_SHARE, IOU_SELL_FLOOR_MIN_SHARE) : ROUTE_MARKET_FLOOR_SHARE;
}

/**
 * Today's limit for an order that follows the market: the going price (the market's
 * smoothed clearing price) plus the band for buys, minus it for sells; 'any' buys bid
 * ORDER_ANY_MULT × the going price, 'any' sells take a token floor. 0 if the market has
 * no price yet. Fixed orders return their own price.
 */
export function effectiveOrderLimit(s: SimState, o: Pick<PlayerOrder, 'market' | 'side' | 'price' | 'priceMode' | 'band'>): number {
  const mode = o.priceMode ?? 'fixed';
  if (mode === 'fixed' || o.market.kind === 'labor') return o.price;
  const ref = orderRefPrice(s, o.market);
  if (!(ref > 0)) return 0;
  const floor = ref * sellFloorShare(o.market);
  if (mode === 'follow') {
    const b = Math.min(ORDER_BAND_MAX, Math.max(0, fin(o.band)));
    return o.side === 'buy' ? ref * (1 + b) : Math.max(floor, ref * (1 - b));
  }
  return o.side === 'buy' ? ref * ORDER_ANY_MULT : floor;
}

/** The price part of an order's description, in words. */
function priceTerms(s: SimState, o: Pick<PlayerOrder, 'market' | 'side' | 'price' | 'priceMode' | 'band'>, unit: string): string {
  const mode = o.priceMode ?? 'fixed';
  if (mode === 'any') return o.side === 'buy' ? 'at whatever price the market asks' : 'for whatever the market pays';
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
  let price = a.price;
  if (mode === 'fixed') {
    if (!isNum(a.price) || a.price < 0 || a.price > PLAYER_MAX_PRICE) return fail(`The price must be a number between 0 and ${moneyText(PLAYER_MAX_PRICE)}.`);
    if ((a.side === 'buy' || m.kind === 'labor') && a.price <= 0) return fail(m.kind === 'labor' ? 'The daily wage must be above zero.' : 'A buying price must be above zero.');
  } else {
    price = effectiveOrderLimit(s, { market: m, side: a.side, price: 0, priceMode: mode, band });
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
  // Supply route: goods BUY orders only (policy/routes.ts).
  let route: OrderRoute | null = null;
  let routeNote = '';
  if (a.route !== undefined && a.route !== null) {
    if (m.kind !== 'good' || a.side !== 'buy') return fail('Only a purchase of goods can be carried to another town and offered there.');
    const rc = checkRoute(s, m.town, m.good, a.route);
    if (!rc.ok) return fail(rc.message);
    route = rc.route;
    routeNote = rc.note;
  }
  const lbl = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : orderShortLabel(s, a.side, m, price, qty, route, mode, band);
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
    route,
    priceMode: mode,
    band,
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
  if (routeNote) note += ' ' + routeNote;
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
  if (m.kind === 'labor') return { ok: false, message: 'Treasury workers are hired at a fixed daily wage.' };
  if (mode === 'any') return { ok: true, mode, band: 0 };
  const b = band === undefined ? 0.1 : band;
  if (!isNum(b) || b < 0 || b > ORDER_BAND_MAX) return { ok: false, message: `The band around the going price must lie between 0% and ${pctText(ORDER_BAND_MAX)} (0.1 = 10%).` };
  return { ok: true, mode, band: b };
}

type SellSpec = { mode: OrderRoute['sell']; price: number; margin: number };

/** Validate how goods are to be offered at their destination (a route's `sell`, or moveGoods' `sell`). */
function checkSell(mode: unknown, price: unknown, margin: unknown): { ok: true; spec: SellSpec } | { ok: false; message: string } {
  if (mode !== 'fixed' && mode !== 'cost' && mode !== 'market') return { ok: false, message: 'Choose how the goods are offered on arrival: at a fixed lowest price, at landed cost, or for whatever they fetch.' };
  if (mode === 'fixed') {
    if (!isNum(price) || price <= 0 || price > PLAYER_MAX_PRICE) return { ok: false, message: `The lowest selling price must be above zero and at most ${moneyText(PLAYER_MAX_PRICE)}.` };
    return { ok: true, spec: { mode, price, margin: 0 } };
  }
  if (mode === 'cost') {
    const mg = margin === undefined ? 0 : margin;
    if (!isNum(mg) || mg < ROUTE_MARGIN_MIN || mg > ROUTE_MARGIN_MAX)
      return { ok: false, message: `The margin over landed cost must lie between ${pctText(ROUTE_MARGIN_MIN)} and ${pctText(ROUTE_MARGIN_MAX)} (0.1 = 10%).` };
    return { ok: true, spec: { mode, price: 0, margin: mg } };
  }
  return { ok: true, spec: { mode, price: 0, margin: 0 } };
}

/** Validate a supply route from `from` (the order's town) for good `g`. */
function checkRoute(s: SimState, from: TownId, g: number, raw: unknown): { ok: true; route: OrderRoute; note: string } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'No route given.' };
  const r = raw as { to?: unknown; sell?: unknown; sellPrice?: unknown; sellMargin?: unknown };
  if (!validTown(s, r.to)) return { ok: false, message: 'Choose the town the goods are carried to.' };
  const to = r.to;
  if (to === from) return { ok: false, message: 'The goods must be carried to a different town from the one they are bought in.' };
  if (!(freightPerUnit(s, from, to) >= 0)) return { ok: false, message: `No wagon road links ${townName(s, from)} and ${townName(s, to)}.` };
  const c = checkSell(r.sell, r.sellPrice, r.sellMargin);
  if (!c.ok) return c;
  let note = '';
  if (!traderOf(s, from)) note = `There is no trading house in ${townName(s, from)} yet to carry the goods; what is bought waits there until one opens.`;
  else if (!s.treasury.autoMint) note = `Freight is paid from the Purse as the goods leave; on days it cannot be paid they wait in ${townName(s, from)}.`;
  void g;
  return { ok: true, route: newRoute(to, c.spec.mode, c.spec.price, c.spec.margin), note };
}

/** What a route still holds, in words (for its cancellation), or '' if nothing. */
function routeLeftovers(s: SimState, o: PlayerOrder): string {
  if (!isRouteOrder(o)) return '';
  const g = o.market.good;
  const r = o.route;
  const parts: string[] = [];
  if (r.waiting > 1e-3) parts.push(`${amountOf(g, r.waiting)} unsold in ${townName(s, r.to)}`);
  if (r.inTransit > 1e-3) parts.push(`${amountOf(g, r.inTransit)} on the road there`);
  const held = heldAtOrigin(s, o);
  if (held > 1e-3) parts.push(`${amountOf(g, held)} still in ${townName(s, o.market.town)}`);
  if (!parts.length) return '';
  return `What it had bought stays in the Treasury's stores as ordinary holdings: ${parts.join(', ')}.`;
}

/** moveGoods: carry Treasury goods to another town, optionally offering them there (an ordinary sell order capped at the quantity moved). */
function moveGoods(s: SimState, a: Extract<PlayerAction, { type: 'moveGoods' }>): ActionResult {
  if (!validTown(s, a.from) || !validTown(s, a.to)) return fail('Unknown town.');
  if (a.from === a.to) return fail('Choose two different towns.');
  if (!validGood(a.good)) return fail('Unknown good.');
  if (!isNum(a.qty) || a.qty <= 0) return fail('The quantity must be a positive number.');
  const have = s.treasury.goods[a.from]?.[a.good] ?? 0;
  if (have <= 1e-9) return fail(`The Treasury holds no ${goodLower(a.good)} in ${townName(s, a.from)}.`);
  let spec: SellSpec | null = null;
  if (a.sell !== undefined && a.sell !== null) {
    if (typeof a.sell !== 'object') return fail('Say how the goods are to be offered on arrival.');
    const c = checkSell(a.sell.mode, a.sell.price, a.sell.margin);
    if (!c.ok) return fail(c.message);
    if (ruleCount(s) >= PLAYER_MAX_RULES) return fail(`There are already ${PLAYER_MAX_RULES} rules and orders; remove some first.`);
    spec = c.spec;
  }
  // What the goods were worth where they were (the Treasury keeps no cost record of its stores).
  const origin = s.markets[a.from * N_GOODS + a.good];
  const worth = origin && origin.ema > 0 && Number.isFinite(origin.ema) ? origin.ema : 0;
  const q = Math.min(a.qty, have);
  const r = sendTreasuryCargo(s, a.from, a.to, a.good, q);
  if (!r.ok) return { ok: false, message: r.message };
  if (!spec) {
    policyNews(s, `The Treasury sent ${amountOf(a.good, r.qty)} from ${townName(s, a.from)} to ${townName(s, a.to)}.`, a.from);
    return { ok: true, message: r.message, id: r.id };
  }
  // Landed cost per unit: the goods' value at the origin plus the freight per unit.
  const landed = worth + r.paid / Math.max(1e-9, r.qty);
  const floor = spec.mode === 'fixed' ? spec.price : spec.mode === 'cost' ? Math.max(0, landed * (1 + spec.margin)) : marketFloor(s, a.to, a.good);
  const market: OrderMarket = { kind: 'good', town: a.to, good: a.good };
  const o: PlayerOrder = {
    id: s.ids.policy++,
    label: orderShortLabel(s, 'sell', market, floor, r.qty),
    enabled: true,
    market,
    side: 'sell',
    price: floor,
    qty: r.qty,
    total: r.qty,
    until: -1,
    once: false,
    filled: 0,
    value: 0,
    filledToday: 0,
    created: s.day,
    route: null,
    priceMode: 'fixed',
    band: 0,
  };
  s.policy.orders.push(o);
  const how = sellRuleText(spec.mode, spec.mode === 'fixed' ? spec.price : 0, spec.margin);
  const floorNote = spec.mode === 'cost' ? ` (${moneyText(floor)} each: what they were worth in ${townName(s, a.from)} plus the freight${spec.margin ? ', and the margin' : ''})` : '';
  const text = `The Treasury sent ${amountOf(a.good, r.qty)} from ${townName(s, a.from)} to ${townName(s, a.to)} and will offer them there ${how}${floorNote} once they arrive.`;
  policyNews(s, text, a.from);
  return { ok: true, message: `${r.message} ${text}`, id: r.id };
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
    `The Treasury runs a freight line between ${A} and ${B}: ${qtyText(n)} wagon${n === 1 ? '' : 's'} kept in ${A}, driven by Treasury workers hired there and burning oil bought there. ` +
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
  if (lineBetween(s, a.a, a.b)) return fail(`A Treasury freight line already runs between ${townName(s, a.a)} and ${townName(s, a.b)}; change its wagons or its fare instead.`);
  if (!s.policy.lines) s.policy.lines = [];
  const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : lineLabel(s, a.a, a.b);
  const L = newLine(s.ids.policy++, a.a, a.b, a.wagons, fc.fare, fc.price, s.day, label);
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
 * Morning: drop expired levies/limits/orders (a supply route's order stays while it still
 * holds, carries or offers goods: its buy side is over, its sales go on); reset
 * order.filledToday and a route's shippedToday / soldToday;
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
    for (const o of P.orders) {
      if (!(o.until >= 0 && o.until < day)) keep.push(o);
      else if (isRouteOrder(o)) {
        if (routeBusy(s, o)) keep.push(o);
        else policyNews(s, routeSummary(s, o), o.market.town);
      }
    }
    if (keep.length !== P.orders.length) P.orders = keep;
    for (const o of P.orders) {
      o.filledToday = 0;
      if (o.route) {
        o.route.shippedToday = 0;
        o.route.soldToday = 0;
      }
    }
  }

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
      // Never more workers than the order's remaining worker-days.
      target += o.total >= 0 ? Math.min(o.qty, Math.max(0, Math.ceil(o.total - o.filled - 1e-9))) : o.qty;
      if (o.price > wage) wage = o.price;
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
  /** true: the ask of a supply route's waiting stock at its destination (credited to the route). */
  route: boolean;
}

/** A finished supply route in words (when its order lapses with nothing left to carry or sell). */
function routeSummary(s: SimState, o: PlayerOrder): string {
  if (!isRouteOrder(o)) return '';
  const r = o.route;
  const g = o.market.good;
  return `The Treasury's supply route “${o.label}” has run its course: ${amountOf(g, o.filled)} bought in ${townName(s, o.market.town)} for ${moneyText(o.value)}, ${qtyText(r.soldTotal)} sold in ${townName(s, r.to)} for ${moneyText(r.revenue)}, freight ${moneyText(r.freightPaid)}.`;
}

/**
 * Supply routes, after clearing: load what each route has bought and not yet sent
 * (routes.heldAtOrigin — today's purchases, and any left waiting for freight) onto the
 * Treasury's wagons (traders.sendTreasuryCargo): freight from the Purse to the origin's
 * trading house, cargo tagged with the order, basis = purchase cost + freight per unit.
 * Purchase cost: today's units at today's average price, older ones at the order's average.
 * While the order is still buying, a load leaves once it fills ROUTE_LOAD_SHARE of a wagon or
 * amounts to ROUTE_HOLD_DAYS of the order's daily quantity (whichever is less): the Purse pays
 * a whole wagon's trip however little it carries. When the freight cannot be paid (auto-mint
 * off, Purse short) the goods wait at the origin and the route tries again the next day.
 */
function shipRoutes(s: SimState, paidToday: Record<number, number>): void {
  for (const o of s.policy.orders) {
    if (!isRouteOrder(o)) continue;
    const held = heldAtOrigin(s, o);
    if (!(held > 1e-6)) continue;
    const buying = o.enabled && !(o.until >= 0 && o.until <= s.day) && !orderExhausted(o) && !o.once;
    if (buying && held < Math.min(ROUTE_LOAD_SHARE * WAGON_CAPACITY, ROUTE_HOLD_DAYS * o.qty) - 1e-6) continue;
    const r = o.route;
    const life = o.filled > 0 ? o.value / o.filled : o.price;
    const qT = Math.min(held, Math.max(0, o.filledToday));
    const pT = qT > 0 && o.filledToday > 0 ? (paidToday[o.id] ?? 0) / o.filledToday : life;
    const unitCost = (qT * pT + (held - qT) * life) / held;
    const res = sendTreasuryCargo(s, o.market.town, r.to, o.market.good, held, { unitCost, order: o.id });
    if (res.ok) {
      r.shippedToday += res.qty;
      r.shippedTotal += res.qty;
      r.freightPaid += res.paid;
      r.inTransit += res.qty;
    } else {
      // Held back (no freight money, no trading house): say why on the first day of a spell.
      const fails = (rt(s).bag.routeFails ??= {}) as Record<number, number>;
      if (fails[o.id] !== s.day - 1) policyNews(s, `The Treasury's ${goodLower(o.market.good)} bought in ${townName(s, o.market.town)} for ${townName(s, r.to)} waits there: ${lowerFirst(res.message)}`, o.market.town);
      fails[o.id] = s.day;
    }
  }
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
  // ---- supply routes: offer the goods waiting at each destination (even once the buy side is over);
  // what a route bought and still holds at its origin is kept from the Treasury's other sell orders there ----
  for (const po of orders) {
    if (!isRouteOrder(po)) continue;
    const r = po.route;
    const held = heldAtOrigin(s, po);
    if (held > 1e-9) {
      const ko = po.market.town * N_GOODS + po.market.good;
      committed[ko] = (committed[ko] || 0) + held;
    }
    if (!(r.waiting > 1e-9)) continue;
    const g = po.market.good;
    if (!validTown(s, r.to) || !validGood(g)) continue;
    const k = r.to * N_GOODS + g;
    // Never offer more than the Treasury holds there (spoilage, or stock another order sold).
    const have = Math.max(0, (t.goods[r.to]?.[g] ?? 0) - (committed[k] || 0));
    if (r.waiting > have) r.waiting = have;
    if (!(r.waiting > 1e-9)) {
      r.waiting = 0;
      continue;
    }
    const book = books.goods[k];
    if (!book) continue;
    committed[k] = (committed[k] || 0) + r.waiting;
    const ord = addAsk(book, STATE, routeFloor(s, po), r.waiting, { exempt: true, tag: po.id });
    sub.push({ po, ord, route: true });
  }
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
    const perUnit = buy && mode === 'any' ? orderRefPrice(s, m) * ORDER_ANY_BUDGET_MULT : po.price;
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
    const ord = buy ? addBid(book, STATE, po.price, q, { exempt: true, tag: po.id }) : addAsk(book, STATE, po.price, q, { exempt: true, tag: po.id });
    sub.push({ po, ord, route: false });
  }
  // Freight lines: the tools and oil they lack, in their depot towns (policy/lines.ts).
  if (s.policy.lines?.length) lineOrders(s, books, budget);
}

/**
 * After clearing: update order.filled/filledToday/value; credit supply routes' sales
 * (waiting −, soldToday/soldTotal/revenue +) and ship what they bought (shipRoutes);
 * disable once-orders and exhausted totals.
 */
export function playerAfterClear(s: SimState, books: Books): void {
  void books;
  const sub = rt(s).bag.playerSubmitted as Submitted[] | undefined;
  let routes = false;
  const paidToday: Record<number, number> = {};
  if (sub) {
    for (const { po, ord, route } of sub) {
      const f = ord.filled > 0 ? ord.filled : 0;
      if (route) {
        const r = po.route;
        if (!r) continue;
        if (f > 0) {
          r.waiting = Math.max(0, r.waiting - f);
          if (r.waiting < 1e-9) r.waiting = 0;
          r.soldToday += f;
          r.soldTotal += f;
          r.revenue += Math.max(0, ord.paid);
        }
        continue;
      }
      po.filledToday += f;
      po.filled += f;
      if (f > 0) po.value += po.side === 'buy' ? ord.paid : -ord.paid;
      if (po.route && f > 0) paidToday[po.id] = (paidToday[po.id] || 0) + Math.max(0, ord.paid);
    }
    sub.length = 0;
  }
  for (const o of s.policy.orders) if (o.route) routes = true;
  if (routes) shipRoutes(s, paidToday);
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
  // Freight lines: their purchases join their stores; today's loads leave (policy/lines.ts).
  if (s.policy.lines?.length) linesAfterClear(s);
}

