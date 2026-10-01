// ============================================================================
// Number, money and date formatting for the UI. Pure functions (no DOM), so
// they are unit-tested and safe to call in hot refresh paths.
//
// Conventions:
//   money      ¤1,234.56 · ¤12.3k · ¤4.5M · ¤1.2B   (−¤12.3k for negatives)
//   percent    fractions in, "5.2%" out (0.052 → "5.2%")
//   signed     "+3.1%" / "−0.4%" (true minus sign U+2212)
//   dates      day index → "Y3 · Frost 12" (calendar.ts: 30-day months, 360-day years)
//   non-finite values render as an em dash "—"
// ============================================================================
import { DAYS_PER_MONTH, DAYS_PER_YEAR } from '../sim/config';
import { dayOfMonth, MONTH_NAMES, monthOf, SEASONS, seasonOf, yearOf } from '../sim/calendar';

export const MINUS = '−';
export const DASH = '—';
export const CURRENCY = '¤';

function bad(x: number | null | undefined): boolean {
  return x === null || x === undefined || !Number.isFinite(x);
}

/** Thousands separators on a non-negative integer string/number. */
export function commas(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Trim trailing zeros of a fixed-point string: "12.50" → "12.5", "3.00" → "3". */
function trimZeros(t: string): string {
  return t.indexOf('.') >= 0 ? t.replace(/\.?0+$/, '') : t;
}

/** Compact magnitude: 950 → "950", 12_300 → "12.3k", 4_500_000 → "4.5M". No sign handling. */
function compactAbs(a: number, digits = 1): string {
  if (a >= 1e12) return trimZeros((a / 1e12).toFixed(digits)) + 'T';
  if (a >= 1e9) return trimZeros((a / 1e9).toFixed(digits)) + 'B';
  if (a >= 1e6) return trimZeros((a / 1e6).toFixed(digits)) + 'M';
  if (a >= 1e4) return trimZeros((a / 1e3).toFixed(digits)) + 'k';
  if (a >= 1000) return commas(a);
  if (a >= 100) return a.toFixed(0);
  if (a >= 10) return trimZeros(a.toFixed(1));
  if (a >= 1) return trimZeros(a.toFixed(2));
  if (a === 0) return '0';
  return trimZeros(a.toPrecision(2));
}

/**
 * Money: exact-looking below ¤10k ("¤1,234.56", "¤0.045"), compact above
 * ("¤12.3k", "¤4.5M"). Negative values get a leading minus: "−¤12.3k".
 */
export function fmtMoney(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const a = Math.abs(v);
  let body: string;
  if (a >= 1e4) body = compactAbs(a, 1);
  else if (a >= 0.1 || a === 0) body = fixedCommas(a, 2);
  else body = trimZeros(a.toPrecision(2));
  return (v < 0 && body !== '0.00' ? MINUS : '') + CURRENCY + body;
}

/** Fixed decimals with thousands separators, rounding correctly across the integer boundary. */
function fixedCommas(a: number, digits: number): string {
  const f = 10 ** digits;
  const scaled = Math.round(a * f);
  const whole = Math.floor(scaled / f);
  if (digits === 0) return commas(whole);
  return commas(whole) + '.' + (scaled % f).toString().padStart(digits, '0');
}

/** Money, always compact (tiles, axes): "¤950", "¤12.3k", "¤4.5M", "¤5.20" for small values. */
export function fmtMoneyShort(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const a = Math.abs(v);
  const body = a >= 1000 ? compactAbs(a, 1) : a >= 100 ? a.toFixed(0) : a >= 0.1 || a === 0 ? a.toFixed(2) : trimZeros(a.toPrecision(2));
  return (v < 0 ? MINUS : '') + CURRENCY + body;
}

/** Full precision money with commas and cents: "¤1,234,567.89". */
export function fmtMoneyFull(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const body = fixedCommas(Math.abs(v), 2);
  return (v < 0 && body !== '0.00' ? MINUS : '') + CURRENCY + body;
}

/** A price per unit: "¤5.20", "¤0.045", "¤1,250", "¤12.3k". */
export function fmtPrice(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const a = Math.abs(v);
  let body: string;
  if (a >= 1e4) body = compactAbs(a, 1);
  else if (a >= 1000) body = commas(a);
  else if (a >= 0.1 || a === 0) body = a.toFixed(2);
  else body = trimZeros(a.toPrecision(2));
  return (v < 0 ? MINUS : '') + CURRENCY + body;
}

/** Signed money delta: "+¤1.2k", "−¤40.00", "¤0.00". */
export function fmtMoneyDelta(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const s = fmtMoney(Math.abs(v));
  if (s === CURRENCY + '0.00') return s;
  return (v > 0 ? '+' : v < 0 ? MINUS : '') + s;
}

/**
 * Percent of a fraction: 0.052 → "5.2%". `digits` defaults to 1 below 10 %
 * and 0 above (so "12%" but "4.5%"); pass a number to force it.
 */
export function fmtPct(x: number | null | undefined, digits?: number): string {
  if (bad(x)) return DASH;
  const v = (x as number) * 100;
  const d = digits ?? (Math.abs(v) >= 10 ? 0 : 1);
  let t = Math.abs(v).toFixed(d);
  if (/^0\.?0*$/.test(t)) return (0).toFixed(d) + '%';
  return (v < 0 ? MINUS : '') + t + '%';
}

/** Signed percent: "+3.1%", "−0.4%", "0.0%". */
export function fmtPctSigned(x: number | null | undefined, digits?: number): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const body = fmtPct(Math.abs(v), digits);
  if (/^0(\.0*)?%$/.test(body)) return body;
  return (v > 0 ? '+' : v < 0 ? MINUS : '') + body;
}

