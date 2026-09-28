// Goods and sector (recipe) definitions. Pure data + tiny helpers.
import type { GoodId, Materials, Sector } from './types';

export const N_GOODS = 11;

/** Good ids. Use as `inv[G.bread]`. */
export const G = {
  grain: 0,
  fish: 1,
  wood: 2,
  coal: 3,
  oil: 4,
  ore: 5,
  iron: 6,
  tools: 7,
  bread: 8,
  ale: 9,
  furniture: 10,
} as const;

export interface GoodDef {
  id: GoodId;
  key: string;
  name: string;
  unit: string;
  color: string; // UI colour (map cargo dots, charts)
  /** Fraction lost per day wherever the good is stored (0 = durable). */
  spoil: number;
  /** Bought by households. */
  consumer: boolean;
  /** Tradable with the outside world through the port. */
  tradable: boolean;
  /** Short description for the Almanac. */
  blurb: string;
}

export const GOODS: GoodDef[] = [
  { id: 0, key: 'grain', name: 'Grain', unit: 'sack', color: '#e3c26b', spoil: 0.0005, consumer: false, tradable: true, blurb: 'Grown on farms. Bakers and brewers need it. Harvests swell in summer and shrink in winter.' },
  { id: 1, key: 'fish', name: 'Fish', unit: 'basket', color: '#6fb7d6', spoil: 0.10, consumer: true, tradable: false, blurb: 'Caught off the coast by boats that burn oil. A food that competes with bread. Rots quickly.' },
  { id: 2, key: 'wood', name: 'Wood', unit: 'log', color: '#9a6b3f', spoil: 0, consumer: false, tradable: true, blurb: 'Felled in forests. Used for tools, furniture and every construction.' },
  { id: 3, key: 'coal', name: 'Coal', unit: 'ton', color: '#5b5f66', spoil: 0, consumer: true, tradable: true, blurb: 'Dug from the hills. Heats homes in winter, fires ovens, kilns and forges.' },
  { id: 4, key: 'oil', name: 'Oil', unit: 'barrel', color: '#3c3350', spoil: 0, consumer: false, tradable: true, blurb: 'Pumped from marsh seeps. Fuel for wagons and fishing boats — the cost of moving things.' },
  { id: 5, key: 'ore', name: 'Ore', unit: 'ton', color: '#a0604c', spoil: 0, consumer: false, tradable: true, blurb: 'Mined in the mountains. Smelted into iron with coal.' },
  { id: 6, key: 'iron', name: 'Iron', unit: 'bar', color: '#8e99a6', spoil: 0, consumer: false, tradable: true, blurb: 'Smelted from ore and coal. Needed for tools, furniture fittings and construction.' },
  { id: 7, key: 'tools', name: 'Tools', unit: 'set', color: '#c9a227', spoil: 0, consumer: false, tradable: true, blurb: 'Forged from iron, wood and coal. Every workplace uses tools; they wear out with use. More tools per worker, more output.' },
  { id: 8, key: 'bread', name: 'Bread', unit: 'loaf', color: '#d9934a', spoil: 0.05, consumer: true, tradable: false, blurb: 'Baked from grain in coal-fired ovens. The staple food. Goes stale in days.' },
  { id: 9, key: 'ale', name: 'Ale', unit: 'cask', color: '#b5772b', spoil: 0.03, consumer: true, tradable: false, blurb: 'Brewed from grain. A pleasure people buy more of when they feel rich.' },
  { id: 10, key: 'furniture', name: 'Furniture', unit: 'piece', color: '#7d5a8c', spoil: 0, consumer: true, tradable: true, blurb: 'Made from wood and iron. A durable comfort; households buy it with spare income.' },
];

export const CONSUMER_GOODS: GoodId[] = [G.fish, G.coal, G.bread, G.ale, G.furniture];
export const TRADABLE_GOODS: GoodId[] = GOODS.filter((g) => g.tradable).map((g) => g.id);

export type SeasonKind = 'none' | 'farm' | 'fish';
export type SiteKind = 'grass' | 'coast' | 'forest' | 'hills' | 'mountain' | 'marsh' | 'town';

/**
 * Production model (see agents/production.ts):
 *   Q = A · season · site · Leff^alpha · toolFactor
 *   toolFactor = TOOLLESS + (1 − TOOLLESS) · min(1, K / (toolsPerWorker · Leff))
 * A is calibrated so that a firm of `typicalSize` workers with full tools, health 1,
 * average season and an average site produces `prodPerWorker` per worker-day.
 * Tools wear by `toolUse` per effective worker-day (plus a little idle wear).
 */
export interface SectorDef {
  key: Sector;
  name: string; // building name
  worker: string; // what a worker is called
  out: GoodId; // -1 for service sectors (builder, trader, stateworks)
  inputs: [GoodId, number][]; // material per unit of output
  alpha: number; // labour elasticity (< 1: decreasing returns per site)
  prodPerWorker: number;
  typicalSize: number; // workers per firm used for calibration
  toolsPerWorker: number; // tools each worker needs for full productivity
  capacityPerLevel: number; // max workers per building level
  toolUse: number; // tools worn per effective worker-day
  season: SeasonKind;
  site: SiteKind;
  footprint: [number, number];
  buildCost: Materials; // new level-1 building
  expandCost: Materials; // +1 level
  color: string;
  producer: boolean;
}

const M = (labor: number, wood: number, iron: number, tools: number): Materials => ({ labor, wood, iron, tools });

