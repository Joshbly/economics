// Firms with several owners (agents/ownership.ts): dividends and wind-up proceeds by share, the
// largest holder in control, stakes through estates; ventures funded by syndicates.
import { describe, expect, it } from 'vitest';
import { holders, passStakes, payHolders, setHoldings, stakeOf, stakesOf, transferStake } from '../src/sim/agents/ownership';
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import { checkLedger, firmRef } from '../src/sim/ledger';
import type { Firm, SimState } from '../src/sim/types';

function world(seed = 1): SimState {
  const g = Game.create({ seed, warmup: false });
  g.s.settings.events = false;
  return g.s;
}

function privateFirm(s: SimState): Firm {
  return s.firms.find((f) => f && f.alive && f.status === 'active' && f.owner >= 0 && f.owner < 1_000_000 && f.sector !== 'stateworks')!;
}

describe('shares', () => {
  it('holdings sum to one, the largest holder controls, owns lists follow', () => {
    const s = world();
    const f = privateFirm(s);
    const a = f.owner;
    const b = s.people.find((p) => p.alive && p.id !== a)!.id;
    const c = s.people.find((p) => p.alive && p.id !== a && p.id !== b)!.id;
    setHoldings(s, f, [
      { ref: a, share: 0.3 },
      { ref: b, share: 0.5 },
      { ref: c, share: 0.2 },
    ]);
    expect(f.owner).toBe(b);
    expect(holders(f).reduce((x, h) => x + h.share, 0)).toBeCloseTo(1, 9);
    expect(stakeOf(f, a)).toBeCloseTo(0.3, 9);
    expect(s.people[c].owns).toContain(f.id);
    // a sale of a stake
    transferStake(s, f, c, a, 0.2);
    expect(stakeOf(f, c)).toBe(0);
    expect(s.people[c].owns).not.toContain(f.id);
    expect(stakeOf(f, a)).toBeCloseTo(0.5, 9);
    expect(stakesOf(s, a).find((x) => x.firm === f)?.share).toBeCloseTo(0.5, 9);
  });

  it('dividends go to every holder by share', () => {
    const s = world();
    const f = privateFirm(s);
    const a = f.owner;
    const b = s.people.find((p) => p.alive && p.id !== a)!.id;
    setHoldings(s, f, [
      { ref: a, share: 0.75 },
      { ref: b, share: 0.25 },
    ]);
    const amt = Math.min(400, 0.5 * f.cash);
    expect(amt).toBeGreaterThan(1);
    const ca = s.people[a].cash;
    const cb = s.people[b].cash;
    const paid = payHolders(s, f, firmRef(f.id), amt, 'dividend');
    expect(paid).toBeCloseTo(amt, 6);
    expect(s.people[a].cash - ca).toBeCloseTo(0.75 * amt, 6);
    expect(s.people[b].cash - cb).toBeCloseTo(0.25 * amt, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('an estate passes every stake to the heir', () => {
    const s = world();
    const f = privateFirm(s);
    const a = f.owner;
    const b = s.people.find((p) => p.alive && p.id !== a)!.id;
    const heir = s.people.find((p) => p.alive && p.id !== a && p.id !== b)!.id;
    setHoldings(s, f, [
      { ref: a, share: 0.6 },
      { ref: b, share: 0.4 },
    ]);
    passStakes(s, b, heir);
    expect(stakeOf(f, b)).toBe(0);
    expect(stakeOf(f, heir)).toBeCloseTo(0.4, 9);
    expect(s.people[heir].owns).toContain(f.id);
  });
});

describe('syndicates', () => {
  it('ventures happen with several owners, and the books still balance', () => {
    const s = world(1);
    let partnered = 0;
    for (let d = 0; d < 720; d++) {
      stepDay(s);
      if (d % 90 === 89) partnered = Math.max(partnered, s.firms.filter((f) => f && f.alive && f.partners?.length).length);
    }
    expect(partnered).toBeGreaterThan(0);
    for (const f of s.firms) {
      if (!f || !f.alive) continue;
      const tot = holders(f).reduce((x, h) => x + h.share, 0);
      expect(tot).toBeCloseTo(1, 6);
      for (const h of holders(f)) if (h.ref >= 0 && h.ref < 1_000_000 && s.people[h.ref]?.alive) expect(s.people[h.ref].owns).toContain(f.id);
    }
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  }, 90000); // two years of a whole realm
});
