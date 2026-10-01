// Calendar & seasons. Day 0 = first day of spring, year 1.
import { DAYS_PER_MONTH, DAYS_PER_YEAR, HEAT_AMP, HEAT_MEAN } from './config';

export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const MONTH_NAMES = [
  'Thaw', 'Seedtime', 'Blossom', 'Highsun', 'Harvest', 'Goldleaf',
  'Reaping', 'Fallow', 'Frost', 'Deepwinter', 'Icefall', 'Wane',
];

export function dayOfYear(day: number): number {
  return ((Math.floor(day) % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
}
export function yearOf(day: number): number {
  return Math.floor(day / DAYS_PER_YEAR) + 1;
}
export function monthOf(day: number): number {
  return Math.floor(dayOfYear(day) / DAYS_PER_MONTH);
}
export function dayOfMonth(day: number): number {
  return (dayOfYear(day) % DAYS_PER_MONTH) + 1;
}
export function seasonOf(day: number): number {
  return Math.floor(dayOfYear(day) / 90);
}
/** True on the first day of each month. */
export function isMonthStart(day: number): boolean {
  return dayOfYear(day) % DAYS_PER_MONTH === 0;
}
/** True on the last day of each month. */
export function isMonthEnd(day: number): boolean {
  return dayOfYear(day) % DAYS_PER_MONTH === DAYS_PER_MONTH - 1;
}

const TAU = Math.PI * 2;

/** Farm output multiplier: mean 1, peak late summer (~1.6), trough in winter (~0.4). */
export function farmSeason(day: number): number {
  return 1 + 0.6 * Math.sin((TAU * (dayOfYear(day) - 45)) / DAYS_PER_YEAR);
}
/** Fishery multiplier: mean 1, mild seasonality. */
export function fishSeason(day: number): number {
  return 1 + 0.2 * Math.sin((TAU * (dayOfYear(day) - 45)) / DAYS_PER_YEAR);
}
/** Coal needed per person per day for heating (peaks mid-winter). */
export function heatNeed(day: number): number {
  return HEAT_MEAN * (1 + HEAT_AMP * Math.cos((TAU * (dayOfYear(day) - 315)) / DAYS_PER_YEAR));
}
export function seasonFactor(kind: 'none' | 'farm' | 'fish', day: number): number {
  return kind === 'farm' ? farmSeason(day) : kind === 'fish' ? fishSeason(day) : 1;
}

export function dateLabel(day: number): string {
  return `Year ${yearOf(day)}, ${MONTH_NAMES[monthOf(day)]} ${dayOfMonth(day)}`;
}
export function seasonLabel(day: number): string {
  return SEASONS[seasonOf(day)];
}
