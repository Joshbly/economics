// Stats, events and save/load on tiny synthetic states (record factories only —
// no world generation, no firm/bank/trader behaviour).
import { describe, expect, it } from 'vitest';
import { DAYS_PER_MONTH, STATS_DAILY_CAP, STRIKE_DAYS, UNREST_CONTENT, UNREST_DAYS } from '../src/sim/config';
import { steadyStateDemand } from '../src/sim/agents/demandModel';
import { closeFirm } from '../src/sim/agents/firms';
import { newBuilding, newFirm, newLoan, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { CONSUMER_GOODS, G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { deserialize, serialize, validateSave } from '../src/sim/save';
import { beginDayEvents, eventsStep, monthlyChange, news } from '../src/sim/stats/events';
import {
  annualise,
  beginDayStats,
  distributionStats,
  inflationRate,
  initStats,
  monthMode,
  rebaseStats,
  roundSig,
  series,
  statsStep,
  topShare,
  unitValueAdded,
} from '../src/sim/stats/stats';
import type { Firm, MapData, Person, SimState } from '../src/sim/types';
import { FIRM_BASE } from '../src/sim/types';

const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];

function tinyMap(w = 30, h = 20): MapData {
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

interface World {
  s: SimState;
  people: Person[];
  firms: Firm[];
}

/**
 * Two towns: town 0 has 6 people (4 employed at a bakery paying 10, 1 homeless),
 * town 1 has 2 people (1 employed at a farm paying 12). One 4-slot house in each
 * town (rent 1.5 and 2.5). Person 0 owns the bakery and the town-0 house (lives in it).
 */
function world(): World {
  const s = newSimState(3, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 5, 5, 4));
  s.towns.push(newTown(1, 'Millbrook', 'farm', 20, 10, 4));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, PRICES[g]));
  const people: Person[] = [];
  for (let i = 0; i < 8; i++) {
    const p = newPerson(s, i < 6 ? 0 : 1, 'P' + i);
    p.cash = 100 + 10 * i;
    p.income = 9 + i * 0.5;
    people.push(p);
  }
  const h0 = newBuilding(s, 'house', '', 0, 1, 1, 1, 1, 'active');
  h0.slots = 4;
  h0.rent = 1.5;
  h0.owner = people[0].id;
  h0.cost = 1000;
  const h1 = newBuilding(s, 'house', '', 1, 20, 12, 1, 1, 'active');
  h1.slots = 4;
  h1.rent = 2.5;
  h1.owner = people[1].id;
  h1.cost = 1200;
  people[0].houses.push(h0.id);
  people[1].houses.push(h1.id);
  // town 0: persons 0..4 housed in h0 (4 slots: 0..3), person 4 & 5 homeless
  for (const i of [0, 1, 2, 3]) {
    people[i].home = h0.id;
    h0.residents.push(people[i].id);
  }
  for (const i of [6, 7]) {
    people[i].home = h1.id;
    h1.residents.push(people[i].id);
  }
  const bb = newBuilding(s, 'firm', 'bakery', 0, 3, 3, 1, 1, 'active');
  bb.cost = 500;
  const bakery = newFirm(s, 'bakery', 0, bb.id, people[0].id, 'Bakery');
  bb.firm = bakery.id;
  bakery.wage = 10;
  bakery.target = 6;
  bakery.capacity = 8;
  bakery.cash = 300;
  bakery.tools = 2;
  bakery.inv[G.bread] = 10;
  people[0].owns.push(bakery.id);
  const fb = newBuilding(s, 'firm', 'farm', 1, 22, 12, 1, 1, 'active');
  const farm = newFirm(s, 'farm', 1, fb.id, people[1].id, 'Farm');
  fb.firm = farm.id;
  farm.wage = 12;
  farm.target = 1;
  farm.capacity = 4;
  people[1].owns.push(farm.id);
  for (const i of [1, 2, 3, 4]) {
    people[i].job = bakery.id;
    bakery.workers.push(people[i].id);
  }
  people[6].job = farm.id;
  farm.workers.push(people[6].id);
  s.bank.reserves = 5000;
  reconcileBank(s);
  return { s, people, firms: [bakery, farm] };
}

