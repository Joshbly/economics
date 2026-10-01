// ============================================================================
// Headless runner: simulate a realm without the UI and print the indicators.
//
//   npm run sim -- [--years N] [--days N] [--seed N] [--scenario id]
//                  [--no-warmup] [--every N] [--json] [--strict]
//
//   --years / --days  length of the run after warm-up (added together; default 5 years)
//   --seed            world seed (default 1)
//   --scenario        scenario id (default: the world's default)
//   --warmup / --no-warmup  simulate WARMUP_DAYS silently first (default on)
//   --every N         print a row every N days (default 30)
//   --json            print the rows (and a summary) as JSON instead of a table
//   --strict          exit 2 if the baseline sanity bands of DESIGN §9 are violated
//   --load file       start from a saved game instead of a new world (no warm-up)
//   --save file       write the final state as a save file
//
// Every simulated day (warm-up included) is checked: any non-finite indicator in
// stats.latest, or a bank balance-sheet discrepancy |checkLedger| above
// 1e-6 × max(1, money), prints the error and exits with code 1.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { WARMUP_DAYS } from '../src/sim/config';
import { dayOfMonth, monthOf, yearOf } from '../src/sim/calendar';
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import { checkLedger, deposits } from '../src/sim/ledger';
import { rebaseStats } from '../src/sim/stats/stats';
import type { SimState } from '../src/sim/types';

