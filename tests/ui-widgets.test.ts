import { describe, expect, it } from 'vitest';
import type { CurveSnapshot } from '../src/sim/types';
import { dayTicks, fmtTick, logTicks, niceStep, niceTicks } from '../src/ui/widgets/axis';
import { curveDomain, demandAt, grossOf, hasWedge, limitBinds, netOf, supplyAt } from '../src/ui/widgets/curvechart';
import { binValues } from '../src/ui/widgets/histogram';
import { arrowOf, deltaTone, tailMean, trend } from '../src/ui/widgets/kpi';
import { compareValues, sortRows } from '../src/ui/widgets/table';
import { parseNumber } from '../src/ui/widgets/controls';
import { contrast, readable, seriesColor, SERIES, T } from '../src/ui/widgets/theme';

describe('axis ticks', () => {
  it('nice steps', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(1, 4)).toBe(0.25);
    expect(niceStep(0, 5)).toBe(1);
  });
  it('covers the range with round ticks', () => {
    const t = niceTicks(93.4, 116.2, 5);
    expect(t.min).toBeLessThanOrEqual(93.4);
    expect(t.max).toBeGreaterThanOrEqual(116.2);
    expect(t.ticks).toEqual([90, 95, 100, 105, 110, 115, 120]);
    const f = niceTicks(0.1, 0.3, 4);
    expect(f.ticks.every((x) => Number(x.toFixed(6)) === x)).toBe(true);
  });
  it('handles degenerate and invalid ranges', () => {
    expect(niceTicks(5, 5).ticks.length).toBeGreaterThan(1);
    expect(niceTicks(0, 0).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(NaN, Infinity).ticks.length).toBeGreaterThan(1);
    expect(niceTicks(10, 2).min).toBeLessThanOrEqual(2);
  });
  it('log ticks enclose the data', () => {
    const t = logTicks(3, 870, 5);
    expect(t.min).toBeLessThanOrEqual(3);
    expect(t.max).toBeGreaterThanOrEqual(870);
    expect(t.ticks.every((x) => x > 0)).toBe(true);
  });
  it('tick labels match the step', () => {
    expect(fmtTick(0.25, 0.25)).toBe('0.25');
    expect(fmtTick(100, 20)).toBe('100');
    expect(fmtTick(12_000, 2000)).toBe('12k');
    expect(fmtTick(1_500_000, 500_000)).toBe('1.5M');
  });
  it('calendar ticks land on month / year starts', () => {
    const t = dayTicks(360, 360 + 540, 400, 64);
    expect(t.length).toBeGreaterThan(1);
    expect(t.every((x) => x.x % 30 === 0)).toBe(true);
    expect(t.find((x) => x.x === 720)?.label).toBe('Y3');
    expect(t.find((x) => x.x === 720)?.major).toBe(true);
    const years = dayTicks(0, 360 * 12, 300, 64);
    expect(years.every((x) => x.x % 360 === 0)).toBe(true);
    const days = dayTicks(100, 130, 600, 60);
    expect(days.length).toBeGreaterThan(2);
    expect(dayTicks(5, 5, 100)).toEqual([]);
  });
});

function snap(over: Partial<CurveSnapshot> = {}): CurveSnapshot {
  return {
    // demand: 10 @ ≥ 6, 30 @ ≥ 5, 60 @ ≥ 4, 100 @ ≥ 3
    bids: [6, 10, 5, 30, 4, 60, 3, 100],
    // supply: 20 @ ≤ 3, 50 @ ≤ 4, 90 @ ≤ 5
    asks: [3, 20, 4, 50, 5, 90],
    state: [],
    price: 4,
    volume: 50,
    wedge: { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 },
    ceiling: -1,
    floor: -1,
    ...over,
  };
}

describe('curve maths', () => {
  it('reads cumulative demand and supply at a price', () => {
    const c = snap();
    expect(demandAt(c.bids, 7)).toBe(0);
    expect(demandAt(c.bids, 6)).toBe(10);
    expect(demandAt(c.bids, 4.5)).toBe(30);
    expect(demandAt(c.bids, 1)).toBe(100);
    expect(supplyAt(c.asks, 2)).toBe(0);
    expect(supplyAt(c.asks, 4)).toBe(50);
    expect(supplyAt(c.asks, 99)).toBe(90);
  });
  it('wedge: gross and net prices', () => {
    const c = snap({ wedge: { bPct: 0.3, bUnit: 0.1, sPct: 0.1, sUnit: 0.05 } });
    expect(hasWedge(c)).toBe(true);
    expect(grossOf(c, 4)).toBeCloseTo(5.3);
    expect(netOf(c, 4)).toBeCloseTo(3.55);
    expect(hasWedge(snap())).toBe(false);
  });
  it('domain keeps the clearing region and ignores far rungs', () => {
    const c = snap({ bids: [100, 1, 6, 10, 5, 30, 4, 60, 3, 100] });
    const d = curveDomain(c);
    expect(d.pLo).toBeLessThan(4);
    expect(d.pHi).toBeGreaterThan(4);
    expect(d.pHi).toBeLessThan(20); // the ¤100 bid is off-plot
    expect(d.qMax).toBeGreaterThan(50);
    expect(Number.isFinite(d.qMax)).toBe(true);
  });
  it('domain stretches to include limits and the wedge', () => {
    const d = curveDomain(snap({ ceiling: 9, wedge: { bPct: 0.5, bUnit: 0, sPct: 0, sUnit: 0 } }));
    expect(d.pHi).toBeGreaterThanOrEqual(9);
    const e = curveDomain(snap({ price: 0, volume: 0, bids: [], asks: [] }));
    expect(Number.isFinite(e.pLo) && Number.isFinite(e.pHi) && e.pHi > e.pLo).toBe(true);
  });
  it('detects a binding ceiling / floor and measures the gap off the curves', () => {
    const ceil = limitBinds(snap({ ceiling: 3, price: 3, volume: 20 }));
    expect(ceil).toEqual({ kind: 'ceiling', gap: 80 }); // demand 100 vs supply 20 at ¤3
    const floor = limitBinds(snap({ floor: 5, price: 5, volume: 30 }));
    expect(floor).toEqual({ kind: 'floor', gap: 60 }); // supply 90 vs demand 30 at ¤5
    expect(limitBinds(snap({ ceiling: 9 }))).toBeNull(); // not binding
  });
});

