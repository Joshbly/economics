// What IOUs are worth to those who might hold them (agents/bonds.ts), how holders trade toward the
// holding they want, and why households hold gold (agents/gold.ts).
import { describe, expect, it } from 'vitest';
import { bankIouWorth, bondsBeginDay, bondView, debtMemory, householdIouWorth, iouWanted, iouWorth, noteCouponCut, postIouSchedule } from '../src/sim/agents/bonds';
import { goldMotives, goldTarget, goldTaste, goldView } from '../src/sim/agents/gold';
import { GOLD_BASE_SHARE, GOLD_FEAR_SHARE, IOU_COUPON, IOU_MIN_YIELD, IOU_TENDER_GAP } from '../src/sim/config';
import { Game } from '../src/sim/game';
import { rt } from '../src/sim/runtime';
import type { Book, Order, SimState } from '../src/sim/types';

function world(seed = 1): SimState {
  const g = Game.create({ seed, warmup: false });
  g.s.settings.events = false;
  return g.s;
}

/** A fresh view (bondView is cached for the day). */
function fresh(s: SimState) {
  delete rt(s).bag.bondView;
  delete rt(s).bag.goldView;
  return bondView(s);
}

function book(): Book {
  return { town: -1, good: 100, bids: [], asks: [], wedge: { pct: 0, unit: 0 } as any, ceiling: -1, floor: -1 };
}
const sum = (os: Order[]) => os.reduce((a, o) => a + o.qty, 0);

describe('what an IOU is worth', () => {
  it('is the coupon over the yield asked, never above what the least yield allows', () => {
    expect(iouWorth(0.05)).toBeCloseTo(IOU_COUPON / 0.05, 9);
    expect(iouWorth(0)).toBeCloseTo(IOU_COUPON / IOU_MIN_YIELD, 9);
    expect(iouWorth(-1)).toBeCloseTo(IOU_COUPON / IOU_MIN_YIELD, 9);
  });

  it('falls when the reserve rate rises — a little at once, more the longer it stays', () => {
    const s = world();
    bondsBeginDay(s); // the market's memory of rates, as every day begins
    const w0 = bankIouWorth(s);
    s.treasury.reserveRate += 0.03;
    fresh(s);
    const w1 = bankIouWorth(s);
    expect(w1).toBeLessThan(w0);
    for (let d = 0; d < 360; d++) {
      s.day++;
      bondsBeginDay(s);
    }
    const w2 = bankIouWorth(s);
    expect(w2).toBeLessThan(w1);
    // holders never expect the whole move to last: the yield asked rises by less than the rate
    const v = bondView(s);
    expect(v.expRate).toBeLessThan(s.treasury.reserveRate);
  });

  it('falls when households expect inflation (rates will follow it, and the coin buys less)', () => {
    const s = world();
    const v0 = fresh(s);
    for (const p of s.people) p.expInfl = 0.12;
    const v1 = fresh(s);
    expect(v1.expRate).toBeGreaterThan(v0.expRate);
    expect(v1.inflationRisk).toBeGreaterThan(0);
    expect(iouWorth(v1.bankYield)).toBeLessThan(iouWorth(v0.bankYield));
  });

  it('falls when coupons are cut — a memory that fades over the years', () => {
    const s = world();
    const w0 = bankIouWorth(s);
    for (let d = 0; d < 20; d++) noteCouponCut(s, 0);
    const stress = debtMemory(s).stress;
    expect(stress).toBeGreaterThan(0);
    const w1 = iouWorth(fresh(s).bankYield);
    expect(w1).toBeLessThan(0.7 * w0);
    for (let d = 0; d < 720; d++) {
      s.day++;
      bondsBeginDay(s);
    }
    expect(debtMemory(s).stress).toBeLessThan(0.3 * stress);
    expect(bankIouWorth(s)).toBeGreaterThan(w1);
  });

  it('falls with the debt, beyond what a share of a year’s output carries freely', () => {
    const s = world();
    s.stats.latest.gdpNominal = 1000; // a year's output: 360 000
    s.treasury.iouOutstanding = 100; // 10 000 at par: little
    const low = fresh(s);
    s.treasury.iouOutstanding = 5000; // 500 000 at par: 1.4 years' output
    const high = fresh(s);
    expect(high.debtRatio).toBeGreaterThan(1);
    expect(high.sovereign).toBeGreaterThan(low.sovereign);
    expect(iouWorth(high.bankYield)).toBeLessThan(iouWorth(low.bankYield));
  });

  it('is worth more to the keenest households than to the bank, while deposits pay less than reserves', () => {
    const s = world();
    let best = 0;
    for (const p of s.people) best = Math.max(best, householdIouWorth(s, p.id));
    expect(bondView(s).expDeposit).toBeLessThan(bondView(s).expRate);
    expect(best).toBeGreaterThan(bankIouWorth(s));
  });
});