/** Advance a synthetic day for stats only (no agents). */
function statDay(s: SimState): void {
  beginDayStats(s);
  statsStep(s);
  s.day += 1;
}

describe('helpers', () => {
  it('annualise compounds over a 360-day year', () => {
    expect(annualise(1.01, 30)).toBeCloseTo(Math.pow(1.01, 12) - 1, 10);
    expect(annualise(1.05, 360)).toBeCloseTo(0.05, 10);
    expect(annualise(0, 30)).toBe(0);
    expect(annualise(NaN, 30)).toBe(0);
    expect(annualise(1e9, 1)).toBe(50); // clamped, finite
  });

  it('inflationRate recovers a constant growth rate and damps noise', () => {
    const daily = Math.pow(1.1, 1 / 360); // 10 %/year
    const hist: number[] = [];
    for (let d = 0; d < 400; d++) hist.push(100 * Math.pow(daily, d) * (1 + (d % 2 ? 0.01 : -0.01)));
    expect(inflationRate(hist, 30, 7)).toBeCloseTo(0.1, 1);
    expect(inflationRate(hist, 360, 7)).toBeCloseTo(0.1, 2);
    const flat = new Array(100).fill(100);
    expect(inflationRate(flat, 30)).toBe(0);
  });

  it('inflationRate blends partial history with the carried rate', () => {
    expect(inflationRate([100, 100.1, 100.2], 30, 7, 0.04)).toBe(0.04); // span too short → carry
    const hist: number[] = [];
    for (let d = 0; d < 16; d++) hist.push(100); // flat for 15 days
    const r = inflationRate(hist, 30, 7, 0.06);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.06); // pulled toward the observed 0 %
  });

  it('roundSig keeps 6 significant digits and never returns NaN', () => {
    expect(roundSig(123.456789)).toBe(123.457);
    expect(roundSig(0.000123456789)).toBe(0.000123457);
    expect(roundSig(98765432.1)).toBe(98765432);
    expect(roundSig(NaN)).toBe(0);
    expect(roundSig(Infinity)).toBe(0);
  });

  it('topShare and value added per unit', () => {
    expect(topShare([1, 1, 1, 1, 1, 1, 1, 1, 1, 91], 0.1)).toBeCloseTo(0.91, 10);
    expect(topShare([0, 0], 0.1)).toBe(0);
    const va = unitValueAdded(PRICES);
    expect(va[G.bread]).toBeCloseTo(PRICES[G.bread] - PRICES[G.grain] - 0.2 * PRICES[G.coal], 10);
    expect(va[G.grain]).toBeCloseTo(PRICES[G.grain], 10);
  });

  it('monthly aggregation modes', () => {
    expect(monthMode('money')).toBe('end');
    expect(monthMode('firms_bakery')).toBe('end');
    expect(monthMode('births')).toBe('sum');
    expect(monthMode('cpi')).toBe('avg');
  });
});

