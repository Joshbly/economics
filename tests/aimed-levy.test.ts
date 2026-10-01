// Aimed sale rules: the rate re-sets each morning, town by town, so that what the payer
// pays (or receives) moves toward a price. Unit checks on tiny states, plus one run on a
// generated world (households' bread held near the aim, money conserved).
import { describe, expect, it } from 'vitest';
import { AIM_SMOOTH } from '../src/sim/config';
import { stepDay } from '../src/sim/engine';
import { newMarket, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger } from '../src/sim/ledger';
import { aimedRateAt, rateIn, saleWedge, steerLevies } from '../src/sim/policy/levies';
import { aimedRatesText, describeLevy, dispatch } from '../src/sim/policy/player';
import { createWorld } from '../src/sim/world/init';
import type { Levy, MapData, PlayerAction, SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative|price support)\b/i;

function tinyMap(): MapData {
  const n = 4;
  return { w: 2, h: 2, terrain: new Array(n).fill(3), elev: new Array(n).fill(0.5), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0), river: new Array(n).fill(0), road: new Array(n).fill(0), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

/** Two towns; bread at 4 in town 0 and 3 in town 1. */
function tinyState(): SimState {
  const s = newSimState(1, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 0, 0, 3));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 1, 1, 3));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 10));
  const b0 = s.markets[0 * N_GOODS + G.bread];
  const b1 = s.markets[1 * N_GOODS + G.bread];
  b0.price = b0.ema = 4;
  b1.price = b1.ema = 3;
  return s;
}

type LevyIn = Extract<PlayerAction, { type: 'addLevy' }>['levy'];
const aimed = (p: Partial<LevyIn>): LevyIn => ({ label: '', enabled: true, dir: -1, base: 'sale', unit: 'pct', rate: 0, payer: 'buyer', threshold: 0, good: G.bread, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1, aim: 2.5, aimMax: 0.5, ...p });

function add(s: SimState, l: LevyIn): Levy {
  const r = dispatch(s, { type: 'addLevy', levy: l });
  expect(r.ok, r.message).toBe(true);
  return s.policy.levies.find((x) => x.id === r.id)!;
}