describe('trading toward the holding wanted', () => {
  const ask = 0.04; // worth 125
  it('wants none at its worth or above, and more the cheaper they are', () => {
    expect(iouWanted(125, 10_000, ask, 0.03)).toBeCloseTo(0, 9);
    expect(iouWanted(150, 10_000, ask, 0.03)).toBe(0);
    const a = iouWanted(110, 10_000, ask, 0.03);
    const b = iouWanted(90, 10_000, ask, 0.03);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // all of its funds at `full` over its ask
    expect(iouWanted(IOU_COUPON / (ask + 0.03), 10_000, ask, 0.03) * (IOU_COUPON / (ask + 0.03))).toBeCloseTo(10_000, 6);
  });

  it('bids below its worth, more at lower prices, never beyond its cash', () => {
    const bk = book();
    const spend = postIouSchedule(bk, 7, { held: 0, funds: 50_000, cash: 300, ask, full: 0.03, buySpeed: 0.5, sellSpeed: 0.05 }, 110);
    expect(bk.asks.length).toBe(0);
    expect(bk.bids.length).toBeGreaterThan(1);
    for (const o of bk.bids) expect(o.limit).toBeLessThan(125);
    expect(spend).toBeLessThanOrEqual(300 + 1e-9);
    // what it would buy at the lowest bid price is the whole stack, and costs no more than its cash
    const lo = Math.min(...bk.bids.map((o) => o.limit));
    expect(sum(bk.bids) * lo).toBeLessThanOrEqual(300 + 1e-6);
  });

  it('offers what it holds beyond what it wants, and everything to a buyer paying well over its worth', () => {
    const bk = book();
    postIouSchedule(bk, 7, { held: 40, funds: 4000, cash: 0, ask, full: 0.03, buySpeed: 0.05, sellSpeed: 0.05 }, 110);
    expect(bk.bids.length).toBe(0);
    const worth = iouWorth(ask);
    // at the going price (110) it wants ~12: only a step of the rest is offered at or below it
    const near = sum(bk.asks.filter((o) => o.limit <= 110 + 1e-9));
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(10);
    // at IOU_TENDER_GAP over its worth, all of it
    const all = sum(bk.asks.filter((o) => o.limit <= worth * (1 + IOU_TENDER_GAP) + 1e-9));
    expect(all).toBeCloseTo(40, 6);
    // the ladder rises: more is offered the more a buyer pays
    const sorted = [...bk.asks].sort((a, b) => a.limit - b.limit);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].limit).toBeGreaterThan(sorted[i - 1].limit);
  });
});

describe('the IOU market (a headless world)', () => {
  it('the Treasury sells IOUs to those who want them, lowering their price, and buys them back paying over it', () => {
    const g = Game.create({ seed: 1 });
    const s = g.s;
    const p0 = s.iouMarket.ema;
    g.dispatch({ type: 'placeOrder', market: { kind: 'iou' }, side: 'sell', price: 0, qty: 20, priceMode: 'follow', band: 0.05, days: 15 } as any);
    g.step(15);
    const out = s.treasury.iouOutstanding;
    expect(out).toBeGreaterThan(50);
    expect(s.iouMarket.ema).toBeLessThan(p0);
    g.dispatch({ type: 'placeOrder', market: { kind: 'iou' }, side: 'buy', price: Math.round(1.3 * s.iouMarket.ema), qty: 20 } as any);
    g.step(15);
    expect(s.treasury.iouOutstanding).toBeLessThan(0.3 * out);
  }, 90_000);

  it('with none in anyone’s hands, the quote is what a few would fetch from the bids', () => {
    const g = Game.create({ seed: 2 });
    const s = g.s;
    g.step(5);
    expect(s.treasury.iouOutstanding).toBe(0);
    const w = bankIouWorth(s);
    expect(s.iouMarket.ema).toBeGreaterThan(0.8 * w);
    expect(s.iouMarket.ema).toBeLessThan(1.05 * w);
  }, 90_000);
});

describe('gold', () => {
  it('households start with a small store of gold, the cautious more', () => {
    const s = world();
    let held = 0;
    let wealth = 0;
    for (const p of s.people) {
      held += p.gold * s.goldMarket.ema;
      wealth += p.cash + p.gold * s.goldMarket.ema;
    }
    expect(held / wealth).toBeGreaterThan(0.3 * GOLD_BASE_SHARE);
    expect(held / wealth).toBeLessThan(3 * GOLD_BASE_SHARE);
    const [a, b] = [...s.people].sort((x, y) => goldTaste(s, x.id) - goldTaste(s, y.id)).filter((_, i, arr) => i === 0 || i === arr.length - 1);
    expect(goldTarget(s, b)).toBeGreaterThan(goldTarget(s, a));
  });

  it('is wanted more when inflation outruns the deposit rate', () => {
    const s = world();
    const p = s.people[0];
    const t0 = goldTarget(s, p);
    p.expInfl = 0.15;
    expect(goldTarget(s, p)).toBeGreaterThan(t0 + 0.05);
    s.bank.depositRate = 0.15;
    expect(goldTarget(s, p)).toBeCloseTo(t0, 9);
  });

  it('is wanted more when the bank is short of capital, and most once it has failed', () => {
    const s = world();
    const p = s.people[0];
    fresh(s);
    const t0 = goldTarget(s, p);
    expect(goldView(s).fear).toBe(0);
    s.bank.failed = true;
    fresh(s);
    expect(goldView(s).fear).toBe(1);
    expect(goldTarget(s, p)).toBeCloseTo(t0 + GOLD_FEAR_SHARE, 6);
  });

  it('is wanted more when the gold price is well up on a year ago (the coin is expected to keep falling)', () => {
    const s = world();
    const p = s.people[0];
    const m = s.goldMarket;
    m.hist = new Array(360).fill(m.ema);
    fresh(s);
    const t0 = goldTarget(s, p);
    m.ema *= 1.4;
    fresh(s);
    expect(goldView(s).fall).toBeGreaterThan(0.35);
    expect(goldTarget(s, p)).toBeGreaterThan(t0 + 0.05);
    const why = goldMotives(s);
    expect(why.run).toBeGreaterThan(0);
    expect(why.target).toBeCloseTo(Math.min(0.4, why.base + why.hedge + why.fear + why.run), 9);
  });
});
