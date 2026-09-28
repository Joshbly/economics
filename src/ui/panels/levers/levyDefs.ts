// ============================================================================
// Levers panel — the levy vocabulary: which units, payers and filters make
// sense for each flow (mirrors the validation tables in sim/policy/player.ts
// and the semantics in sim/policy/levies.ts), with neutral in-sentence words.
// ============================================================================
import type { Group, LevyBase, LevyPayer, LevyUnit } from '../../../sim/types';
import { unitOf } from './common';

export interface BaseDef {
  base: LevyBase;
  /** Word after "on" in the composer sentence. */
  label: string;
  /** Group heading in the flow picker. */
  family: 'Trade' | 'Work & income' | 'Holdings' | 'Movement';
  units: LevyUnit[];
  payers: LevyPayer[];
  good: boolean;
  town: boolean;
  toTown: boolean;
  sector: boolean;
  group: boolean;
  kind: boolean;
  /** Thresholds mean something here (sale & port levies are market-wide wedges). */
  threshold: boolean;
  /** Percentage rates are per YEAR (stock bases). */
  stock: boolean;
  /** One-line mechanical explanation. */
  explain: string;
}

const B = (
  base: LevyBase,
  label: string,
  family: BaseDef['family'],
  units: LevyUnit[],
  payers: LevyPayer[],
  f: Partial<Pick<BaseDef, 'good' | 'town' | 'toTown' | 'sector' | 'group' | 'kind' | 'threshold' | 'stock'>>,
  explain: string,
): BaseDef => ({ base, label, family, units, payers, good: false, town: false, toTown: false, sector: false, group: false, kind: false, threshold: true, stock: false, ...f, explain });

export const BASES: BaseDef[] = [
  B('sale', 'sales', 'Trade', ['pct', 'perUnit'], ['buyer', 'seller'], { good: true, town: true, threshold: false }, 'Charged on every trade in the market, as a wedge between what buyers pay and what sellers receive. Treasury orders are exempt.'),
  B('import', 'imports', 'Trade', ['pct', 'perUnit'], ['buyer'], { good: true, threshold: false }, 'Charged on goods foreign ships sell at the port, paid by whoever buys them.'),
  B('export', 'exports', 'Trade', ['pct', 'perUnit'], ['seller'], { good: true, threshold: false }, 'Charged on goods sold to foreign ships at the port, paid by the seller.'),
  B('wage', 'wages', 'Work & income', ['pct', 'perUnit'], ['worker', 'employer'], { town: true, sector: true, group: true }, 'Charged on each day’s wage as it is paid — out of the worker’s pay, or on top of the employer’s bill.'),
  B('profit', 'profits', 'Work & income', ['pct'], ['owner'], { town: true, sector: true }, 'Charged at month end on each firm’s positive profit for the month.'),
  B('rent', 'rents', 'Work & income', ['pct', 'perUnit'], ['tenant', 'landlord'], { town: true, group: true }, 'Charged on each day’s rent — on top for the tenant, or out of what the landlord receives.'),
  B('interest', 'interest earned', 'Work & income', ['pct'], ['receiver'], { town: true, group: true }, 'Charged on interest paid to savers on deposits and on IOU payments.'),
  B('estate', 'estates', 'Work & income', ['pct', 'flat'], ['receiver'], { town: true, group: true }, 'Charged on what people leave behind when they die, before heirs receive it.'),
  B('head', 'each person', 'Holdings', ['flat'], ['receiver'], { town: true, group: true }, 'A fixed sum each day from (or to) every person in the group.'),
  B('money', 'money held', 'Holdings', ['pct', 'flat'], ['holder'], { town: true, sector: true, group: true, stock: true }, 'Charged daily on bank balances. A percentage is per year (a 360th each day).'),
  B('goods', 'goods in store', 'Holdings', ['perUnit', 'pct', 'flat'], ['holder'], { good: true, town: true, sector: true, group: true, stock: true }, 'Charged daily on inventories held by firms, traders and households (not the Treasury’s own).'),
  B('building', 'buildings', 'Holdings', ['flat', 'pct'], ['owner'], { town: true, sector: true, kind: true, stock: true }, 'Charged daily to the owner (or the firm using it) of every matching building. A percentage is per year of its book value.'),
  B('shipment', 'shipments', 'Movement', ['perUnit', 'pct'], ['owner'], { good: true, town: true, toTown: true }, 'Charged on goods carried by wagon between towns, paid by the shipper.'),
];