type Row = [
  Sector, string, string, GoodId, [GoodId, number][],
  number, number, number, number, number, number, SeasonKind, SiteKind, [number, number], Materials, string,
];
//  key          name                  worker        out           inputs                                   alpha prod  size tpw  cap toolUse season  site       foot    buildCost              color
const ROWS: Row[] = [
  ['farm',      'Farm',               'farmhand',   G.grain,     [],                                       0.78, 5.0,  8,  1.0, 12, 0.020, 'farm', 'grass',    [2, 2], M(3080, 675, 81, 31), '#c8b04a'],
  ['fishery',   'Fishery',            'fisher',     G.fish,      [[G.oil, 0.08]],                          0.78, 4.2,  6,  1.0,  8, 0.025, 'fish', 'coast',    [1, 1], M(2310, 510, 61, 23), '#4f9fc9'],
  ['lumber',    'Lumber Camp',        'woodcutter', G.wood,      [],                                       0.78, 5.0,  5,  1.0,  8, 0.025, 'none', 'forest',   [1, 1], M(1930, 425, 51, 20), '#6e8b3d'],
  ['coalmine',  'Coal Mine',          'miner',      G.coal,      [],                                       0.78, 5.0,  8,  1.2, 12, 0.030, 'none', 'hills',    [1, 1], M(3080, 675, 81, 31), '#50545c'],
  ['oilwell',   'Oil Well',           'driller',    G.oil,       [],                                       0.78, 6.0,  4,  1.5,  6, 0.030, 'none', 'marsh',    [1, 1], M(1540, 340, 41, 16), '#3c3350'],
  ['oremine',   'Ore Mine',           'miner',      G.ore,       [],                                       0.78, 4.0,  6,  1.2, 10, 0.030, 'none', 'mountain', [1, 1], M(2310, 510, 61, 23), '#a0604c'],
  ['smelter',   'Smelter',            'smelter',    G.iron,      [[G.ore, 2], [G.coal, 1]],                0.85, 3.0,  5,  0.8, 10, 0.020, 'none', 'town',     [2, 1], M(1210, 265, 32, 12), '#b35a3a'],
  ['toolworks', 'Toolworks',          'smith',      G.tools,     [[G.iron, 1], [G.wood, 0.5], [G.coal, 0.5]], 0.85, 1.5, 5, 0.8, 10, 0.020, 'none', 'town',     [1, 1], M(1210, 265, 32, 12), '#c9a227'],
  ['bakery',    'Bakery',             'baker',      G.bread,     [[G.grain, 1], [G.coal, 0.2]],            0.85, 14,   5,  0.5,  8, 0.015, 'none', 'town',     [1, 1], M(1210, 265, 32, 12), '#d9934a'],
  ['brewery',   'Brewery',            'brewer',     G.ale,       [[G.grain, 0.6], [G.coal, 0.1]],          0.85, 12,   5,  0.5,  8, 0.015, 'none', 'town',     [1, 1], M(1210, 265, 32, 12), '#b5772b'],
  ['furniture', 'Furniture Workshop', 'joiner',     G.furniture, [[G.wood, 2], [G.iron, 0.2]],             0.85, 0.8,  6,  0.8, 10, 0.020, 'none', 'town',     [1, 1], M(1450, 320, 38, 15), '#7d5a8c'],
  // service sectors: alpha/prod unused; toolsPerWorker = equipment; builders also consume tools as project materials
  ['builder',   "Builders' Yard",     'builder',    -1,          [],                                       1,    1,   10,  0.5, 30, 0.010, 'none', 'town',     [2, 1], M(900, 200, 20, 10),  '#a88b5b'],
  ['trader',    'Trading House',      'carter',     -1,          [],                                       1,    1,    6,  0,   24, 0,     'none', 'town',     [2, 1], M(900, 200, 20, 10),  '#8c6d46'],
  ['stateworks','Treasury Works',     'Treasury worker', -1,     [],                                       1,    1,    0,  0, 100000, 0,   'none', 'town',     [1, 1], M(0, 0, 0, 0),        '#d4af37'],
];

const half = (m: Materials): Materials => M(Math.round(m.labor / 2), Math.round(m.wood / 2), Math.round(m.iron / 2), Math.round(m.tools / 2));

export const SECTORS: Record<Sector, SectorDef> = Object.fromEntries(
  ROWS.map(([key, name, worker, out, inputs, alpha, prodPerWorker, typicalSize, toolsPerWorker, capacityPerLevel, toolUse, season, site, footprint, buildCost, color]) => [
    key,
    {
      key, name, worker, out, inputs, alpha, prodPerWorker, typicalSize, toolsPerWorker, capacityPerLevel, toolUse, season, site, footprint,
      buildCost, expandCost: half(buildCost), color,
      producer: out >= 0,
    } satisfies SectorDef,
  ]),
) as Record<Sector, SectorDef>;

export const PRODUCER_SECTORS: Sector[] = (Object.keys(SECTORS) as Sector[]).filter((k) => SECTORS[k].producer);
export const ALL_SECTORS: Sector[] = Object.keys(SECTORS) as Sector[];

/** Which sector produces a good. */
export const PRODUCER_OF: Sector[] = (() => {
  const r: Sector[] = new Array(N_GOODS);
  for (const k of PRODUCER_SECTORS) r[SECTORS[k].out] = k;
  return r;
})();

/** Construction materials for houses / roads / piers (per unit built). */
export const HOUSE_COST: Materials = M(1400, 300, 30, 10);
export const HOUSE_SLOTS = 4;
export const ROAD_TILE_COST: Materials = M(30, 2, 2, 1);
export const PIER_COST: Materials = M(2500, 600, 80, 30);

export function emptyGoods(): number[] {
  return new Array(N_GOODS).fill(0);
}

export function goodName(g: GoodId): string {
  return GOODS[g]?.name ?? '?';
}
