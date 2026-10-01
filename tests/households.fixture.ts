// Minimal world builder for households/labour/housing/demography tests.
// Builds a tiny state with the record factories only (no world generation).
import { newBuilding, newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { N_GOODS } from '../src/sim/goods';
import { reconcileBank } from '../src/sim/ledger';
import type { Book, Building, Firm, MapData, Person, Ref, Sector, SimState } from '../src/sim/types';

export function tinyMap(w = 40, h = 30): MapData {
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

/** Price vector close to the founding calibration. */
export const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];

export function tinyWorld(nTowns = 1): SimState {
  const s = newSimState(7, tinyMap());
  for (let t = 0; t < nTowns; t++) {
    const town = newTown(t, 'Town' + t, t === 0 ? 'capital' : 'farm', 10 + t * 12, 10, 5);
    s.towns.push(town);
    for (let g = 0; g < N_GOODS; g++) s.markets[t * N_GOODS + g] = newMarket(t, g, PRICES[g]);
  }
  s.treasury = newTreasury(nTowns);
  s.stats.baseWage = 10;
  s.bank.depositRate = 0.01;
  return s;
}

export function addPerson(s: SimState, town: number, cash: number, opts: Partial<Person> = {}): Person {
  const p = newPerson(s, town, 'P' + s.ids.person);
  p.cash = cash; // direct endowment (tests only; call reconcile() afterwards)
  p.income = 10;
  Object.assign(p, opts);
  return p;
}

export function addHouse(s: SimState, town: number, x: number, y: number, rent: number, owner: Ref, slots = 4): Building {
  const b = newBuilding(s, 'house', '', town, x, y, 1, 1, 'active');
  b.slots = slots;
  b.rent = rent;
  b.owner = owner;
  return b;
}

export function addFirm(s: SimState, sector: Sector, town: number, x: number, y: number, wage: number, target: number, owner: Ref = -1): Firm {
  const b = newBuilding(s, 'firm', sector, town, x, y, 1, 1, 'active');
  const f = newFirm(s, sector, town, b.id, owner, sector + s.ids.firm);
  b.firm = f.id;
  f.wage = wage;
  f.target = target;
  return f;
}

/** Give the bank enough reserves and reconcile equity so checkLedger() starts at 0. */
export function reconcile(s: SimState): void {
  s.bank.reserves = 1e5;
  reconcileBank(s);
}

/** A minimal in-memory Books object compatible with the markets contract. */
export function fakeBooks(s: SimState) {
  const mk = (town: number, good: number): Book => ({ town, good, bids: [], asks: [], wedge: { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 }, ceiling: -1, floor: -1 });
  const goods: Book[] = [];
  for (let t = 0; t < s.towns.length; t++) for (let g = 0; g < N_GOODS; g++) goods.push(mk(t, g));
  return { goods, iou: mk(-1, 100), gold: mk(-1, 101) };
}