export function baseDef(b: LevyBase): BaseDef {
  return BASES.find((x) => x.base === b) ?? BASES[0];
}

/** In-sentence unit label for a base: "% of value", "per loaf"… (the ¤ sits on the rate field). */
export function unitLabel(base: LevyBase, unit: LevyUnit, good: number): string {
  return unitLabelRaw(base, unit, good).replace(/^¤ /, '');
}

function unitLabelRaw(base: LevyBase, unit: LevyUnit, good: number): string {
  const u = good >= 0 ? unitOf(good) : 'unit';
  switch (base) {
    case 'sale':
    case 'import':
    case 'export':
    case 'shipment':
      return unit === 'pct' ? '% of value' : `¤ per ${u}`;
    case 'wage':
      return unit === 'pct' ? '% of each wage' : '¤ per worker-day';
    case 'profit':
      return '% of profit';
    case 'rent':
      return unit === 'pct' ? '% of rent' : '¤ per home a day';
    case 'interest':
      return '% of interest';
    case 'estate':
      return unit === 'pct' ? '% of the estate' : '¤ per estate';
    case 'head':
      return '¤ a day';
    case 'money':
      return unit === 'pct' ? '% a year' : '¤ a day each';
    case 'goods':
      return unit === 'perUnit' ? `¤ per ${u} a day` : unit === 'pct' ? '% of value a year' : '¤ a day per good held';
    case 'building':
      return unit === 'pct' ? '% of value a year' : '¤ a day each';
    default:
      return unit === 'pct' ? '%' : '¤';
  }
}

export const PAYER_WORD: Record<LevyPayer, string> = {
  buyer: 'buyers',
  seller: 'sellers',
  worker: 'workers',
  employer: 'employers',
  tenant: 'tenants',
  landlord: 'landlords',
  holder: 'holders',
  owner: 'owners',
  receiver: 'recipients',
};

export const GROUP_OPTIONS: { value: Group; label: string }[] = [
  { value: 'all', label: 'everyone' },
  { value: 'employed', label: 'people in work' },
  { value: 'unemployed', label: 'people without work' },
  { value: 'homeless', label: 'people without a home' },
  { value: 'owners', label: 'property owners' },
  { value: 'nonowners', label: 'people owning no property' },
  { value: 'hungry', label: 'hungry people' },
];

/** Groups valid for a base (firms only where firms hold the base). */
export function groupsFor(base: LevyBase): { value: Group; label: string }[] {
  if (base === 'money' || base === 'goods') return [...GROUP_OPTIONS, { value: 'firms', label: 'firms only' }];
  if (base === 'wage') return GROUP_OPTIONS.filter((g) => g.value !== 'unemployed');
  return GROUP_OPTIONS;
}

/** What a threshold means for this base/unit, as a field label + hint. */
export function thresholdMeaning(base: LevyBase, unit: LevyUnit): { label: string; hint: string; qty: boolean } {
  if (base === 'goods' && unit !== 'pct') return { label: 'Exempt first', hint: 'Only units held beyond this many are charged.', qty: true };
  if (base === 'head') return { label: 'Only if they hold', hint: 'Applies only to people whose savings exceed this.', qty: false };
  if (unit === 'pct')
    return {
      label: 'Exempt first',
      hint:
        base === 'money'
          ? 'Only the part of each balance above this is charged.'
          : base === 'wage'
            ? 'Only the part of each day’s wage above this is charged.'
            : base === 'profit'
              ? 'Only the part of each firm’s monthly profit above this is charged.'
              : 'Only the part above this amount is charged.',
      qty: false,
    };
  return { label: 'Only above', hint: 'Applies only when the amount involved exceeds this.', qty: false };
}