describe('CPI', () => {
  it('initStats builds the basket from steady-state demand and starts at 100', () => {
    const { s } = world();
    initStats(s);
    const st = s.stats;
    expect(st.basketRent).toBe(1);
    // steady-state demand at the (uniform) consumer prices, mean income 10.75 and the
    // occupied-slot average rent (4 × 1.5 + 2 × 2.5) / 6
    expect(st.baseRent).toBeCloseTo(11 / 6, 10);
    const q = steadyStateDemand(PRICES, 10.75, 11 / 6);
    for (const g of CONSUMER_GOODS) {
      expect(st.basket[g]).toBeGreaterThan(0);
      expect(st.basket[g]).toBeCloseTo(q[g], 6);
    }
    expect(st.latest.cpi).toBeCloseTo(100, 6);
    // the town with dearer rent has the higher CPI; national = population-weighted
    const [a, b] = s.towns;
    expect(b.cpi).toBeGreaterThan(a.cpi);
    expect((a.cpi * a.pop + b.cpi * b.pop) / (a.pop + b.pop)).toBeCloseTo(100, 6);
    expect(st.baseWage).toBeCloseTo((4 * 10 + 12) / 5, 10);
  });

  it('doubling every consumer price and rent doubles the CPI (Laspeyres)', () => {
    const { s } = world();
    initStats(s);
    for (const m of s.markets) {
      m.price *= 2;
      m.ema *= 2;
      m.gross *= 2;
      m.net *= 2;
    }
    for (const b of s.buildings) if (b.kind === 'house') b.rent *= 2;
    statDay(s);
    expect(s.stats.latest.cpi).toBeCloseTo(200, 3);
  });

  it('prices at gross terms: a buyer-side levy on bread raises the CPI', () => {
    const { s } = world();
    initStats(s);
    statDay(s);
    const before = s.stats.latest.cpi;
    s.policy.levies.push({
      id: 1, label: '', enabled: true, dir: 1, base: 'sale', unit: 'pct', rate: 0.5, payer: 'buyer', threshold: 0, good: G.bread, town: -1, toTown: -1,
      sector: 'any', group: 'all', buildingKind: 'any', created: 0, until: -1, today: 0, month: 0, lastMonth: 0, total: 0,
    });
    statDay(s);
    const share = (s.stats.basket[G.bread] * PRICES[G.bread]) / s.stats.baseCost;
    expect(s.stats.latest.cpi - before).toBeCloseTo(100 * share * 0.5, 1);
  });
});

describe('CPI rent component', () => {
  it('a tenant-side rent payment by the Treasury lowers the CPI', () => {
    const { s } = world();
    initStats(s);
    statDay(s);
    const before = s.stats.latest.cpi;
    s.policy.levies.push({
      id: 2, label: '', enabled: true, dir: -1, base: 'rent', unit: 'pct', rate: 0.5, payer: 'tenant', threshold: 0, good: -1, town: -1, toTown: -1,
      sector: 'any', group: 'all', buildingKind: 'any', created: 0, until: -1, today: 0, month: 0, lastMonth: 0, total: 0,
    });
    statDay(s);
    const rentShare = (s.stats.basketRent * s.stats.baseRent) / s.stats.baseCost;
    expect(before - s.stats.latest.cpi).toBeCloseTo(100 * rentShare * 0.5, 0);
    expect(s.stats.latest.cpi).toBeLessThan(before);
  });
});