interface Opts {
  days: number;
  seed: number;
  scenario?: string;
  warmup: boolean;
  every: number;
  json: boolean;
  strict: boolean;
  load?: string;
  save?: string;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { days: 0, seed: 1, warmup: true, every: 30, json: false, strict: false };
  let years = -1;
  let days = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value after ${a}`);
      return v;
    };
    const num = (): number => {
      const v = Number(next());
      if (!Number.isFinite(v)) fail(`${a} needs a number`);
      return v;
    };
    switch (a) {
      case '--years':
        years = num();
        break;
      case '--days':
        days = num();
        break;
      case '--seed':
        o.seed = Math.floor(num());
        break;
      case '--scenario':
        o.scenario = next();
        break;
      case '--warmup':
        o.warmup = true;
        break;
      case '--no-warmup':
        o.warmup = false;
        break;
      case '--every':
        o.every = Math.max(1, Math.floor(num()));
        break;
      case '--json':
        o.json = true;
        break;
      case '--strict':
        o.strict = true;
        break;
      case '--load':
        o.load = next();
        break;
      case '--save':
        o.save = next();
        break;
      case '--help':
      case '-h':
        console.log('usage: npm run sim -- [--years N] [--days N] [--seed N] [--scenario id] [--no-warmup] [--every N] [--json] [--strict] [--load file] [--save file]');
        process.exit(0);
        break;
      default:
        fail(`unknown option ${a}`);
    }
  }
  const y = years >= 0 ? years : days >= 0 ? 0 : 5;
  o.days = Math.max(0, Math.round(y * 360 + Math.max(0, days)));
  return o;
}

function fail(msg: string): never {
  console.error(`headless: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
/** Returns an error message if today's state is broken, else null. */
function checkDay(s: SimState): string | null {
  const bad: string[] = [];
  for (const k in s.stats.latest) {
    const v = s.stats.latest[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) bad.push(`${k}=${String(v)}`);
  }
  if (bad.length) return `non-finite indicators: ${bad.slice(0, 12).join(', ')}${bad.length > 12 ? ' …' : ''}`;
  const money = deposits(s);
  const err = checkLedger(s);
  if (!Number.isFinite(err) || Math.abs(err) > 1e-6 * Math.max(1, Math.abs(money))) return `bank ledger out of balance by ${err} (money ${money.toFixed(2)})`;
  return null;
}

function stepChecked(s: SimState, phase: string): void {
  try {
    stepDay(s);
  } catch (e) {
    console.error(`headless: crash on day ${s.day} (${phase}): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  }
  const err = checkDay(s);
  if (err) {
    console.error(`headless: day ${s.day - 1} (${phase}): ${err}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function compact(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'G';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (x / 1e3).toFixed(1) + 'k';
  if (a >= 100) return x.toFixed(0);
  return x.toFixed(1);
}
const pct = (x: number, d = 1): string => (100 * x).toFixed(d);

interface Col {
  h: string;
  w: number;
  f: (s: SimState) => string;
  v: (s: SimState) => number;
}

const L = (s: SimState, k: string): number => s.stats.latest[k] ?? 0;

const COLS: Col[] = [
  { h: 'date', w: 12, f: (s) => dateShort(s.day - 1), v: (s) => s.day - 1 },
  { h: 'CPI', w: 7, f: (s) => L(s, 'cpi').toFixed(1), v: (s) => L(s, 'cpi') },
  { h: 'infl%', w: 6, f: (s) => pct(L(s, 'infl30')), v: (s) => L(s, 'infl30') },
  { h: 'yoy%', w: 6, f: (s) => pct(L(s, 'inflYoY')), v: (s) => L(s, 'inflYoY') },
  { h: 'unemp%', w: 6, f: (s) => pct(L(s, 'unemp')), v: (s) => L(s, 'unemp') },
  { h: 'gdpReal', w: 8, f: (s) => compact(L(s, 'gdpReal')), v: (s) => L(s, 'gdpReal') },
  { h: 'wage', w: 6, f: (s) => L(s, 'wage').toFixed(2), v: (s) => L(s, 'wage') },
  { h: 'money', w: 7, f: (s) => compact(L(s, 'money')), v: (s) => L(s, 'money') },
  { h: 'credit', w: 7, f: (s) => compact(L(s, 'credit')), v: (s) => L(s, 'credit') },
  { h: 'loan%', w: 5, f: (s) => pct(L(s, 'loanRate')), v: (s) => L(s, 'loanRate') },
  { h: 'purse', w: 7, f: (s) => compact(L(s, 'purse')), v: (s) => L(s, 'purse') },
  { h: 'pop', w: 5, f: (s) => L(s, 'pop').toFixed(0), v: (s) => L(s, 'pop') },
  { h: 'hung%', w: 5, f: (s) => pct(L(s, 'hunger')), v: (s) => L(s, 'hunger') },
  { h: 'hmls', w: 4, f: (s) => L(s, 'homeless').toFixed(0), v: (s) => L(s, 'homeless') },
  { h: 'firms', w: 5, f: (s) => L(s, 'firms').toFixed(0), v: (s) => L(s, 'firms') },
  { h: 'freight', w: 7, f: (s) => L(s, 'freight').toFixed(3), v: (s) => L(s, 'freight') },
  { h: 'gold', w: 6, f: (s) => L(s, 'goldPrice').toFixed(1), v: (s) => L(s, 'goldPrice') },
];

function dateShort(day: number): string {
  const d = Math.max(0, day);
  return `Y${yearOf(d)} M${String(monthOf(d) + 1).padStart(2, '0')} D${String(dayOfMonth(d)).padStart(2, '0')}`;
}

function header(): string {
  return COLS.map((c) => c.h.padStart(c.w)).join(' ') + '   ms/day';
}

function row(s: SimState, msPerDay: number): string {
  return COLS.map((c) => c.f(s).padStart(c.w)).join(' ') + '   ' + msPerDay.toFixed(2).padStart(6);
}

function rowObj(s: SimState, msPerDay: number): Record<string, number | string> {
  const r: Record<string, number | string> = { day: s.day - 1, date: dateShort(s.day - 1) };
  const keys = ['cpi', 'infl30', 'inflYoY', 'unemp', 'gdpReal', 'gdpNominal', 'wage', 'realWage', 'money', 'credit', 'loanRate', 'depRate', 'purse', 'pop', 'hunger', 'homeless', 'firms', 'freight', 'goldPrice', 'iouPrice', 'bankEquity', 'capRatio', 'content', 'health'];
  for (const k of keys) r[k] = L(s, k);
  r.msPerDay = Math.round(msPerDay * 100) / 100;
  return r;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const log = (msg: string) => {
    if (o.json) console.error(msg);
    else console.log(msg);
  };
  const t0 = performance.now();
  let game: Game;
  try {
    game = o.load ? Game.load(readFileSync(o.load, 'utf8')) : Game.create({ seed: o.seed, scenario: o.scenario, warmup: false });
  } catch (e) {
    fail(`${o.load ? 'loading ' + o.load : 'world creation'} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  if (o.load) o.warmup = false;
  const s = game.s;
  if (!s || !Array.isArray(s.people)) fail('world creation returned no state');
  const tCreate = performance.now() - t0;
  const err0 = checkDay(s);
  if (err0) fail(`fresh world: ${err0}`);
  const realm = s.settings?.realmName ?? 'The Realm';
  log(`${realm} · ${o.load ? 'loaded ' + o.load + ' (day ' + s.day + ')' : 'seed ' + o.seed} · scenario ${s.settings?.scenario ?? '?'} · ${s.people.filter((p) => p && p.alive).length} households, ${s.firms.filter((f) => f && f.alive).length} firms · ${o.load ? 'loaded' : 'created'} in ${tCreate.toFixed(0)} ms`);

  // Warm-up exactly as Game.create does it, but with the daily checks.
  if (o.warmup) {
    const tw = performance.now();
    for (let i = 0; i < WARMUP_DAYS; i++) stepChecked(s, 'warm-up');
    rebaseStats(s);
    const ms = performance.now() - tw;
    log(`warm-up: ${WARMUP_DAYS} days in ${(ms / 1000).toFixed(2)} s (${(ms / WARMUP_DAYS).toFixed(2)} ms/day); indices re-based to 100 on day ${s.day}`);
  }

  const startCpi = L(s, 'cpi') || 100;
  const startPop = s.people.filter((p) => p && p.alive).length;
  const rows: Record<string, number | string>[] = [];
  if (!o.json) console.log(header());
  let tInt = performance.now();
  let nInt = 0;
  let totalMs = 0;
  let maxMs = 0;
  let maxUnemp = 0;
  let minCpi = Infinity;
  let maxCpi = -Infinity;
  let minPop = Infinity;
  for (let d = 1; d <= o.days; d++) {
    const ts = performance.now();
    stepChecked(s, 'run');
    const dt = performance.now() - ts;
    totalMs += dt;
    if (dt > maxMs) maxMs = dt;
    nInt++;
    maxUnemp = Math.max(maxUnemp, L(s, 'unemp'));
    minCpi = Math.min(minCpi, L(s, 'cpi'));
    maxCpi = Math.max(maxCpi, L(s, 'cpi'));
    minPop = Math.min(minPop, L(s, 'pop'));
    if (d % o.every === 0 || d === o.days) {
      const ms = (performance.now() - tInt) / Math.max(1, nInt);
      if (o.json) rows.push(rowObj(s, ms));
      else console.log(row(s, ms));
      tInt = performance.now();
      nInt = 0;
    }
  }

  // ---- summary & baseline sanity (DESIGN §9) ----
  const endCpi = L(s, 'cpi');
  const endPop = L(s, 'pop');
  const endUnemp = L(s, 'unemp');
  const ratio = endCpi / Math.max(1e-9, startCpi);
  const checks: [string, boolean][] = [
    [`CPI ×${ratio.toFixed(2)} of start (band ×0.6–×1.8)`, ratio >= 0.6 && ratio <= 1.8],
    [`unemployment ${pct(endUnemp)} % at the end (< 15 %)`, endUnemp < 0.15],
    [`population ${endPop.toFixed(0)} vs ${startPop} at start (> 80 %)`, endPop > 0.8 * startPop],
  ];
  const ok = checks.every(([, p]) => p);
  const avg = o.days > 0 ? totalMs / o.days : 0;
  if (o.json) {
    console.log(
      JSON.stringify(
        {
          seed: o.seed,
          scenario: s.settings?.scenario,
          days: o.days,
          warmup: o.warmup,
          msPerDay: Math.round(avg * 100) / 100,
          maxMsPerDay: Math.round(maxMs * 100) / 100,
          rows,
          checks: checks.map(([name, pass]) => ({ name, pass })),
          sane: ok,
        },
        null,
        1,
      ),
    );
  } else if (o.days > 0) {
    console.log('');
    console.log(`${o.days} days in ${(totalMs / 1000).toFixed(2)} s — ${avg.toFixed(2)} ms/day on average, slowest day ${maxMs.toFixed(1)} ms`);
    console.log(`range: CPI ${minCpi.toFixed(1)}–${maxCpi.toFixed(1)}, max unemployment ${pct(maxUnemp)} %, min population ${minPop.toFixed(0)}`);
    for (const [name, pass] of checks) console.log(`  ${pass ? 'ok  ' : 'WARN'} ${name}`);
    const news = s.news.slice(-8);
    if (news.length) {
      console.log('latest news:');
      for (const n of news) console.log(`  [${dateShort(n.day)}] ${n.text}`);
    }
  }
  if (o.save) {
    writeFileSync(o.save, game.save());
    log(`saved day ${s.day} to ${o.save}`);
  }
  if (o.strict && !ok) process.exit(2);
}

main();
