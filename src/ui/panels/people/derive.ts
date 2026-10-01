// ============================================================================
// Per-day derived figures for the People panel (computed once per sim day).
// ============================================================================
import { HUNGRY_BELOW } from '../../../sim/config';
import { ALL_SECTORS, SECTORS } from '../../../sim/goods';
import type { Person, Sector, SimState } from '../../../sim/types';
import { assetPrices, debtMap, fin, wealthOf, type Wealth } from '../inspector/common';

export interface PersonRow {
  id: number;
  name: string;
  town: number;
  townName: string;
  job: number;
  sector: Sector | '';
  work: string;
  firmName: string;
  wage: number;
  cash: number;
  savings: number;
  net: number;
  health: number;
  /** 'rents' | 'owns' | 'none' */
  home: 'rents' | 'owns' | 'none';
  hungry: boolean;
  jobless: boolean;
  unempDays: number;
  search: string;
}

export interface TownDerived {
  id: number;
  pop: number;
  hungry: number;
  jobless: number;
  homeless: number;
}

export interface SectorRow {
  sector: Sector;
  workers: number;
  firms: number;
}

export interface Derived {
  day: number;
  count: number;
  rows: PersonRow[];
  savings: number[];
  net: number[];
  income: number[];
  health: number[];
  towns: TownDerived[];
  sectors: SectorRow[];
  jobless: number;
  /** Living on their means (out of the labour force). */
  ofMeans: number;
  hungry: number;
  weak: number;
  unhappy: number;
  top: { p: Person; w: Wealth }[];
  medianSavings: number;
  meanSavings: number;
  medianNet: number;
}

export function median(xs: number[]): number {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = Math.max(0, Math.min(a.length - 1, Math.floor(q * (a.length - 1))));
  return a[i];
}

export function derive(s: SimState): Derived {
  const debts = debtMap(s);
  const px = assetPrices(s);
  const rows: PersonRow[] = [];
  const savings: number[] = [];
  const net: number[] = [];
  const income: number[] = [];
  const health: number[] = [];
  const towns: TownDerived[] = (s.towns ?? []).map((t) => ({ id: t.id, pop: 0, hungry: 0, jobless: 0, homeless: 0 }));
  const wealthy: { p: Person; w: Wealth }[] = [];
  let jobless = 0;
  let ofMeans = 0;
  let hungryN = 0;
  let weak = 0;
  let unhappy = 0;

  for (const p of s.people ?? []) {
    if (!p || !p.alive) continue;
    const w = wealthOf(s, p, debts, px);
    const f = p.job >= 0 ? s.firms[p.job] : undefined;
    const hasJob = !!f && p.job >= 0;
    const hungry = fin(p.foodSat, 1) < HUNGRY_BELOW;
    const hb = p.home >= 0 ? s.buildings[p.home] : undefined;
    const home: PersonRow['home'] = !hb ? 'none' : hb.owner === p.id ? 'owns' : 'rents';
    const townName = s.towns[p.town]?.name ?? '';
    const sectorLabel = hasJob ? (SECTORS[f!.sector]?.name ?? f!.sector) : '';
    const means = !hasJob && !!p.means;
    const work = hasJob ? sectorLabel : means ? 'Of independent means' : 'Looking for work';
    rows.push({
      id: p.id,
      name: p.name,
      town: p.town,
      townName,
      job: hasJob ? p.job : -1,
      sector: hasJob ? f!.sector : '',
      work,
      firmName: hasJob ? f!.name : '',
      wage: hasJob ? fin(p.wage) : NaN,
      cash: fin(p.cash),
      savings: w.savings,
      net: w.net,
      health: fin(p.health),
      home,
      hungry,
      jobless: !hasJob && !means,
      unempDays: fin(p.unempDays),
      search: (p.name + ' ' + townName + ' ' + work + ' ' + (hasJob ? f!.name : '')).toLowerCase(),
    });
    savings.push(w.savings);
    net.push(w.net);
    income.push(fin(p.income));
    health.push(fin(p.health));
    wealthy.push({ p, w });
    if (!hasJob && !means) jobless++;
    if (means) ofMeans++;
    if (hungry) hungryN++;
    if (fin(p.health) < 0.4) weak++;
    if (fin(p.contentment, 1) < 0.3) unhappy++;
    const td = towns[p.town];
    if (td) {
      td.pop++;
      if (hungry) td.hungry++;
      if (!hasJob && !means) td.jobless++;
      if (!hb) td.homeless++;
    }
  }

  const bySector = new Map<Sector, SectorRow>();
  for (const f of s.firms ?? []) {
    if (!f || !f.alive || f.status === 'closed') continue;
    let r = bySector.get(f.sector);
    if (!r) bySector.set(f.sector, (r = { sector: f.sector, workers: 0, firms: 0 }));
    r.workers += f.workers?.length ?? 0;
    if (f.sector !== 'stateworks') r.firms++;
  }
  const sectors = ALL_SECTORS.map((k) => bySector.get(k)).filter((r): r is SectorRow => !!r && (r.workers > 0 || r.firms > 0));

  wealthy.sort((a, b) => b.w.net - a.w.net);
  const meanSavings = savings.length ? savings.reduce((a, b) => a + b, 0) / savings.length : NaN;
  return {
    day: s.day,
    count: rows.length,
    rows,
    savings,
    net,
    income,
    health,
    towns,
    sectors,
    jobless,
    ofMeans,
    hungry: hungryN,
    weak,
    unhappy,
    top: wealthy.slice(0, 8),
    medianSavings: median(savings),
    meanSavings,
    medianNet: median(net),
  };
}
