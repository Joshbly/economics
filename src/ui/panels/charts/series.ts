// ============================================================================
// Series catalogue for the Charts panel (and anyone who needs a readable name
// for a stats key). Maps every documented stats.daily / stats.monthly key to a
// human name, a unit (which picks the formatters) and a category (optgroups of
// the custom chart builder). Unknown keys fall back to the raw key.
//
//   const info = seriesInfo(s, 'gross_8');   // { name: 'Bread — price buyers pay', unit: 'price', … }
//   const fmt = unitFormat(info.unit);       // (v) => '¤4.20'
// ============================================================================
import { DAYS_PER_MONTH } from '../../../sim/config';
import { GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import type { Sector, SimState } from '../../../sim/types';
import { fmtIndex, fmtInt, fmtMoneyShort, fmtNum, fmtPct, fmtPrice, fmtQty, MINUS } from '../../format';
import { fmtTick } from '../../widgets';

export type Unit =
  | 'index' // base 100
  | 'share' // fraction of households etc. → %
  | 'rate' // annual fraction → %/yr
  | 'score' // 0..1 mean (health, contentment) → %
  | 'coef' // 0..1 coefficient (Gini) → 0.00
  | 'money' // ¤ stock
  | 'moneyDay' // ¤ per day
  | 'price' // ¤ per unit
  | 'count' // households, firms, posts
  | 'countDay' // events per day
  | 'qty' // goods units per day
  | 'oz' // gold ounces
  | 'units'; // IOUs

export type Category = 'Prices' | 'Work' | 'Output' | 'Goods' | 'Money & bank' | 'Treasury' | 'People' | 'Trade' | 'Workshops' | 'Other';

export interface SeriesInfo {
  key: string;
  name: string;
  unit: Unit;
  cat: Category;
  /** Only kept monthly (Gini etc.). */
  monthlyOnly?: boolean;
  /** Short plain-language explanation. */
  hint?: string;
}

/** Unit label for chart subtitles. */
export const UNIT_LABEL: Record<Unit, string> = {
  index: 'index, 100 = when you took charge',
  share: '% of households',
  rate: '% per year',
  score: 'average, 0–100%',
  coef: '0 = equal, 1 = one holds all',
  money: '¤',
  moneyDay: '¤ per day',
  price: '¤ per unit',
  count: 'count',
  countDay: 'per day',
  qty: 'units per day',
  oz: 'ounces',
  units: 'IOUs',
};

/** Rates and shares make no sense indexed to 100 (they are already relative). */
export function indexable(unit: Unit): boolean {
  return unit !== 'rate' && unit !== 'share' && unit !== 'score' && unit !== 'coef';
}

/** Value formatter for a unit (tooltips, legends, summaries). */
export function unitFormat(unit: Unit): (v: number) => string {
  switch (unit) {
    case 'index':
      return fmtIndex;
    case 'share':
    case 'score':
      return (v) => fmtPct(v);
    case 'rate':
      return (v) => fmtPct(v, 1);
    case 'coef':
      return (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
    case 'money':
    case 'moneyDay':
      return fmtMoneyShort;
    case 'price':
      return fmtPrice;
    case 'count':
      return (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? fmtInt(v) : fmtNum(v));
    case 'countDay':
      return (v) => fmtNum(v);
    case 'qty':
      return fmtQty;
    case 'oz':
      return (v) => fmtNum(v) + ' oz';
    case 'units':
      return fmtInt;
  }
}

/** Tick label that also reads well on log axes (step 0): "2", "10", "0.5", "1.5k". */
export function tick(v: number, step: number): string {
  if (step > 0) return fmtTick(v, step);
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e4) return fmtTick(v, a / 10);
  const t = a >= 100 ? a.toFixed(0) : a >= 1 ? String(Number(a.toFixed(1))) : String(Number(a.toPrecision(2)));
  return (v < 0 ? MINUS : '') + t;
}

/** Axis tick formatter for a unit. */
export function unitTick(unit: Unit): (v: number, step: number) => string {
  switch (unit) {
    case 'share':
    case 'score':
    case 'rate':
      return (v, step) => tick(v * 100, step * 100) + '%';
    case 'money':
    case 'moneyDay':
    case 'price':
      return (v, step) => {
        const t = tick(v, step);
        return t.startsWith(MINUS) ? MINUS + '¤' + t.slice(1) : '¤' + t;
      };
    default:
      return tick;
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const FIXED: Record<string, [string, Unit, Category, string?]> = {
  // prices
  cpi: ['Consumer prices', 'index', 'Prices', 'What a typical household basket costs (bread, fish, ale, coal, furniture, rent).'],
  infl30: ['Price change, last 30 days (per year)', 'rate', 'Prices'],
  inflYoY: ['Price change, last 12 months', 'rate', 'Prices'],
  rent: ['Average rent per home slot', 'price', 'Prices'],
  deflator: ['Output price level', 'index', 'Prices', 'Output at current prices ÷ output at founding prices × 100.'],
  // output
  gdpReal: ['Output (at founding prices)', 'moneyDay', 'Output', 'Everything made in a day, valued at the prices of the founding year.'],
  gdpNominal: ['Output (at today’s prices)', 'moneyDay', 'Output'],
  cons: ['Household spending on goods', 'moneyDay', 'Output'],
  rentPaid: ['Rent paid', 'moneyDay', 'Output'],
  inv: ['Spending on tools & building', 'moneyDay', 'Output', 'Tools bought by workshops and construction paid for by private owners.'],
  gov: ['Treasury purchases', 'moneyDay', 'Output', 'Goods the Treasury bought (less sold), its workers’ wages and its construction.'],
  netExports: ['Sales abroad less purchases abroad', 'moneyDay', 'Output'],
  // labour
  unemp: ['Households without work', 'share', 'Work'],
  employed: ['Households in work', 'count', 'Work'],
  unemployed: ['Households without work (count)', 'count', 'Work'],
  vacancies: ['Open posts', 'count', 'Work', 'Workers that workshops want but have not found.'],
  wage: ['Average posted wage', 'price', 'Work'],
  realWage: ['Wage in founding prices', 'price', 'Work', 'The average wage divided by the price index: what a day’s pay buys.'],
  wageNet: ['Take-home wage', 'price', 'Work', 'The average wage after any levy the worker pays on it.'],
  wagesPaid: ['Wages paid', 'moneyDay', 'Work'],
  hires: ['Hires', 'countDay', 'Work'],
  fires: ['Layoffs', 'countDay', 'Work'],
  quits: ['Quits', 'countDay', 'Work'],
  // people
  pop: ['Households', 'count', 'People'],
  births: ['Births', 'countDay', 'People'],
  deaths: ['Deaths', 'countDay', 'People'],
  starved: ['Deaths from hunger', 'countDay', 'People'],
  immigrants: ['Arrivals from abroad', 'countDay', 'People'],
  emigrants: ['Departures abroad', 'countDay', 'People'],
  hunger: ['Hungry', 'share', 'People', 'Households that ate too little yesterday.'],
  cold: ['Cold', 'share', 'People', 'Households that could not heat their home enough.'],
  homeless: ['Homeless households', 'count', 'People'],
  homelessRate: ['Homeless', 'share', 'People'],
  evictions: ['Evictions', 'countDay', 'People'],
  health: ['Average health', 'score', 'People'],
  content: ['Average contentment', 'score', 'People'],
  gini: ['Wealth inequality (Gini)', 'coef', 'People', 'Wealth: deposits, IOUs, gold, workshops and houses owned, less debts.'],
  giniIncome: ['Income inequality (Gini)', 'coef', 'People'],
  top10: ['Wealth held by the richest tenth', 'share', 'People'],
  // money & bank
  money: ['Money (all deposits)', 'money', 'Money & bank'],
  reserves: ['Bank reserves at the Treasury', 'money', 'Money & bank'],
  credit: ['Bank loans outstanding', 'money', 'Money & bank'],
  bankEquity: ['Bank equity', 'money', 'Money & bank'],
  capRatio: ['Bank capital ratio', 'share', 'Money & bank', 'Bank equity ÷ loans. Below 8% the bank stops lending.'],
  loanRate: ['Loan rate', 'rate', 'Money & bank'],
  baseRate: ['Bank base rate', 'rate', 'Money & bank'],
  depRate: ['Deposit rate', 'rate', 'Money & bank'],
  windowDebt: ['Bank borrowing at the window', 'money', 'Money & bank'],
  reserveRate: ['Window: rate paid on reserves', 'rate', 'Money & bank'],
  lendRate: ['Window: rate charged to the bank', 'rate', 'Money & bank'],
  writeoffs: ['Loans written off', 'moneyDay', 'Money & bank'],
  defaults: ['Loan defaults', 'countDay', 'Money & bank'],
  loansNew: ['New lending', 'moneyDay', 'Money & bank'],
  interestLoans: ['Interest paid on loans', 'moneyDay', 'Money & bank'],
  interestDeposits: ['Interest paid on deposits', 'moneyDay', 'Money & bank'],
  dividends: ['Dividends paid to owners', 'moneyDay', 'Money & bank'],
  iouPrice: ['IOU price', 'price', 'Money & bank', 'Each IOU pays ¤5 a year, forever.'],
  iouYield: ['IOU yield', 'rate', 'Money & bank', '¤5 a year ÷ the IOU price.'],
  iouOut: ['IOUs held by the public', 'units', 'Money & bank'],
  goldPrice: ['Gold price', 'price', 'Money & bank', '¤ per ounce: the price of foreign money.'],
  treasuryGold: ['Treasury gold', 'oz', 'Treasury'],
  // treasury
  purse: ['The Purse', 'money', 'Treasury'],
  minted: ['Money minted (all time)', 'money', 'Treasury'],
  mintDay: ['Money minted', 'moneyDay', 'Treasury'],
  levyTake: ['Levies taken', 'moneyDay', 'Treasury'],
  levyGive: ['Levies paid out', 'moneyDay', 'Treasury'],
  levyNet: ['Levies, net to the Purse', 'moneyDay', 'Treasury'],
  transferGive: ['Transfers paid', 'moneyDay', 'Treasury'],
  transferTake: ['Transfers taken', 'moneyDay', 'Treasury'],
  treasuryIncome: ['Treasury income', 'moneyDay', 'Treasury'],
  treasurySpend: ['Treasury spending', 'moneyDay', 'Treasury'],
  // trade
  imports: ['Bought abroad', 'moneyDay', 'Trade'],
  exports: ['Sold abroad', 'moneyDay', 'Trade'],
  tradeBal: ['Sold less bought abroad', 'moneyDay', 'Trade'],
  freight: ['Shipping rate', 'price', 'Trade', 'Cost of carrying one unit ten tiles by wagon.'],
  // workshops
  firms: ['Workshops trading', 'count', 'Workshops'],
  bankrupt: ['Workshops closed', 'countDay', 'Workshops'],
  newFirms: ['Workshops opened', 'countDay', 'Workshops'],
  strikes: ['Towns on strike', 'count', 'Workshops'],
};

const PER_GOOD: Record<string, [string, Unit, Category]> = {
  price_: ['price (base)', 'price', 'Prices'],
  gross_: ['price buyers pay', 'price', 'Prices'],
  prod_: ['made', 'qty', 'Goods'],
  cons_: ['bought by households', 'qty', 'Goods'],
  vol_: ['traded in markets', 'qty', 'Goods'],
  shortage_: ['wanted but not found', 'qty', 'Goods'],
  imp_: ['bought abroad', 'qty', 'Trade'],
  exp_: ['sold abroad', 'qty', 'Trade'],
};

const MONTHLY_ONLY = new Set(['gini', 'giniIncome', 'top10']);

/** Plural-ish label for a sector's firms ("Bakeries trading"). */
function sectorLabel(k: string): string {
  const d = SECTORS[k as Sector];
  return d ? d.name : k;
}

/** Human description of any stats key. */
export function seriesInfo(s: SimState | null | undefined, key: string): SeriesInfo {
  const f = FIXED[key];
  if (f) return { key, name: f[0], unit: f[1], cat: f[2], hint: f[3], monthlyOnly: MONTHLY_ONLY.has(key) || undefined };
  const m = /^([a-z]+_)(\d+)$/i.exec(key);
  if (m) {
    const [, prefix, n] = m;
    const idx = Number(n);
    if (prefix === 'cpi_') {
      const town = s?.towns?.[idx]?.name ?? `Town ${idx + 1}`;
      return { key, name: `Consumer prices — ${town}`, unit: 'index', cat: 'Prices' };
    }
    const pg = PER_GOOD[prefix];
    if (pg && idx >= 0 && idx < N_GOODS) return { key, name: `${GOODS[idx].name} — ${pg[0]}`, unit: pg[1], cat: pg[2] };
  }
  if (key.startsWith('firms_')) {
    const k = key.slice(6);
    return { key, name: `${sectorLabel(k)} — number trading`, unit: 'count', cat: 'Workshops' };
  }
  return { key, name: key, unit: 'count', cat: 'Other' };
}

const CAT_ORDER: Category[] = ['Prices', 'Work', 'Output', 'Goods', 'Money & bank', 'Treasury', 'People', 'Trade', 'Workshops', 'Other'];

/** Every chartable key (daily keys + monthly-only keys), sorted by category then name. */
export function allSeries(s: SimState): SeriesInfo[] {
  const keys = new Set<string>(Object.keys(s.stats?.daily ?? {}));
  for (const k of Object.keys(s.stats?.monthly ?? {})) keys.add(k);
  const out = [...keys].map((k) => seriesInfo(s, k));
  // stable, readable order: category, then catalogue order for fixed keys, then name
  const fixedOrder = Object.keys(FIXED);
  out.sort((a, b) => {
    const c = CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat);
    if (c) return c;
    const ia = fixedOrder.indexOf(a.key);
    const ib = fixedOrder.indexOf(b.key);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return out;
}

/** Day index of monthly[k][i]. */
export function monthDay(s: SimState, i: number): number {
  return ((s.stats?.monthlyStart ?? 0) + i) * DAYS_PER_MONTH;
}
