// ============================================================================
// Economy health check across seeds — the calibration objective.
//   npx tsx scripts/health.ts [--seeds 1,2,3] [--days 720] [--warmup]
// Prints per seed: unemployment (mean/min/max over the second half), CPI ratio,
// population ratio, hunger, carters' share of employment, bankruptcies, and the
// share of workers in each sector at the end.
// ============================================================================
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import type { SimState } from '../src/sim/types';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const seeds = opt('seeds', '1,2,3').split(',').map(Number);
const days = Number(opt('days', '720'));
const warm = argv.includes('--warmup');

function snapshot(s: SimState) {
  const alive = s.people.filter((p) => p.alive);
  const unemp = alive.filter((p) => p.job < 0).length / Math.max(1, alive.length);
  let traders = 0;
  let employed = 0;
  for (const f of s.firms) {
    if (!f.alive) continue;
    employed += f.workers.length;
    if (f.sector === 'trader') traders += f.workers.length;
  }
  const hungry = alive.filter((p) => p.foodSat < 0.7).length / Math.max(1, alive.length);
  return { pop: alive.length, unemp, traders: traders / Math.max(1, employed), hungry, cpi: s.stats.latest.cpi ?? 100 };
}

const rows: string[] = [];
for (const seed of seeds) {
  const t0 = performance.now();
  const g = Game.create({ seed, warmup: warm });
  const s = g.s;
  const start = snapshot(s);
  const cpi0 = s.stats.latest.cpi || 100;
  const un: number[] = [];
  const hu: number[] = [];
  let bankrupt = 0;
  let cpiMin = 1e9;
  let cpiMax = 0;
  for (let d = 0; d < days; d++) {
    stepDay(s);
    bankrupt += s.stats.acc.bankruptcies || 0;
    if (d >= days / 2) {
      const sn = snapshot(s);
      un.push(sn.unemp);
      hu.push(sn.hungry);
      cpiMin = Math.min(cpiMin, sn.cpi);
      cpiMax = Math.max(cpiMax, sn.cpi);
    }
  }
  const end = snapshot(s);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const bySec: Record<string, number> = {};
  let emp = 0;
  for (const f of s.firms) if (f.alive) {
    bySec[f.sector] = (bySec[f.sector] || 0) + f.workers.length;
    emp += f.workers.length;
  }
  const secStr = Object.entries(bySec)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k.slice(0, 5)}${Math.round((100 * v) / Math.max(1, emp))}`)
    .join(' ');
  const ms = (performance.now() - t0) / days;
  rows.push(
    `seed ${seed}: unemp ${(100 * mean(un)).toFixed(1)}% [${(100 * Math.min(...un)).toFixed(0)}–${(100 * Math.max(...un)).toFixed(0)}] ` +
      `CPI ×${(end.cpi / cpi0).toFixed(2)} [${(cpiMin / cpi0).toFixed(2)}–${(cpiMax / cpi0).toFixed(2)}] pop ${start.pop}→${end.pop} ` +
      `hungry ${(100 * mean(hu)).toFixed(1)}% carters ${(100 * end.traders).toFixed(0)}% bankrupt ${bankrupt} ${ms.toFixed(1)}ms/d\n    ${secStr}`,
  );
  console.log(rows[rows.length - 1]);
}
