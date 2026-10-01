// A market's shortage and surplus over its last MARKET_BALANCE_DAYS days (markets.recentBalance).
import { describe, expect, it } from 'vitest';
import { MARKET_BALANCE_DAYS } from '../src/sim/config';
import { Game } from '../src/sim/game';
import { recentBalance } from '../src/sim/market/markets';

describe('the 14-day balance of a market', () => {
  it('averages the last days’ shortage and surplus, signed: + short, − unsold', () => {
    const m = { shortage: 0, surplus: 0, volume: 0, shortHist: [10, 10, 0, 0], surplusHist: [0, 0, 0, 2], volHist: [90, 90, 100, 98] };
    const b = recentBalance(m);
    expect(b.days).toBe(4);
    expect(b.shortage).toBeCloseTo(5, 9);
    expect(b.surplus).toBeCloseTo(0.5, 9);
    expect(b.volume).toBeCloseTo(94.5, 9);
    expect(b.net).toBeCloseTo((5 - 0.5) / (94.5 + 5), 9); // share of what buyers wanted
    const u = recentBalance({ ...m, shortHist: [0, 0], surplusHist: [8, 12], volHist: [50, 50] });
    expect(u.net).toBeCloseTo(-10 / 60, 9); // share of what sellers offered
    expect(recentBalance({ shortage: 3, surplus: 0, volume: 7, volHist: [] }).days).toBe(1); // no history yet: today
    expect(recentBalance(undefined).net).toBe(0);
  });

  it('every market keeps its last days (and no more)', () => {
    const g = Game.create({ seed: 1, warmup: false });
    g.step(MARKET_BALANCE_DAYS + 5);
    for (const m of g.s.markets) {
      expect(m.shortHist!.length).toBe(MARKET_BALANCE_DAYS);
      expect(m.surplusHist!.length).toBe(MARKET_BALANCE_DAYS);
      expect(m.shortHist![MARKET_BALANCE_DAYS - 1]).toBeCloseTo(m.shortage, 9);
    }
    const back = Game.load(g.save());
    expect(back.s.markets[0].shortHist).toEqual(g.s.markets[0].shortHist);
  });
});