describe('daily indicators and town fields', () => {
  it('sets town derived fields', () => {
    const { s } = world();
    initStats(s);
    statDay(s);
    const [a, b] = s.towns;
    expect(a.pop).toBe(6);
    expect(a.employed).toBe(4);
    expect(a.unemployed).toBe(2);
    expect(a.homeless).toBe(2);
    expect(a.vacancies).toBe(2); // bakery target 6, 4 workers
    expect(a.vacantSlots).toBe(0);
    expect(a.avgWage).toBe(10);
    expect(a.avgRent).toBe(1.5);
    expect(b.pop).toBe(2);
    expect(b.vacantSlots).toBe(2);
    expect(b.avgWage).toBe(12);
    const L = s.stats.latest;
    expect(L.pop).toBe(8);
    expect(L.unemp).toBeCloseTo(3 / 8, 10);
    expect(L.homeless).toBe(2);
    expect(L.firms).toBe(2);
    expect(L.firms_bakery).toBe(1);
    expect(L.wage).toBeCloseTo(52 / 5, 10);
  });

  it('real GDP by production at base prices; nominal by expenditure', () => {
    const { s } = world();
    initStats(s);
    beginDayStats(s);
    const acc = s.stats.acc;
    acc['prod_' + G.bread] = 10;
    acc['prod_' + G.grain] = 5;
    acc.build_labor = 3;
    acc.consval = 50;
    acc.flow_rent = 9;
    acc.expval = 4;
    acc.impval = 6;
    statsStep(s);
    const st = s.stats;
    const bp = st.basePrices;
    const va = 10 * (bp[G.bread] - bp[G.grain] - 0.2 * bp[G.coal]) + 5 * bp[G.grain];
    const occupied = 6; // 4 + 2 residents
    expect(st.latest.gdpReal).toBeCloseTo(roundSig(va + 3 * st.baseWage + occupied * st.baseRent), 3);
    // owner-occupier (person 0 in h0) adds imputed rent 1.5
    expect(st.latest.gdpNominal).toBeCloseTo(50 + 9 + 1.5 + (4 - 6), 6);
    expect(st.latest.netExports).toBe(-2);
  });

  it('money, credit and bank ratios', () => {
    const { s, people } = world();
    newLoan(s, FIRM_BASE + 0, 400, 0.02, 0.07, 360, 'working');
    newLoan(s, people[3].id, 100, 0.02, 0.09, 360, 'house');
    s.bank.reserves += 0;
    reconcileBank(s);
    initStats(s);
    statDay(s);
    const L = s.stats.latest;
    expect(L.credit).toBe(500);
    expect(L.loanRate).toBeCloseTo((400 * 0.07 + 100 * 0.09) / 500, 6);
    expect(L.capRatio).toBeCloseTo(Math.min(5, s.bank.equity / 500), 4); // clamped to [−1, 5]
    expect(L.iouYield).toBeCloseTo(0.05, 10);
  });

  it('pushes aligned daily series and monthly means / sums / end values', () => {
    const { s } = world();
    initStats(s);
    for (let d = 0; d < DAYS_PER_MONTH; d++) {
      beginDayStats(s);
      s.stats.acc.births = 1;
      s.stats.acc.consval = d; // mean over the month = 14.5
      statsStep(s);
      s.day += 1;
    }
    const st = s.stats;
    const lens = new Set(Object.values(st.daily).map((a) => a.length));
    expect([...lens]).toEqual([DAYS_PER_MONTH]);
    expect(st.dailyStart).toBe(0);
    expect(series(s, 'births', 'monthly')).toEqual([30]);
    expect(series(s, 'cons', 'monthly')[0]).toBeCloseTo(14.5, 6);
    expect(series(s, 'pop', 'monthly')).toEqual([8]);
    expect(series(s, 'gini', 'monthly').length).toBe(1);
    expect(st.monthlyStart).toBe(0);
    expect(Object.keys(st.macc).length).toBe(0);
  });

  it('caps daily series at STATS_DAILY_CAP and advances dailyStart', () => {
    const { s } = world();
    initStats(s);
    statDay(s);
    for (const k in s.stats.daily) s.stats.daily[k] = new Array(STATS_DAILY_CAP).fill(1);
    s.stats.dailyStart = 5;
    statDay(s);
    for (const k in s.stats.daily) expect(s.stats.daily[k].length).toBe(STATS_DAILY_CAP);
    expect(s.stats.dailyStart).toBe(6);
  });

  it('counts firms that stop trading as bankruptcies', () => {
    const { s, firms } = world();
    initStats(s);
    statDay(s);
    closeFirm(s, firms[1], 'bankrupt'); // counted where it stops trading (carried into the day), so a loaded game counts as one never saved
    expect(firms[1].status).toBe('liquidating');
    statDay(s);
    expect(s.stats.latest.bankrupt).toBe(1);
    statDay(s);
    expect(s.stats.latest.bankrupt).toBe(0);
  });
});