describe('aimed sale rules — validation and wording', () => {
  it('only a % rule on sales of one good can aim, within the ceiling', () => {
    const s = tinyState();
    expect(dispatch(s, { type: 'addLevy', levy: aimed({ base: 'wage', payer: 'worker', good: -1 }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: aimed({ good: -1 }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: aimed({ unit: 'perUnit' }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: aimed({ aimMax: 0.99 }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: aimed({ aimMax: 0 }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: aimed({ aim: -1, rate: 0.1 }) }).ok).toBe(true); // aim ≤ 0 = an ordinary fixed rule
    const fixed = s.policy.levies[0];
    expect(fixed.aim).toBeUndefined();
  });

  it('describes itself neutrally and names each town’s rate', () => {
    const s = tinyState();
    const l = add(s, aimed({ group: 'persons' }));
    const text = describeLevy(s, l);
    expect(text).toMatch(/pays part of the price of bread bought by households — re-set each morning in each town so that they pay about ¤2\.50 a loaf, and never more than 50% of the price/);
    expect(text).not.toMatch(FORBIDDEN);
    expect(aimedRatesText(s, l)).toMatch(/Millbrook 38%, Saltmere 17%/);
    expect(l.label).toMatch(/aim ¤2\.50/);
  });
});

describe('aimed sale rules — the rate in each town', () => {
  it('starts at the rate each town needs, and the wedge uses it', () => {
    const s = tinyState();
    const l = add(s, aimed({}));
    // buyers pay p·(1 − r) = 2.5 → r = 1 − 2.5/p
    expect(rateIn(l, 0)).toBeCloseTo(1 - 2.5 / 4, 6);
    expect(rateIn(l, 1)).toBeCloseTo(1 - 2.5 / 3, 6);
    expect(l.rate).toBeCloseTo(rateIn(l, 0), 9); // the highest town rate
    expect(saleWedge(s, 0, G.bread).bPct).toBeCloseTo(-rateIn(l, 0), 9);
    expect(saleWedge(s, 1, G.bread).bPct).toBeCloseTo(-rateIn(l, 1), 9);
    expect(saleWedge(s, 0, G.grain).bPct).toBe(0);
  });

  it('moves a share of the gap each morning, capped, and pays nothing below the aim', () => {
    const s = tinyState();
    const l = add(s, aimed({ aimMax: 0.3 }));
    expect(rateIn(l, 0)).toBeCloseTo(0.3, 9); // needs 37.5 %, capped at 30 %
    const m1 = s.markets[1 * N_GOODS + G.bread];
    m1.price = 2; // now below the aim
    const before = rateIn(l, 1);
    steerLevies(s);
    expect(rateIn(l, 1)).toBeCloseTo(before * (1 - AIM_SMOOTH), 9);
    for (let i = 0; i < 40; i++) steerLevies(s);
    expect(rateIn(l, 1)).toBe(0);
    expect(rateIn(l, 0)).toBeCloseTo(0.3, 9);
  });

  it('works for takes and for sellers too (the sign of the effect)', () => {
    const s = tinyState();
    const takeBuyers = { aim: 5, aimMax: 0.9, dir: 1, payer: 'buyer' } as unknown as Levy; // raise what buyers pay to 5
    expect(aimedRateAt(takeBuyers, 4)).toBeCloseTo(0.25, 9);
    expect(aimedRateAt(takeBuyers, 6)).toBe(0);
    const giveSellers = { aim: 5, aimMax: 0.9, dir: -1, payer: 'seller' } as unknown as Levy; // sellers receive p·(1 + r)
    expect(aimedRateAt(giveSellers, 4)).toBeCloseTo(0.25, 9);
    const takeSellers = { aim: 3, aimMax: 0.9, dir: 1, payer: 'seller' } as unknown as Levy; // sellers receive p·(1 − r)
    expect(aimedRateAt(takeSellers, 4)).toBeCloseTo(0.25, 9);
    void s;
  });

  it('can be switched back to a fixed rate', () => {
    const s = tinyState();
    const l = add(s, aimed({}));
    const r = dispatch(s, { type: 'updateLevy', id: l.id, patch: { aim: -1, rate: 0.1 } });
    expect(r.ok, r.message).toBe(true);
    expect(l.aim).toBeUndefined();
    expect(l.aimRates).toBeUndefined();
    expect(rateIn(l, 0)).toBeCloseTo(0.1, 9);
  });
});

describe('aimed sale rules — in a running realm', () => {
  it('holds what households pay for bread near the aim, town by town, with money conserved', () => {
    const s = createWorld({ seed: 3 });
    s.settings.events = false;
    s.treasury.autoMint = true;
    for (let d = 0; d < 60; d++) stepDay(s);
    const nt = s.towns.length;
    const price = (t: number) => s.markets[t * N_GOODS + G.bread].ema;
    const avg = Array.from({ length: nt }, (_, t) => price(t)).reduce((a, b) => a + b, 0) / nt;
    const target = Math.round(avg * 0.8 * 100) / 100;
    const l = add(s, aimed({ aim: target, aimMax: 0.6, group: 'persons' }));
    const paid: number[][] = Array.from({ length: nt }, () => []);
    for (let d = 0; d < 60; d++) {
      stepDay(s);
      if (d >= 30) for (let t = 0; t < nt; t++) paid[t].push(s.markets[t * N_GOODS + G.bread].price * (1 - rateIn(l, t)));
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    for (let t = 0; t < nt; t++) expect(mean(paid[t]), s.towns[t].name).toBeLessThan(target * 1.25);
    expect(l.total).toBeLessThan(0); // the Treasury paid
    const led = checkLedger(s);
    expect(Math.abs(led)).toBeLessThan(1e-3);
  });
});
