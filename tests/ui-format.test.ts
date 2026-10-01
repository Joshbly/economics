import { describe, expect, it } from 'vitest';
import {
  fmtCompact,
  fmtDay,
  fmtDayLong,
  fmtDayTick,
  fmtDuration,
  fmtIndex,
  fmtInt,
  fmtMoney,
  fmtMoneyDelta,
  fmtMoneyFull,
  fmtMoneyShort,
  fmtNum,
  fmtPct,
  fmtPctSigned,
  fmtPrice,
  fmtPts,
  fmtQty,
  fmtSigned,
  MINUS,
  pluralize,
} from '../src/ui/format';

describe('money', () => {
  it('formats exact below 10k and compact above', () => {
    expect(fmtMoney(1234.56)).toBe('¤1,234.56');
    expect(fmtMoney(0)).toBe('¤0.00');
    expect(fmtMoney(5.2)).toBe('¤5.20');
    expect(fmtMoney(12_300)).toBe('¤12.3k');
    expect(fmtMoney(4_500_000)).toBe('¤4.5M');
    expect(fmtMoney(1_200_000_000)).toBe('¤1.2B');
    expect(fmtMoney(-12_300)).toBe(MINUS + '¤12.3k');
    expect(fmtMoney(0.045)).toBe('¤0.045');
  });
  it('rounds across the cents boundary correctly', () => {
    expect(fmtMoney(9.999)).toBe('¤10.00');
    expect(fmtMoney(999.996)).toBe('¤1,000.00');
    expect(fmtMoney(-0.001)).toBe(MINUS + '¤0.001');
    expect(fmtMoneyFull(-0.004)).toBe('¤0.00');
    expect(fmtMoneyFull(1234567.891)).toBe('¤1,234,567.89');
  });
  it('never prints NaN or Infinity', () => {
    for (const f of [fmtMoney, fmtMoneyShort, fmtMoneyFull, fmtPrice, fmtPct, fmtNum, fmtQty, fmtInt, fmtIndex, fmtCompact]) {
      expect(f(NaN)).toBe('—');
      expect(f(Infinity)).toBe('—');
      expect(f(undefined as unknown as number)).toBe('—');
    }
  });
  it('short and price forms', () => {
    expect(fmtMoneyShort(950)).toBe('¤950');
    expect(fmtMoneyShort(5.2)).toBe('¤5.20');
    expect(fmtMoneyShort(12_345)).toBe('¤12.3k');
    expect(fmtPrice(1250)).toBe('¤1,250');
    expect(fmtPrice(3.456)).toBe('¤3.46');
    expect(fmtMoneyDelta(1200)).toBe('+¤1,200.00');
    expect(fmtMoneyDelta(-40)).toBe(MINUS + '¤40.00');
  });
});

describe('percent & numbers', () => {
  it('percent of fractions', () => {
    expect(fmtPct(0.052)).toBe('5.2%');
    expect(fmtPct(0.12)).toBe('12%');
    expect(fmtPct(-0.004)).toBe(MINUS + '0.4%');
    expect(fmtPct(0.00001)).toBe('0.0%');
    expect(fmtPct(0.05, 2)).toBe('5.00%');
    expect(fmtPctSigned(0.031)).toBe('+3.1%');
    expect(fmtPctSigned(-0.004)).toBe(MINUS + '0.4%');
    expect(fmtPctSigned(0)).toBe('0.0%');
    expect(fmtPts(0.012)).toBe('+1.2 pts');
    expect(fmtPts(-0.0001)).toBe('0.0 pts');
  });
  it('plain numbers', () => {
    expect(fmtNum(1234)).toBe('1,234');
    expect(fmtNum(12.5)).toBe('12.5');
    expect(fmtNum(0.25)).toBe('0.25');
    expect(fmtNum(1234.5, 1)).toBe('1,234.5');
    expect(fmtNum(-3.5)).toBe(MINUS + '3.5');
    expect(fmtQty(150_000)).toBe('150k');
    expect(fmtInt(-1234.4)).toBe(MINUS + '1,234');
    expect(fmtSigned(12)).toBe('+12');
    expect(fmtSigned(-3.5)).toBe(MINUS + '3.5');
    expect(fmtSigned(0)).toBe('0');
    expect(fmtCompact(4_500_000)).toBe('4.5M');
  });
});

describe('dates', () => {
  it('day index to calendar labels', () => {
    // day 0 = Year 1, Thaw 1; 360-day years, 30-day months
    expect(fmtDay(0)).toBe('Y1 · Thaw 1');
    expect(fmtDay(360 * 2 + 8 * 30 + 11)).toBe('Y3 · Frost 12');
    expect(fmtDayLong(360 * 2 + 8 * 30 + 11)).toBe('Frost 12, Year 3');
    expect(fmtDayTick(720)).toBe('Y3');
    expect(fmtDayTick(720 + 150)).toBe('Y3 M6');
    expect(fmtDayTick(720 + 155)).toBe('M6 D6');
  });
  it('durations', () => {
    expect(fmtDuration(1)).toBe('1 day');
    expect(fmtDuration(12)).toBe('12 days');
    expect(fmtDuration(60)).toBe('2 months');
    expect(fmtDuration(540)).toBe('1.5 years');
  });
  it('plurals of unit words', () => {
    expect(pluralize('loaf')).toBe('loaves');
    expect(pluralize('basket')).toBe('baskets');
    expect(pluralize('cask')).toBe('casks');
    expect(pluralize('piece')).toBe('pieces');
    expect(pluralize('box')).toBe('boxes');
  });
});
