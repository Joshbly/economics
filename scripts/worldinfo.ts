// Print a summary of a freshly generated world and an ASCII map.
//   npx tsx scripts/worldinfo.ts [--seed 1] [--scenario founding] [--no-map] [--flows]
import { GOODS, N_GOODS, SECTORS } from '../src/sim/goods';
import { checkLedger, deposits, loansOutstanding } from '../src/sim/ledger';
import { Terrain, type SimState } from '../src/sim/types';
import { calibrationOf, createWorld } from '../src/sim/world/init';
import { routeBetweenTowns } from '../src/sim/world/paths';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const has = (k: string) => args.includes('--' + k);
const seed = Number(opt('seed', '1'));
const scenario = opt('scenario', 'founding');

const t0 = performance.now();
const s = createWorld({ seed, scenario });
const ms = performance.now() - t0;

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const pad = (x: string | number, n: number) => String(x).padStart(n);
const padR = (x: string | number, n: number) => String(x).padEnd(n);

console.log(`${s.settings.realmName} — seed ${seed}, scenario ${s.settings.scenario} (created in ${ms.toFixed(0)} ms)`);
console.log('');

// ---- towns ----
console.log('Towns');
for (const t of s.towns) {
  const houses = s.buildings.filter((b) => b && b.kind === 'house' && b.town === t.id && b.status === 'active');
  console.log(
    `  ${padR(t.name, 14)} ${padR(t.kind, 8)} at (${pad(t.x, 3)},${pad(t.y, 3)}) r=${f1(t.radius)}  pop ${pad(t.pop, 4)}  employed ${pad(t.employed, 4)}  unemployed ${pad(t.unemployed, 3)}  homeless ${pad(t.homeless, 3)}  houses ${pad(houses.length, 3)} (vacant slots ${t.vacantSlots}, rent ${f2(t.avgRent)})`,
  );
}
console.log('');

// ---- routes ----
console.log('Routes (tiles / days, dirt · paved · off-road)');
for (let a = 0; a < s.towns.length; a++) {
  for (let b = a + 1; b < s.towns.length; b++) {
    const r = routeBetweenTowns(s, a, b);
    console.log(`  ${padR(s.towns[a].name + ' – ' + s.towns[b].name, 30)} ${pad(f1(r.length), 6)} tiles ${pad(f2(r.days), 5)} d   (${f1(r.dirt)} · ${f1(r.paved)} · ${f1(r.offroad)})`);
  }
}
console.log('');

// ---- firms ----
console.log('Firms per sector (count / workers / output per day)');
const header = '  ' + padR('sector', 12) + s.towns.map((t) => pad(t.name.slice(0, 12), 18)).join('');
console.log(header);
for (const sec of Object.keys(SECTORS) as (keyof typeof SECTORS)[]) {
  const cells = s.towns.map((t) => {
    const fs = s.firms.filter((f) => f && f.alive && f.sector === sec && f.town === t.id);
    if (!fs.length) return pad('·', 18);
    const w = fs.reduce((a, f) => a + f.workers.length, 0);
    const o = fs.reduce((a, f) => a + f.output, 0);
    return pad(`${fs.length} / ${w} / ${o > 0 ? f1(o) : '-'}`, 18);
  });
  console.log('  ' + padR(sec, 12) + cells.join(''));
}
const traders = s.firms.filter((f) => f && f.sector === 'trader');
console.log('  wagons      ' + s.towns.map((t) => pad(String(traders.find((f) => f.town === t.id)?.trade?.wagons ?? 0), 18)).join(''));
console.log('');

// ---- prices ----
console.log('Prices (¤, base) by town');
console.log('  ' + padR('good', 10) + s.towns.map((t) => pad(t.name.slice(0, 12), 13)).join('') + pad('world(¤)', 11) + pad('shipCap', 9));
for (let g = 0; g < N_GOODS; g++) {
  const row = s.towns.map((t) => pad(f2(s.markets[t.id * N_GOODS + g].price), 13)).join('');
  const w = s.foreign.world[g] > 0 ? f2(s.foreign.world[g] * s.goldMarket.price) : '-';
  console.log('  ' + padR(GOODS[g].key, 10) + row + pad(w, 11) + pad(s.foreign.shipCap[g] > 0 ? f1(s.foreign.shipCap[g]) : '-', 9));
}
console.log('');

