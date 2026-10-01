// ============================================================================
// Preset chart groups for the Charts panel. Each group is 2–4 charts; each
// chart names its stats keys, a unit and how its data is treated (smoothing,
// rolling totals, log scale, reference lines).
// ============================================================================
import { BANK_MIN_CAPITAL } from '../../../sim/config';
import { minCapital } from '../../../sim/agents/bank';
import { G, GOODS } from '../../../sim/goods';
import type { SimState } from '../../../sim/types';
import { goodColor, SERIES, T } from '../../widgets';
import type { Unit } from './series';

export type GroupId = 'prices' | 'work' | 'output' | 'money' | 'treasury' | 'people' | 'trade' | 'custom';

export interface ChartLine {
  key: string;
  label: string;
  color?: string;
  dashed?: boolean;
  area?: boolean;
  width?: number;
  hidden?: boolean;
  /** Per-line unit when it differs from the chart's (tooltip/legend format only). */
  unit?: Unit;
}

export interface ChartDef {
  id: string;
  title: string;
  /** Subtitle override (default: the unit label). */
  sub?: string;
  unit: Unit;
  lines: (s: SimState) => ChartLine[];
  /** Daily view: trailing mean over N days (noisy daily flows). */
  smooth?: number;
  /** Daily view: rolling total over N days (event counts). Monthly values are month totals already. */
  total?: number;
  /** Log scale (when not indexed). */
  log?: boolean;
  zero?: boolean;
  /** A reference line (or one that depends on the realm's state, e.g. the capital rule in force). */
  ref?: { y: number; label?: string } | ((s: SimState) => { y: number; label?: string });
  /** Plain-language note under the chart. */
  note?: string;
  height?: number;
  /** Also match these top-bar indicators when focusing. */
  focus?: string[];
}

export interface GroupDef {
  id: GroupId;
  label: string;
  blurb: string;
  charts: ChartDef[];
}

const good = (g: number, prefix: string, extra: Partial<ChartLine> = {}): ChartLine => ({ key: prefix + g, label: GOODS[g].name, color: goodColor(g), ...extra });

