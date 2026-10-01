// End-to-end smoke test of the whole simulation: a fresh realm (seed 1) runs 60
// days with every module in the loop. Needs every module implemented.
import { describe, expect, it } from 'vitest';
import { stepDay } from '../src/sim/engine';
import { checkLedger, deposits } from '../src/sim/ledger';
import { deserialize, serialize } from '../src/sim/save';
import { createWorld } from '../src/sim/world/init';

describe('simulation smoke test', () => {
  it('runs 60 days from seed 1: finite indicators, balanced ledger, people and trade', () => {
    const s = createWorld({ seed: 1 });
    expect(s).toBeTruthy();
    const pop0 = s.people.filter((p) => p && p.alive).length;
    expect(pop0).toBeGreaterThan(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, deposits(s)));

    let traded = 0;
    const problems: string[] = [];
    for (let d = 0; d < 60; d++) {
      stepDay(s);
      for (const [k, v] of Object.entries(s.stats.latest)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`day ${d}: stats.latest.${k} = ${String(v)}`);
      }
      const money = deposits(s);
      const err = checkLedger(s);
      if (!(Math.abs(err) <= 1e-6 * Math.max(1, money))) problems.push(`day ${d}: ledger off by ${err}`);
      for (const m of s.markets) traded += m.volume > 0 ? m.volume : 0;
      if (problems.length > 10) break;
    }
    expect(problems).toEqual([]);
    expect(s.people.filter((p) => p && p.alive).length).toBeGreaterThan(0);
    expect(traded).toBeGreaterThan(0);
    expect(s.stats.daily.cpi?.length).toBe(60);
    expect(s.stats.monthly.cpi?.length).toBe(2);

    // A save made mid-game loads and continues exactly like the uninterrupted game
    // (runtime caches are rebuildable and never change outcomes).
    const s2 = deserialize(serialize(s));
    for (let d = 0; d < 10; d++) {
      stepDay(s);
      stepDay(s2);
    }
    expect(Math.abs(checkLedger(s2))).toBeLessThan(1e-6 * Math.max(1, deposits(s2)));
    expect(JSON.stringify(s2.stats.latest)).toBe(JSON.stringify(s.stats.latest));
    expect(JSON.stringify(s2.people)).toBe(JSON.stringify(s.people));
  }, 120_000);
});