describe('histogram bins', () => {
  it('linear bins count everything once', () => {
    const v = Array.from({ length: 1000 }, (_, i) => i / 10);
    const b = binValues(v, 10);
    expect(b.counts.reduce((a, x) => a + x, 0)).toBe(1000);
    expect(b.edges.length).toBe(b.counts.length + 1);
    expect(b.zeroBin).toBe(-1);
  });
  it('log bins separate non-positive values', () => {
    const b = binValues([0, -5, 1, 10, 100, 1000, NaN], 6, true);
    expect(b.zeroBin).toBe(0);
    expect(b.counts[0]).toBe(2);
    expect(b.total).toBe(6);
    expect(b.counts.reduce((a, x) => a + x, 0)).toBe(6);
  });
  it('degenerate inputs', () => {
    expect(binValues([], 10).total).toBe(0);
    const same = binValues([5, 5, 5], 4);
    expect(same.counts.reduce((a, x) => a + x, 0)).toBe(3);
  });
});

describe('kpi helpers', () => {
  it('trend over a lookback', () => {
    const t = trend([10, 11, 12, NaN, 15], 3);
    expect(t.now).toBe(15);
    expect(t.prev).toBe(11);
    expect(t.delta).toBe(4);
    expect(t.rel).toBeCloseTo(4 / 11);
    expect(Number.isNaN(trend([], 30).now)).toBe(true);
    expect(trend([5], 30).delta).toBe(0);
  });
  it('tail mean', () => {
    expect(tailMean([1, 2, 3, 4], 2)).toBe(3.5);
    expect(tailMean([1, 2, 3, 4], 2, 2)).toBe(1.5);
    expect(Number.isNaN(tailMean([], 3))).toBe(true);
  });
  it('tones and arrows', () => {
    expect(deltaTone(0.1, 'up')).toBe('good');
    expect(deltaTone(0.1, 'down')).toBe('bad');
    expect(deltaTone(-0.1, 'down')).toBe('good');
    expect(deltaTone(0.1, null)).toBeNull();
    expect(deltaTone(NaN, 'up')).toBeNull();
    expect(arrowOf(2)).toBe('▲');
    expect(arrowOf(-2)).toBe('▼');
    expect(arrowOf(0)).toBe('→');
  });
});

describe('table sorting', () => {
  it('compares numbers, strings (naturally) and puts non-finite last', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues('item 2', 'item 10')).toBeLessThan(0);
    expect(compareValues(NaN, 1)).toBeGreaterThan(0);
  });
  it('sorts stably in both directions with NaN last', () => {
    const rows = [{ v: 3 }, { v: NaN }, { v: 1 }, { v: 3 }, { v: 2 }];
    const asc = sortRows(rows, (r) => r.v, 1).map((r) => r.v);
    expect(asc.slice(0, 4)).toEqual([1, 2, 3, 3]);
    expect(Number.isNaN(asc[4])).toBe(true);
    const desc = sortRows(rows, (r) => r.v, -1).map((r) => r.v);
    expect(desc.slice(0, 4)).toEqual([3, 3, 2, 1]);
    expect(Number.isNaN(desc[4])).toBe(true);
    const tie = sortRows([{ k: 'a', v: 1 }, { k: 'b', v: 1 }], (r) => r.v, -1);
    expect(tie.map((r) => r.k)).toEqual(['a', 'b']);
  });
});

describe('number parsing', () => {
  it('accepts separators, currency, percent and suffixes', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('¤ 12')).toBe(12);
    expect(parseNumber('10%')).toBe(10);
    expect(parseNumber('1.5k')).toBe(1500);
    expect(parseNumber('2M')).toBe(2_000_000);
    expect(parseNumber('−3')).toBe(-3);
    expect(parseNumber('-0.25')).toBe(-0.25);
  });
  it('rejects junk', () => {
    expect(Number.isNaN(parseNumber(''))).toBe(true);
    expect(Number.isNaN(parseNumber('abc'))).toBe(true);
    expect(Number.isNaN(parseNumber('1.2.3'))).toBe(true);
    expect(Number.isNaN(parseNumber('1e999'))).toBe(true);
  });
});

describe('theme', () => {
  it('series colours are fixed and clear the surface', () => {
    expect(seriesColor(0)).toBe(SERIES[0]);
    expect(seriesColor(8)).toBe(SERIES[0]);
    for (const c of SERIES) expect(contrast(c, T.bg2)).toBeGreaterThanOrEqual(3);
  });
  it('readable() lifts dark colours to 3:1 on the surface', () => {
    const oil = '#3c3350';
    expect(contrast(oil, T.bg2)).toBeLessThan(3);
    expect(contrast(readable(oil), T.bg2)).toBeGreaterThanOrEqual(3);
    expect(readable(SERIES[0])).toBe(SERIES[0]);
  });
});