describe('beginDayStats', () => {
  it('resets daily scratch and carries flows booked between days', () => {
    const { s, firms } = world();
    initStats(s);
    statDay(s);
    const f = firms[0];
    f.revenue = 5;
    f.spent = 3;
    f.wageBill = 40;
    f.otherCosts = 1;
    f.producedToday = 7;
    f.soldToday = 6;
    f.hired = 1;
    f.fired = 1;
    s.bank.approved = 2;
    s.bank.interestIn = 3;
    s.foreign.importsQty[G.iron] = 4;
    s.foreign.importValue = 50;
    // yesterday's statsStep ran; now the player mints between days
    mint(s, 250);
    beginDayStats(s);
    expect([f.revenue, f.spent, f.wageBill, f.otherCosts, f.producedToday, f.soldToday, f.hired, f.fired]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(s.bank.approved).toBe(0);
    expect(s.bank.interestIn).toBe(0);
    expect(s.foreign.importsQty[G.iron]).toBe(0);
    expect(s.foreign.importValue).toBe(0);
    expect(s.stats.acc.minted).toBe(250); // carried into today
    statsStep(s);
    expect(s.stats.latest.mintDay).toBe(250);
    s.day += 1;
    beginDayStats(s);
    expect(s.stats.acc.minted).toBeUndefined(); // nothing new since the last statsStep
  });
});

describe('distribution', () => {
  it('wealth counts cash, IOUs, gold, owned firms and houses, minus debts', () => {
    const { s, people, firms } = world();
    const p = people[0];
    p.iou = 2;
    p.gold = 1;
    s.iouMarket.price = 100;
    s.goldMarket.price = 50;
    const d = distributionStats(s);
    const bakery = firms[0];
    const firmValue = bakery.cash + bakery.tools * PRICES[G.tools] + 10 * PRICES[G.bread] + 500;
    expect(d.wealth[0]).toBeCloseTo(p.cash + 200 + 50 + firmValue + 1000, 6);
    newLoan(s, FIRM_BASE + bakery.id, 100, 0, 0.05, 360, 'working');
    newLoan(s, p.id, 30, 0, 0.05, 360, 'house');
    const d2 = distributionStats(s);
    expect(d2.wealth[0]).toBeCloseTo(d.wealth[0] - 130, 6);
    expect(d2.gini).toBeGreaterThan(0);
    expect(d2.gini).toBeLessThan(1);
    expect(d2.top10).toBeGreaterThan(0.1);
  });
});

describe('rebaseStats', () => {
  it('re-bases the CPI to 100, clears series and keeps inflation continuity', () => {
    const { s } = world();
    initStats(s);
    for (let d = 0; d < 40; d++) {
      for (const m of s.markets) {
        m.ema *= 1.002;
        m.price = m.ema;
        m.gross = m.ema;
      }
      statDay(s);
    }
    const infl = s.stats.latest.infl30;
    expect(infl).toBeGreaterThan(0.5);
    expect(s.stats.latest.cpi).toBeGreaterThan(100);
    rebaseStats(s);
    expect(s.startDay).toBe(s.day);
    expect(Object.keys(s.stats.daily).length).toBe(0);
    expect(s.stats.latest.cpi).toBe(100);
    statDay(s);
    expect(s.stats.latest.cpi).toBeCloseTo(100, 1);
    expect(s.stats.latest.infl30).toBeCloseTo(infl, 6); // carried until history exists
    expect(s.stats.dailyStart).toBe(s.day - 1);
  });
});

describe('events', () => {
  it('sustained unrest starts a strike that idles exactly STRIKE_DAYS working days', () => {
    const { s } = world();
    initStats(s);
    const town = s.towns[0];
    town.pop = 6;
    let strikeDaysSeen = 0;
    let started = -1;
    for (let d = 0; d < UNREST_DAYS + STRIKE_DAYS + 3; d++) {
      beginDayEvents(s);
      if (town.strikeDays > 0) strikeDaysSeen++; // what production sees during the day
      town.contentment = d < UNREST_DAYS ? UNREST_CONTENT - 0.1 : 0.8;
      eventsStep(s);
      if (started < 0 && town.strikeDays > 0) started = d;
      s.day += 1;
    }
    expect(started).toBe(UNREST_DAYS - 1);
    expect(strikeDaysSeen).toBe(STRIKE_DAYS);
    const texts = s.news.map((n) => n.text).join(' ');
    expect(texts).toMatch(/walked off the job/);
    expect(texts).toMatch(/strike in Kingsbridge is over/);
  });

  it('droughts count down in the morning with a news item at the end', () => {
    const { s } = world();
    s.towns[1].droughtDays = 2;
    beginDayEvents(s);
    expect(s.towns[1].droughtDays).toBe(1);
    beginDayEvents(s);
    expect(s.towns[1].droughtDays).toBe(0);
    expect(s.news[s.news.length - 1]?.text).toMatch(/Rain has returned to Millbrook/);
  });

  it('no random events during warm-up; news wording stays neutral', () => {
    const { s } = world();
    const rng0 = s.rng.slice();
    s.day = 10;
    beginDayEvents(s);
    expect(s.rng).toEqual(rng0); // no draws before the grace period
    for (let i = 0; i < 400; i++) news(s, 'x');
    expect(s.news.length).toBe(300);
  });

  it('monthlyChange compares the last 30 days with the 30 before', () => {
    const h = [...new Array(30).fill(10), ...new Array(30).fill(13)];
    expect(monthlyChange(h)).toBeCloseTo(0.3, 10);
    expect(monthlyChange([1, 2, 3])).toBe(0);
  });

  it('reports a severe staple shortage after several days', () => {
    const { s } = world();
    initStats(s);
    const m = s.markets[0 * N_GOODS + G.bread];
    for (let d = 0; d < 6; d++) {
      m.volume = 10;
      m.shortage = 20;
      eventsStep(s);
      s.day += 1;
    }
    const txt = s.news.map((n) => n.text).join(' ');
    expect(txt).toMatch(/Bread is running short in Kingsbridge/);
    expect(txt).not.toMatch(/\b(tax|subsid|tariff|quota|stimulus|bailout|minimum wage)/i);
  });
});

describe('save / load', () => {
  it('round-trips a state and keeps the ledger balanced', () => {
    const { s } = world();
    initStats(s);
    statDay(s);
    const s2 = deserialize(serialize(s));
    expect(s2.people.length).toBe(s.people.length);
    expect(s2.stats.latest.cpi).toBe(s.stats.latest.cpi);
    expect(Math.abs(checkLedger(s2))).toBeLessThan(1e-9);
    expect(validateSave(JSON.parse(serialize(s)))).toEqual([]);
  });

  it('rejects damaged saves with readable messages', () => {
    const { s } = world();
    initStats(s);
    expect(() => deserialize('')).toThrow(/empty/);
    expect(() => deserialize('{not json')).toThrow(/not valid JSON/);
    expect(() => deserialize('[1,2,3]')).toThrow(/does not contain a saved game/);
    const raw = JSON.parse(serialize(s));
    delete raw.bank;
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/"bank" section is missing/);
    const newer = JSON.parse(serialize(s));
    newer.version = 99;
    expect(() => deserialize(JSON.stringify(newer))).toThrow(/newer version/);
    const nan = JSON.parse(serialize(s));
    nan.people[2].cash = null; // what JSON.stringify makes of NaN
    expect(() => deserialize(JSON.stringify(nan))).toThrow(/people\[2\]\.cash/);
    const short = JSON.parse(serialize(s));
    short.markets.pop();
    expect(() => deserialize(JSON.stringify(short))).toThrow(/markets/);
  });

  it('repairs a small bank-ledger drift on load', () => {
    const { s } = world();
    initStats(s);
    const raw = JSON.parse(serialize(s));
    raw.bank.equity += 3;
    const s2 = deserialize(JSON.stringify(raw));
    expect(Math.abs(checkLedger(s2))).toBeLessThan(1e-9);
  });
});
