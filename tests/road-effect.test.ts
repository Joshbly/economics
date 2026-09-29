// Build → road preview: paving a planned road upgrades the dirt track in place and the
// preview's estimate of the trips it speeds up matches what the paved road delivers.
import { describe, expect, it } from 'vitest';
import { invalidateRoutes } from '../src/sim/runtime';
import { createWorld } from '../src/sim/world/init';
import { roadPlan, routeBetweenTowns } from '../src/sim/world/paths';
import { paveEffect } from '../src/sim/world/roadEffect';

describe('paving preview', () => {
  it('upgrades the existing track and predicts faster, cheaper trips', () => {
    const s = createWorld({ seed: 1 });
    const plan = roadPlan(s, 0, 1);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((i) => s.map.road[i] >= 1)).toBe(true); // along the dirt road: nothing new beside it
    const fx = paveEffect(s, plan);
    const e = fx.find((x) => x.a === 0 && x.b === 1)!;
    expect(e).toBeTruthy();
    expect(e.daysPaved).toBeLessThan(e.daysNow * 0.7);
    expect(e.freightPaved).toBeGreaterThan(0);
    expect(e.freightPaved).toBeLessThan(e.freightNow);
    // pave it and compare with the estimate (an upper bound on the new travel time)
    for (const i of plan) s.map.road[i] = 2;
    invalidateRoutes(s);
    const after = routeBetweenTowns(s, 0, 1).days;
    expect(after).toBeLessThanOrEqual(e.daysPaved + 1e-3); // route days are rounded to 3 decimals
    expect(after).toBeGreaterThan(e.daysPaved * 0.8);
  });
});