export const GROUPS: GroupDef[] = [
  {
    id: 'prices',
    label: 'Prices',
    blurb: 'What things cost, and how fast that is changing.',
    charts: [
      {
        id: 'cpi',
        title: 'Consumer prices',
        unit: 'index',
        ref: { y: 100, label: '100' },
        focus: ['prices'],
        lines: (s) => [
          { key: 'cpi', label: 'Realm', color: T.ink0, width: 2.4 },
          ...(s.towns ?? []).map((t, i) => ({ key: 'cpi_' + t.id, label: t.name, color: SERIES[i % SERIES.length], width: 1.4 })),
        ],
        note: 'The cost of a typical household’s bread, fish, ale, coal, furniture and rent.',
      },
      {
        id: 'infl',
        title: 'How fast prices are rising',
        unit: 'rate',
        ref: { y: 0 },
        lines: () => [
          { key: 'infl30', label: 'Last 30 days, per year', color: SERIES[1] },
          { key: 'inflYoY', label: 'Last 12 months', color: SERIES[0] },
        ],
      },
      {
        id: 'household',
        title: 'What households pay',
        sub: '¤ per unit, incl. levies · log scale',
        unit: 'price',
        log: true,
        lines: () => [
          good(G.bread, 'gross_'),
          good(G.fish, 'gross_'),
          good(G.ale, 'gross_'),
          good(G.coal, 'gross_'),
          good(G.furniture, 'gross_'),
          { key: 'rent', label: 'Rent / day', color: T.ink1, dashed: true },
        ],
      },
      {
        id: 'materials',
        title: 'Materials and tools',
        sub: '¤ per unit buyers pay · log scale',
        unit: 'price',
        log: true,
        lines: () => [good(G.grain, 'gross_'), good(G.wood, 'gross_'), good(G.oil, 'gross_'), good(G.ore, 'gross_'), good(G.iron, 'gross_'), good(G.tools, 'gross_')],
      },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    blurb: 'Jobs, the jobless, and what a day’s work pays.',
    charts: [
      {
        id: 'unemp',
        title: 'Households without work',
        unit: 'share',
        zero: true,
        focus: ['jobless'],
        lines: () => [{ key: 'unemp', label: 'Jobless', color: SERIES[1], area: true }],
        note: 'Every household has one worker; this is the share who have none.',
      },
      {
        id: 'posts',
        title: 'The jobless and the open posts',
        unit: 'count',
        zero: true,
        lines: () => [
          { key: 'unemployed', label: 'Without work', color: SERIES[1] },
          { key: 'vacancies', label: 'Open posts', color: SERIES[2] },
        ],
        note: 'Open posts are workers that workshops are trying to hire but have not found.',
      },
      {
        id: 'wages',
        title: 'Wages',
        unit: 'price',
        sub: '¤ per day',
        lines: () => [
          { key: 'wage', label: 'Posted', color: SERIES[0] },
          { key: 'wageNet', label: 'Take-home', color: SERIES[0], dashed: true },
          { key: 'realWage', label: 'In founding prices', color: SERIES[3] },
        ],
        note: '“In founding prices” divides the wage by the price index — what a day’s pay buys.',
      },
      {
        id: 'turnover',
        title: 'Hiring and layoffs',
        unit: 'countDay',
        sub: 'per 30 days',
        total: 30,
        zero: true,
        lines: () => [
          { key: 'hires', label: 'Hires', color: SERIES[2] },
          { key: 'fires', label: 'Layoffs', color: SERIES[7] },
          { key: 'quits', label: 'Quits', color: SERIES[6] },
        ],
      },
    ],
  },
  {
    id: 'output',
    label: 'Output',
    blurb: 'What the realm makes, and who spends on it.',
    charts: [
      {
        id: 'gdp',
        title: 'Output',
        unit: 'moneyDay',
        sub: '¤ per day · 7-day average',
        smooth: 7,
        focus: ['output'],
        lines: () => [
          { key: 'gdpReal', label: 'At founding prices', color: SERIES[0], area: true },
          { key: 'gdpNominal', label: 'At today’s prices', color: SERIES[3] },
        ],
        note: '“At founding prices” strips out price changes: it moves only when more or less is made.',
      },
      {
        id: 'spend',
        title: 'Who spends',
        unit: 'moneyDay',
        sub: '¤ per day · 30-day average',
        smooth: 30,
        ref: { y: 0 },
        lines: () => [
          { key: 'cons', label: 'Households', color: SERIES[0] },
          { key: 'inv', label: 'Tools & building', color: SERIES[2] },
          { key: 'gov', label: 'Treasury', color: SERIES[3] },
          { key: 'netExports', label: 'Abroad, net', color: SERIES[6] },
        ],
      },
      {
        id: 'food',
        title: 'Food and drink made',
        unit: 'qty',
        sub: 'units per day · 7-day average',
        smooth: 7,
        zero: true,
        lines: () => [good(G.grain, 'prod_'), good(G.bread, 'prod_'), good(G.fish, 'prod_'), good(G.ale, 'prod_')],
      },
      {
        id: 'made',
        title: 'Materials and wares made',
        unit: 'qty',
        sub: 'units per day · 7-day average · log scale',
        smooth: 7,
        log: true,
        lines: () => [good(G.wood, 'prod_'), good(G.coal, 'prod_'), good(G.oil, 'prod_'), good(G.ore, 'prod_'), good(G.iron, 'prod_'), good(G.tools, 'prod_'), good(G.furniture, 'prod_')],
      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    blurb: 'Deposits, loans, the price of money and of gold.',
    charts: [
      {
        id: 'stock',
        title: 'Money and credit',
        unit: 'money',
        zero: true,
        focus: ['money'],
        lines: () => [
          { key: 'money', label: 'Deposits', color: SERIES[0], area: true },
          { key: 'credit', label: 'Bank loans', color: SERIES[1] },
          { key: 'reserves', label: 'Reserves', color: SERIES[2] },
        ],
        note: 'Deposits are the realm’s money. Bank loans create deposits; repayments destroy them.',
      },
      {
        id: 'rates',
        title: 'Interest rates',
        unit: 'rate',
        zero: true,
        lines: () => [
          { key: 'loanRate', label: 'Loans', color: SERIES[1] },
          { key: 'depRate', label: 'Deposits', color: SERIES[0] },
          { key: 'iouYield', label: 'IOU yield', color: SERIES[2] },
          { key: 'reserveRate', label: 'Window: paid', color: SERIES[3], dashed: true },
          { key: 'lendRate', label: 'Window: charged', color: SERIES[4], dashed: true },
        ],
        note: 'Dashed lines are the two Window rates you set.',
      },
      {
        id: 'assets',
        title: 'IOUs and gold',
        unit: 'price',
        focus: ['gold'],
        lines: () => [
          { key: 'goldPrice', label: 'Gold, per oz', color: SERIES[3] },
          { key: 'iouPrice', label: 'IOU', color: SERIES[2] },
        ],
        note: 'Each IOU pays ¤5 a year, forever. Gold is what foreign merchants accept.',
      },
      {
        id: 'bank',
        title: 'The bank’s cushion',
        sub: 'equity ÷ loans',
        unit: 'share',
        zero: true,
        ref: (s) => {
          let y = BANK_MIN_CAPITAL;
          try {
            y = minCapital(s);
          } catch {
            /* the standing rule */
          }
          return { y, label: `${Math.round(y * 1000) / 10}% floor` };
        },
        lines: () => [{ key: 'capRatio', label: 'Capital ratio', color: SERIES[0], area: true }],
        note: 'Below the floor in force (the standing rule, or a Limit in its place) the bank stops lending.',
      },
    ],
  },
  {
    id: 'treasury',
    label: 'Treasury',
    blurb: 'Your Purse, what you mint, take and pay out.',
    charts: [
      {
        id: 'purse',
        title: 'The Purse',
        unit: 'money',
        ref: { y: 0 },
        focus: ['purse'],
        lines: () => [
          { key: 'purse', label: 'Purse', color: T.gold, area: true },
          { key: 'minted', label: 'Minted, all time', color: SERIES[6], dashed: true },
        ],
      },
      {
        id: 'levies',
        title: 'Levies',
        unit: 'moneyDay',
        sub: '¤ per day · 30-day average',
        smooth: 30,
        ref: { y: 0 },
        lines: () => [
          { key: 'levyTake', label: 'Taken', color: SERIES[2] },
          { key: 'levyGive', label: 'Paid out', color: SERIES[1] },
          { key: 'levyNet', label: 'Net', color: T.ink0, dashed: true },
        ],
      },
      {
        id: 'flows',
        title: 'Treasury income and spending',
        unit: 'moneyDay',
        sub: '¤ per day · 30-day average',
        smooth: 30,
        zero: true,
        lines: () => [
          { key: 'treasuryIncome', label: 'Income', color: SERIES[2] },
          { key: 'treasurySpend', label: 'Spending', color: SERIES[1] },
        ],
        note: 'All money flowing into and out of the Purse: levies, trades, wages of Treasury workers, building, interest.',
      },
      {
        id: 'ious',
        title: 'IOUs held by the public',
        unit: 'units',
        zero: true,
        lines: () => [{ key: 'iouOut', label: 'IOUs', color: SERIES[2], area: true }],
        note: 'Selling IOUs in the IOU market issues new ones; buying them back retires them.',
      },
    ],
  },
  {
    id: 'people',
    label: 'People',
    blurb: 'How many, how they fare, how evenly wealth is spread.',
    charts: [
      {
        id: 'pop',
        title: 'Households',
        unit: 'count',
        focus: ['people'],
        lines: () => [{ key: 'pop', label: 'Households', color: SERIES[0], area: true }],
      },
      {
        id: 'moves',
        title: 'Comings and goings',
        unit: 'countDay',
        sub: 'per 30 days',
        total: 30,
        zero: true,
        lines: () => [
          { key: 'births', label: 'Births', color: SERIES[2] },
          { key: 'deaths', label: 'Deaths', color: SERIES[7] },
          { key: 'immigrants', label: 'Arrivals', color: SERIES[0] },
          { key: 'emigrants', label: 'Departures', color: SERIES[1] },
        ],
      },
      {
        id: 'hardship',
        title: 'Hardship and wellbeing',
        unit: 'share',
        sub: '% of households · averages',
        zero: true,
        lines: () => [
          { key: 'hunger', label: 'Hungry', color: SERIES[1] },
          { key: 'cold', label: 'Cold', color: SERIES[0] },
          { key: 'homelessRate', label: 'Homeless', color: SERIES[4] },
          { key: 'health', label: 'Health', color: SERIES[2], dashed: true, unit: 'score' },
          { key: 'content', label: 'Contentment', color: SERIES[3], dashed: true, unit: 'score' },
        ],
        note: 'Solid lines are shares of households; dashed lines are averages (100% = perfectly well).',
      },
      {
        id: 'ineq',
        title: 'Inequality',
        unit: 'coef',
        sub: 'monthly',
        zero: true,
        lines: () => [
          { key: 'gini', label: 'Wealth (Gini)', color: SERIES[6] },
          { key: 'giniIncome', label: 'Income (Gini)', color: SERIES[0] },
          { key: 'top10', label: 'Richest tenth’s share', color: SERIES[3], dashed: true, unit: 'share' },
        ],
        note: 'A Gini of 0 means everyone has the same; 1 means one household has everything.',
      },
    ],
  },
  {
    id: 'trade',
    label: 'Trade',
    blurb: 'The port, the border and the roads between towns.',
    charts: [
      {
        id: 'port',
        title: 'Trade through the port',
        unit: 'moneyDay',
        sub: '¤ per day · 30-day average',
        smooth: 30,
        zero: true,
        lines: () => [
          { key: 'imports', label: 'Bought abroad', color: SERIES[1] },
          { key: 'exports', label: 'Sold abroad', color: SERIES[2] },
        ],
      },
      {
        id: 'balance',
        title: 'Sold less bought abroad',
        unit: 'moneyDay',
        sub: '¤ per day · 30-day average',
        smooth: 30,
        ref: { y: 0 },
        lines: () => [{ key: 'tradeBal', label: 'Balance', color: SERIES[0], area: true }],
        note: 'Below zero, more coin leaves through the port than comes in.',
      },
      {
        id: 'freight',
        title: 'Shipping rate',
        sub: '¤ to carry one unit ten tiles',
        unit: 'price',
        lines: () => [{ key: 'freight', label: 'Shipping rate', color: SERIES[3], area: true }],
        note: 'Driver wages, oil for the wagons and wear. Paved roads and cheap oil lower it.',
      },
      {
        id: 'goldx',
        title: 'Gold price',
        sub: '¤ per ounce — the price of foreign money',
        unit: 'price',
        lines: () => [{ key: 'goldPrice', label: 'Gold', color: SERIES[3], area: true }],
      },
    ],
  },
];

export const GROUP_LABELS: { id: GroupId; label: string }[] = [...GROUPS.map((g) => ({ id: g.id, label: g.label })), { id: 'custom', label: 'Build your own' }];

/** Top-bar indicator (aria-label / title) → group and chart to focus. */
export const INDICATOR_FOCUS: Record<string, { group: GroupId; chart: string }> = {
  prices: { group: 'prices', chart: 'cpi' },
  jobless: { group: 'work', chart: 'unemp' },
  output: { group: 'output', chart: 'gdp' },
  money: { group: 'money', chart: 'stock' },
  'the purse': { group: 'treasury', chart: 'purse' },
  purse: { group: 'treasury', chart: 'purse' },
  'gold price': { group: 'money', chart: 'assets' },
  gold: { group: 'money', chart: 'assets' },
  households: { group: 'people', chart: 'pop' },
  people: { group: 'people', chart: 'pop' },
};
