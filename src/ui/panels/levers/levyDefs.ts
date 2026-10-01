// ============================================================================
// Levers panel — the levy vocabulary: which units, payers and filters make
// sense for each flow (mirrors the validation tables in sim/policy/player.ts
// and the semantics in sim/policy/levies.ts), with neutral in-sentence words.
// ============================================================================
import { SECTORS } from '../../../sim/goods';
import type { Group, LevyBase, LevyPayer, LevyUnit, Sector } from '../../../sim/types';
import type { Option } from '../../widgets';
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
  // sector / group: who a sale levy applies to (see saleWho* below); market-wide by default.
  B('sale', 'sales', 'Trade', ['pct', 'perUnit'], ['buyer', 'seller'], { good: true, town: true, sector: true, group: true, threshold: false }, 'Charged on every trade in the market, as a wedge between what buyers pay and what sellers receive. Treasury orders are exempt.'),
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
  B('land', 'land held unbuilt', 'Holdings', ['pct', 'flat'], ['holder'], { town: true, group: true, stock: true }, 'Charged daily to whoever holds a plot of town land without building on it (bought from the council to sell dearer later). A percentage is per year of what the plot would cost today; a sum is per plot a day.'),
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
    case 'land':
      return unit === 'pct' ? '% of value a year' : '¤ a day per plot';
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

// ---------------------------------------------------------------------------
// Who a sale levy applies to. Encoded in the levy's own filters:
//   everyone              group 'all',     sector 'any'   (a market-wide wedge)
//   workshops (any trade) group 'firms',   sector 'any'
//   workshops of a trade  group 'firms',   sector <trade>
//   households            group 'persons', sector 'any'
//   households in a group group <group>,   sector 'any'
// Sellers are always workshops (households do not sell goods in the markets).
// ---------------------------------------------------------------------------
export type SaleWho = string; // 'all' | 'f:any' | 'f:<sector>' | 'p:<group>'

const WHO_SECTORS = (Object.keys(SECTORS) as Sector[]).filter((k) => k !== 'stateworks');

/** Plural noun for a trade's workshops: "bakeries", "farms", "trading houses". */
export function tradePlural(sec: Sector): string {
  const n = (SECTORS[sec]?.name ?? sec).toLowerCase();
  if (n.endsWith('y')) return n.slice(0, -1) + 'ies';
  if (n.endsWith('s')) return n; // "toolworks"
  if (n.endsWith('sh') || n.endsWith('ch')) return n + 'es';
  return n + 's';
}

const HOUSEHOLD_GROUPS: { value: Group; label: string }[] = [
  { value: 'persons', label: 'Any household' },
  { value: 'employed', label: 'Households in work' },
  { value: 'unemployed', label: 'Households without work' },
  { value: 'homeless', label: 'Households without a home' },
  { value: 'owners', label: 'Property owners' },
  { value: 'nonowners', label: 'Households owning no property' },
  { value: 'hungry', label: 'Hungry households' },
];

/** Options for "applies to" (buyers: workshops or households; sellers: workshops). */
export function saleWhoOptions(payer: LevyPayer): Option<SaleWho>[] {
  const buyer = payer !== 'seller';
  const out: Option<SaleWho>[] = [{ value: 'all', label: buyer ? 'Every buyer' : 'Every seller' }];
  out.push({ value: 'f:any', label: 'Any workshop', group: 'Workshops' });
  for (const k of WHO_SECTORS) {
    if (!buyer && !SECTORS[k].producer && k !== 'trader') continue;
    out.push({ value: 'f:' + k, label: SECTORS[k].name, group: 'Workshops' });
  }
  if (buyer) for (const g of HOUSEHOLD_GROUPS) out.push({ value: 'p:' + g.value, label: g.label, group: 'Households' });
  return out;
}

/** The "applies to" choice a levy's filters encode. */
export function saleWhoOf(group: Group, sector: Sector | 'any'): SaleWho {
  if (sector && sector !== 'any') return 'f:' + sector;
  if (group === 'firms') return 'f:any';
  if (group && group !== 'all') return 'p:' + group;
  return 'all';
}

/** The filters for an "applies to" choice. */
export function saleWhoFilters(who: SaleWho, payer: LevyPayer): { group: Group; sector: Sector | 'any' } {
  if (who.startsWith('f:')) {
    const k = who.slice(2);
    return { group: 'firms', sector: k === 'any' ? 'any' : (k as Sector) };
  }
  if (who.startsWith('p:') && payer !== 'seller') return { group: who.slice(2) as Group, sector: 'any' };
  return { group: 'all', sector: 'any' };
}

/** Is this sale levy aimed at some traders only (not a market-wide wedge)? */
export function saleTargeted(group: Group, sector: Sector | 'any'): boolean {
  return (!!group && group !== 'all') || (!!sector && sector !== 'any');
}

/** Words for who pays / receives: "bakeries", "households in work", "workshops". */
export function saleWhoWords(who: SaleWho): string {
  if (who === 'all') return '';
  if (who === 'f:any') return 'workshops';
  if (who.startsWith('f:')) return tradePlural(who.slice(2) as Sector);
  const g = who.slice(2);
  const opt = HOUSEHOLD_GROUPS.find((x) => x.value === g);
  return g === 'persons' ? 'households' : (opt?.label ?? 'households').toLowerCase();
}
