import { describe, expect, it } from 'vitest';
import { advanceClock, MAX_DT } from '../src/ui/loop';
import { outputIndex } from '../src/ui/topbar';
import { packSave, unpackSave } from '../src/ui/app';
import { PANELS } from '../src/ui/panels/index';

describe('game clock', () => {
  const clock = (start = 0) => {
    let t = start;
    return { now: () => t, tick: (ms: number) => (t += ms) };
  };
  it('runs one step per whole day crossed and keeps the fraction', () => {
    const c = clock();
    let n = 0;
    const r = advanceClock(0.5, 8, 0.25, () => n++, 10, c.now); // 0.5 + 8 × 0.25 = 2.5
    expect(r.days).toBe(2);
    expect(n).toBe(2);
    expect(r.dayFrac).toBeCloseTo(0.5);
    expect(r.dropped).toBe(false);
  });
  it('does nothing when paused', () => {
    const r = advanceClock(0.3, 0, 0.1, () => {
      throw new Error('should not step');
    }, 10, () => 0);
    expect(r.days).toBe(0);
    expect(r.dayFrac).toBe(0.3);
  });
  it('drops the backlog when the frame budget is spent', () => {
    const c = clock();
    let n = 0;
    const r = advanceClock(0, 40, 0.25, () => {
      n++;
      c.tick(6); // each day costs 6 ms
    }, 10, c.now);
    expect(n).toBe(2); // 6 ms, 12 ms → over budget after the 2nd
    expect(r.dropped).toBe(true);
    expect(r.dayFrac).toBeGreaterThanOrEqual(0);
    expect(r.dayFrac).toBeLessThan(1);
  });
  it('caps huge frame gaps (background tab)', () => {
    let n = 0;
    advanceClock(0, 40, 30, () => n++, 1e9, () => 0);
    expect(n).toBe(Math.floor(40 * MAX_DT));
  });
  it('reports a failing step without looping', () => {
    let n = 0;
    const r = advanceClock(0.9, 10, 0.5, () => {
      n++;
      throw new Error('boom');
    }, 10, () => 0);
    expect(n).toBe(1);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.days).toBe(0);
    expect(r.dayFrac).toBeLessThan(1);
  });
  it('treats a NaN fraction as zero', () => {
    const r = advanceClock(NaN, 1, 0.1, () => {}, 10, () => 0);
    expect(r.dayFrac).toBeCloseTo(0.1);
  });
});

describe('output index', () => {
  it('is 100 when flat and tracks 30-day means', () => {
    expect(outputIndex(new Array(60).fill(50)).index).toBeCloseTo(100);
    const up = [...new Array(30).fill(100), ...new Array(30).fill(110)];
    const o = outputIndex(up);
    expect(o.index).toBeCloseTo(110);
    expect(o.prev).toBeCloseTo(100);
  });
  it('is NaN without data or with a zero base', () => {
    expect(Number.isNaN(outputIndex([]).index)).toBe(true);
    expect(Number.isNaN(outputIndex([0, 0, 0]).index)).toBe(true);
  });
});

describe('save packing', () => {
  it('round-trips a JSON save', async () => {
    const json = JSON.stringify({ a: [1, 2, 3], b: 'ąé¤ realm', n: Array.from({ length: 5000 }, (_, i) => i * 0.37) });
    const packed = await packSave(json);
    expect(packed.startsWith('gz1:') || packed.startsWith('raw:')).toBe(true);
    if (packed.startsWith('gz1:')) expect(packed.length).toBeLessThan(json.length);
    expect(await unpackSave(packed)).toBe(json);
  });
  it('accepts bare JSON and raw-prefixed saves', async () => {
    expect(await unpackSave('{"x":1}')).toBe('{"x":1}');
    expect(await unpackSave('raw:{"x":1}')).toBe('{"x":1}');
  });
});

describe('panel registry', () => {
  it('has every tab once, in the documented order', () => {
    expect(PANELS.map((p) => p.id)).toEqual(['levers', 'markets', 'ledger', 'charts', 'people', 'almanac', 'inspect']);
    for (const p of PANELS) {
      expect(typeof p.mount).toBe('function');
      expect(typeof p.update).toBe('function');
      expect(p.title.length).toBeGreaterThan(0);
    }
  });
});