// ---- money ----
const b = s.bank;
const people = s.people.filter((p) => p.alive);
const cash = people.map((p) => p.cash).sort((x, y) => x - y);
const firmCash = s.firms.filter((f) => f && f.alive).reduce((a, f) => a + f.cash, 0);
console.log('Money');
console.log(`  deposits ${f1(deposits(s))}  (households ${f1(cash.reduce((a, x) => a + x, 0))}, firms ${f1(firmCash)}, foreign desk ${f1(s.foreign.coin)})`);
console.log(`  household cash: median ${f1(cash[cash.length >> 1] ?? 0)}, p90 ${f1(cash[Math.floor(cash.length * 0.9)] ?? 0)}, max ${f1(cash[cash.length - 1] ?? 0)}`);
console.log(`  bank: loans ${f1(loansOutstanding(s))} (${s.loans.length}), reserves ${f1(b.reserves)}, window debt ${f1(b.windowDebt)}, equity ${f1(b.equity)}, owner ${s.people[b.owner]?.name ?? '?'}`);
console.log(`  Treasury: purse ${f1(s.treasury.purse)}, gold ${s.treasury.gold} oz; gold price ${s.goldMarket.price}; ledger discrepancy ${checkLedger(s).toExponential(2)}`);
const cal = calibrationOf(s);
if (cal) {
  console.log(`  calibration κ ${cal.kappa.toFixed(3)}, worker income ${f2(cal.workerIncome)}/day, owner income ${cal.ownerIncome.map(f1).join(' / ')}`);
  const imp = cal.imports.map((x, g) => (x > 0 ? `${GOODS[g].key} ${f1(x)}` : '')).filter(Boolean).join(', ');
  const exp = cal.exports.map((x, g) => (x > 0 ? `${GOODS[g].key} ${f1(x)}` : '')).filter(Boolean).join(', ');
  console.log(`  port: imports ${imp || 'none'}; exports ${exp || 'none'}`);
  if (has('flows')) {
    console.log('  flows (units/day):');
    for (const fl of cal.flows) console.log(`    ${padR(s.towns[fl.from].name, 12)} → ${padR(s.towns[fl.to].name, 12)} ${padR(GOODS[fl.good].key, 10)} ${pad(f1(fl.qty), 7)}`);
  }
}
console.log(`  people ${people.length}, firms ${s.firms.length}, buildings ${s.buildings.length}, shipments ${s.shipments.length}, projects ${s.projects.length}`);
console.log('');

if (!has('no-map')) printMap(s);

function printMap(st: SimState): void {
  const m = st.map;
  const T: Record<number, string> = {
    [Terrain.DeepWater]: '~',
    [Terrain.Water]: '-',
    [Terrain.Sand]: ':',
    [Terrain.Grass]: '.',
    [Terrain.Forest]: 't',
    [Terrain.Hills]: 'n',
    [Terrain.Mountain]: '^',
    [Terrain.Marsh]: '%',
  };
  const SEC: Record<string, string> = {
    farm: 'F', fishery: 'f', lumber: 'L', coalmine: 'C', oremine: 'O', oilwell: 'W', smelter: 'S',
    toolworks: 'K', bakery: 'b', brewery: 'a', furniture: 'u', builder: 'Y', trader: 'X',
  };
  const KIND: Record<string, string> = { market: 'M', palace: 'P', bank: 'B', port: 'D', house: 'h' };
  console.log('Map: ~ deep, - shallow, : sand, . grass, t forest, n hills, ^ mountain, % marsh, = river, + track, # paved, H bridge');
  console.log('     M market, P palace, B bank, D port, h house, * under construction; firms: ' + Object.entries(SEC).map(([k, v]) => `${v} ${k}`).join(', '));
  for (let y = 0; y < m.h; y++) {
    let line = '';
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      let c = T[m.terrain[i]] ?? '?';
      if (m.river[i]) c = '=';
      if (m.road[i] >= 1) c = m.river[i] ? 'H' : m.road[i] >= 2 ? '#' : '+';
      const bid = m.occ[i];
      if (bid >= 0) {
        const bd = st.buildings[bid];
        if (bd) c = bd.status === 'construction' ? '*' : bd.kind === 'firm' ? SEC[bd.sector] ?? '?' : KIND[bd.kind] ?? '?';
      }
      line += c;
    }
    console.log(line);
  }
}
