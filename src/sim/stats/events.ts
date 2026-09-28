// ============================================================================
// News and random events. OWNER: stats agent.
// ============================================================================
import type { NewsKind, SimState } from '../types';

/** Append a news item (capped to NEWS_CAP). */
export function news(s: SimState, text: string, kind: NewsKind = 'info', town = -1): void {
  s.news.push({ day: s.day, text, kind, town });
  if (s.news.length > 300) s.news.splice(0, s.news.length - 300);
}

/**
 * Morning: count down town.droughtDays / strikeDays; if settings.events, roll random
 * events (≈ yearly each): drought in a farming town (60 days), fish scarcity, a mine
 * accident (a mine's tools destroyed), world price shocks (foreign.shocks: oil ×1.8,
 * grain ×0.7 …, 90–180 days), bumper harvest. Each with a news item.
 */
export function beginDayEvents(s: SimState): void {
  // TODO(stats)
}

/**
 * Evening: unrest — if town.contentment < UNREST_CONTENT for UNREST_DAYS → strike
 * (strikeDays = STRIKE_DAYS) with news; notable-market news (shortages, price swings
 * > 25 % in a month, bankruptcies are reported by their modules), milestone news.
 */
export function eventsStep(s: SimState): void {
  // TODO(stats)
}