/** Percentage points delta (fractions in): 0.012 → "+1.2 pts". */
export function fmtPts(x: number | null | undefined, digits = 1): string {
  if (bad(x)) return DASH;
  const v = (x as number) * 100;
  const t = Math.abs(v).toFixed(digits);
  if (Number(t) === 0) return (0).toFixed(digits) + ' pts';
  return (v > 0 ? '+' : MINUS) + t + ' pts';
}

/** A plain number with sensible precision: 1234 → "1,234", 12.5 → "12.5", 0.25 → "0.25". */
export function fmtNum(x: number | null | undefined, digits?: number): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const a = Math.abs(v);
  let body: string;
  if (digits !== undefined) {
    body = fixedCommas(a, digits);
  } else if (a >= 1000) body = commas(a);
  else if (a >= 100) body = a.toFixed(0);
  else if (a >= 10) body = trimZeros(a.toFixed(1));
  else if (a >= 0.01 || a === 0) body = trimZeros(a.toFixed(2));
  else body = trimZeros(a.toPrecision(2));
  return (v < 0 && Number(body.replace(/,/g, '')) !== 0 ? MINUS : '') + body;
}

/** Compact number without currency: 12_300 → "12.3k". */
export function fmtCompact(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  return (v < 0 ? MINUS : '') + compactAbs(Math.abs(v), 1);
}

/** Quantity of goods: "1,234", "12.5", "0.25", "12.3k" above 100k. */
export function fmtQty(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = x as number;
  if (Math.abs(v) >= 1e5) return fmtCompact(v);
  return fmtNum(v);
}

/** Integer with commas: "1,234". */
export function fmtInt(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  const v = Math.round(x as number);
  return (v < 0 ? MINUS : '') + commas(v);
}

/** Signed plain number: "+12", "−3.5". */
export function fmtSigned(x: number | null | undefined, fmt: (v: number) => string = fmtNum): string {
  if (bad(x)) return DASH;
  const v = x as number;
  const body = fmt(Math.abs(v));
  if (v === 0 || /^[^1-9]*$/.test(body)) return body;
  return (v > 0 ? '+' : MINUS) + body;
}

/** An index level (base 100): "104.2". */
export function fmtIndex(x: number | null | undefined): string {
  if (bad(x)) return DASH;
  return (x as number).toFixed(1);
}

/** Annual rate as a percent with one decimal always: 0.05 → "5.0%". */
export function fmtRate(x: number | null | undefined): string {
  return fmtPct(x, 1);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "Y3 · Frost 12" */
export function fmtDay(day: number): string {
  if (bad(day)) return DASH;
  return `Y${yearOf(day)} · ${MONTH_NAMES[monthOf(day)]} ${dayOfMonth(day)}`;
}

/** "Frost 12, Year 3" — long form for headers. */
export function fmtDayLong(day: number): string {
  if (bad(day)) return DASH;
  return `${MONTH_NAMES[monthOf(day)]} ${dayOfMonth(day)}, Year ${yearOf(day)}`;
}

/** "Y3 · Frost" — a month. */
export function fmtMonth(day: number): string {
  if (bad(day)) return DASH;
  return `Y${yearOf(day)} · ${MONTH_NAMES[monthOf(day)]}`;
}

/** Season name of a day ("Winter"). */
export function fmtSeason(day: number): string {
  if (bad(day)) return DASH;
  return SEASONS[seasonOf(day)];
}

/** Chart axis tick for a day: "Y3" on year starts, "Y3 M6" on month starts, "M6 D12" otherwise. */
export function fmtDayTick(day: number): string {
  if (bad(day)) return DASH;
  const d = Math.round(day);
  const y = yearOf(d);
  const m = monthOf(d) + 1;
  const dd = dayOfMonth(d);
  if (m === 1 && dd === 1) return `Y${y}`;
  if (dd === 1) return `Y${y} M${m}`;
  return `M${m} D${dd}`;
}

/** Duration in days, rounded to a readable unit: "3 days", "2 months", "1.5 years". */
export function fmtDuration(days: number): string {
  if (bad(days)) return DASH;
  const d = Math.abs(days);
  if (d < 1.5 && d >= 0.5) return '1 day';
  if (d < DAYS_PER_MONTH * 1.5) return `${Math.round(d)} days`;
  if (d < DAYS_PER_YEAR * 1.5) {
    const m = Math.round(d / DAYS_PER_MONTH);
    return m === 1 ? '1 month' : `${m} months`;
  }
  const y = d / DAYS_PER_YEAR;
  return `${trimZeros(y.toFixed(1))} years`;
}

/** "3 loaves"-style count with a naive plural. */
export function plural(n: number, word: string, pluralWord?: string): string {
  const one = Math.abs(n) === 1;
  return `${fmtNum(n)} ${one ? word : (pluralWord ?? pluralize(word))}`;
}

/** English plural of a unit word ("loaf" → "loaves", "basket" → "baskets"). */
export function pluralize(word: string): string {
  if (/(?:f|fe)$/.test(word) && !/(?:ff|oof)$/.test(word)) return word.replace(/fe?$/, 'ves');
  if (/(?:s|x|z|ch|sh)$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

/** Relative wall-clock time for save metadata: "just now", "5 min ago", "yesterday". */
export function fmtAgo(ms: number, now = Date.now()): string {
  if (bad(ms)) return DASH;
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return `${Math.round(s / 86400)} days ago`;
}

/** Bytes → "1.2 MB". */
export function fmtBytes(n: number): string {
  if (bad(n)) return DASH;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
