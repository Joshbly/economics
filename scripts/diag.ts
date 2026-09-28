// ============================================================================
// Diagnostic dump for calibration: where the money is, who works where, what
// is produced vs eaten, prices by town, trade flows.
//   npx tsx scripts/diag.ts --days 360 --every 30 --seed 1 [--warmup] [--section money,jobs,goods,prices,trade]
// ============================================================================
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import { GOODS, G, N_GOODS, PRODUCER_SECTORS, ALL_SECTORS } from '../src/sim/goods';
import { dayOfMonth, monthOf, yearOf } from '../src/sim/calendar';
import type { SimState } from '../src/sim/types';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const days = Number(opt('days', '360'));
const every = Number(opt('every', '30'));
const seed = Number(opt('seed', '1'));
const warm = argv.includes('--warmup');
const sections = new Set(opt('section', 'money,jobs,goods,prices,trade').split(','));

const g = Game.create({ seed, warmup: warm });
const s = g.s;

const fmt = (x: number, w = 7) => {
  const a = Math.abs(x);
  const t = a >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (x / 1e3).toFixed(0) + 'k' : a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2);
  return t.padStart(w);
};
const median = (v: number[]) => {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

// accumulate some flows between prints
const accum: Record<string, number> = {};
function addAcc() {
  for (const [k, v] of Object.entries(s.stats.acc)) accum[k] = (accum[k] || 0) + (v as number);
}

function date(s: SimState) {
  return `Y${yearOf(s.day)}M${String(monthOf(s.day) + 1).padStart(2, '0')}D${String(dayOfMonth(s.day)).padStart(2, '0')}`;
}

function report() {
  const alive = s.people.filter((p) => p.alive);
  const owners = alive.filter((p) => p.owns.length || p.houses.length);
  const workers = alive.filter((p) => !(p.owns.length || p.houses.length));
  const n = every;
  console.log(`\n===== ${date(s)} day ${s.day}  pop ${alive.length}  (owners ${owners.length})`);
  if (sections.has('money')) {
    const firmsBySec: Record<string, number> = {};
    for (const f of s.firms) if (f.alive) firmsBySec[f.sector] = (firmsBySec[f.sector] || 0) + f.cash;
    const wc = workers.map((p) => p.cash);
    console.log(
      `money: workers Σ${fmt(wc.reduce((a, b) => a + b, 0))} med ${fmt(median(wc))} | owners Σ${fmt(owners.reduce((a, p) => a + p.cash, 0))} | firms Σ${fmt(Object.values(firmsBySec).reduce((a, b) => a + b, 0))} | foreign ${fmt(s.foreign.coin)} | purse ${fmt(s.treasury.purse)} | bankEq ${fmt(s.bank.equity)} | loans ${fmt(s.loans.reduce((a, l) => a + (l.active ? l.principal : 0), 0))}`,
    );
    console.log('  firm cash by sector: ' + Object.entries(firmsBySec).map(([k, v]) => `${k} ${fmt(v, 0)}`).join(', '));
    const inc = workers.map((p) => p.income);
    const bud = workers.map((p) => p.budget);
    console.log(`  worker income med ${fmt(median(inc))} budget med ${fmt(median(bud))} | owner income med ${fmt(median(owners.map((p) => p.income)))} budget med ${fmt(median(owners.map((p) => p.budget)))}`);
    const per = (k: string) => (accum[k] || 0) / n;
    console.log(`  per day: wages ${fmt(per('wages'))} dividends ${fmt(per('dividends'))} consval ${fmt(per('consval'))} rent ${fmt(per('flow_rent'))} interest ${fmt(per('flow_interest'))} build ${fmt(per('flow_build'))} imports ${fmt(per('impval'))} exports ${fmt(per('expval'))} migrate ${fmt(per('flow_migrate'))}`);
  }
  if (sections.has('jobs')) {
    const rows: string[] = [];
    for (const sec of ALL_SECTORS) {
      const fs = s.firms.filter((f) => f.alive && f.sector === sec && f.status === 'active');
      if (!fs.length) continue;
      const w = fs.reduce((a, f) => a + f.workers.length, 0);
      const t = fs.reduce((a, f) => a + f.target, 0);
      const c = fs.reduce((a, f) => a + f.capacity, 0);
      const wage = fs.reduce((a, f) => a + f.wage * f.workers.length, 0) / Math.max(1, w);
      rows.push(`${sec}:${fs.length}f ${w}/${t.toFixed(0)}/${c} w${wage.toFixed(1)}`);
    }
    const unemp = alive.filter((p) => p.job < 0).length;
    console.log(`jobs: unemployed ${unemp} (${((100 * unemp) / Math.max(1, alive.length)).toFixed(1)}%)  [workers/target/capacity]`);
    console.log('  ' + rows.join(' | '));
  }
  if (sections.has('goods')) {
    const line: string[] = [];
    for (let gd = 0; gd < N_GOODS; gd++) {
      const prod = (accum['prod_' + gd] || 0) / n;
      const cons = (accum['cons_' + gd] || 0) / n;
      const vol = (accum['vol_' + gd] || 0) / n;
      const stock = s.firms.reduce((a, f) => a + (f.alive ? f.inv[gd] : 0), 0);
      line.push(`${GOODS[gd].key} p${fmt(prod, 0)} c${fmt(cons, 0)} v${fmt(vol, 0)} st${fmt(stock, 0)}`);
    }
    console.log('goods/day: ' + line.join(' | '));
    const ate = (accum['eaten_bread'] || 0) / n + (accum['eaten_fish'] || 0) / n;
    console.log(`  food eaten/day ${fmt(ate)} per cap ${(ate / Math.max(1, alive.length)).toFixed(2)} | hungry/day ${fmt((accum['hungry'] || 0) / n)} | emigrants ${accum['emigrants'] || 0} deaths ${accum['deaths'] || 0} births ${accum['births'] || 0} immig ${accum['immigrants'] || 0} | bankruptcies ${accum['bankruptcies'] || 0} exits ${accum['exits'] || 0} entry ${accum['entry_projects'] || 0}`);
  }
  if (sections.has('prices')) {
    const goods = [G.bread, G.fish, G.grain, G.coal, G.wood, G.oil, G.iron, G.tools, G.ale, G.furniture];
    console.log('prices (base) ' + goods.map((x) => GOODS[x].key.padStart(6)).join(''));
    for (const t of s.towns) {
      const vals = goods.map((gd) => fmt(s.markets[t.id * N_GOODS + gd].ema, 6));
      console.log(`  ${t.name.padEnd(12).slice(0, 12)} ${vals.join('')}  pop ${t.pop} unemp ${t.unemployed} hungry? health ${t.health.toFixed(2)}`);
    }
  }
  if (sections.has('trade')) {
    const tr = s.firms.filter((f) => f.alive && f.sector === 'trader');
    console.log('trade: ' + tr.map((f) => `${s.towns[f.town].name.slice(0, 8)} wag ${f.trade!.wagons} busy ${f.trade!.busy.length} drv ${f.workers.length} oil ${f.inv[G.oil].toFixed(0)}`).join(' | '));
    console.log(`  shipped/day ${fmt((accum['shipped_units'] || 0) / n)} delivered/day ${fmt((accum['delivered_units'] || 0) / n)} in transit ${s.shipments.length}`);
  }
  for (const k of Object.keys(accum)) delete accum[k];
}

report();
for (let d = 1; d <= days; d++) {
  stepDay(s);
  addAcc();
  if (d % every === 0) report();
}
