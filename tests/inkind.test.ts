// In-kind handouts (transfer with `good`): units from the Treasury's stores in a town to
// each member of a group there — people's pantries or firms' stores. No money moves.
import { describe, expect, it } from 'vitest';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { Game } from '../src/sim/game';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { dispatch, executeGoodsTransfer, executeTransfer } from '../src/sim/policy/player';
import { STATE, type MapData, type PlayerAction, type SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative|welfare|ration\w*)\b/i;

function tinyMap(): MapData {
  const n = 4;
  return { w: 2, h: 2, terrain: new Array(n).fill(3), elev: new Array(n).fill(0.5), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0), river: new Array(n).fill(0), road: new Array(n).fill(0), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function tinyState(): SimState {
  const s = newSimState(1, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 0, 0, 3));
  s.towns.push(newTown(1, 'Slateridge', 'mining', 1, 1, 3));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 2));
  return s;
}

type Tr = Extract<PlayerAction, { type: 'transfer' }>;
const give = (p: Partial<Tr>): Tr => ({ type: 'transfer', group: 'unemployed', town: 0, amount: 3, dir: 1, good: G.bread, ...p });

describe('in-kind handouts — validation', () => {
  it('refuses what cannot be handed out', () => {
    const s = tinyState();
    newPerson(s, 0, 'A');
    const owner = newPerson(s, 1, 'Owner');
    owner.job = 1;
    newFirm(s, 'coalmine', 1, -1, owner.id, 'Mine');
    s.treasury.goods[0][G.bread] = 10;
    s.treasury.goods[1][G.tools] = 10;
    expect(dispatch(s, give({ dir: -1 })).ok).toBe(false); // goods are only handed out
    expect(dispatch(s, give({ town: -1 })).ok).toBe(false); // a town's stores
    expect(dispatch(s, give({ town: 9 })).ok).toBe(false);
    expect(dispatch(s, give({ good: 99 })).ok).toBe(false);
    expect(dispatch(s, give({ amount: 0 })).ok).toBe(false);
    expect(dispatch(s, give({ amount: Number.NaN })).ok).toBe(false);
    expect(dispatch(s, give({ group: 'bank' })).ok).toBe(false);
    expect(dispatch(s, give({ group: 'nobody' as never })).ok).toBe(false);
    expect(dispatch(s, give({ town: 1 })).ok).toBe(false); // no bread held in Slateridge
    expect(dispatch(s, give({ good: G.iron })).ok).toBe(false); // people have no use for iron
    expect(dispatch(s, give({ group: 'homeless', town: 0, good: G.bread, sector: 'bakery' })).ok).toBe(false); // a trade only with firms
    expect(dispatch(s, give({ group: 'firms', town: 1, good: G.tools, sector: 'nonsense' as never })).ok).toBe(false);
    expect(dispatch(s, give({ group: 'firms', town: 1, good: G.tools, sector: 'stateworks' })).ok).toBe(false);
    expect(dispatch(s, give({ group: 'firms', town: 1, good: G.tools, sector: 'bakery' })).ok).toBe(false); // no bakeries there
    expect(dispatch(s, give({ group: 'employed', town: 0 })).ok).toBe(false); // nobody in work in Millbrook
    expect(s.treasury.goods[0][G.bread]).toBe(10);
    expect(s.treasury.goods[1][G.tools]).toBe(10);
  });
});

describe('in-kind handouts — moving the goods', () => {
  it('fills the pantries of the group, shares what is held when short, and moves no money', () => {
    const s = tinyState();
    const a = newPerson(s, 0, 'A');
    const b = newPerson(s, 0, 'B');
    const c = newPerson(s, 0, 'C');
    const far = newPerson(s, 1, 'Far');
    c.job = 3;
    reconcileBank(s);
    mint(s, 50);
    const purse0 = s.treasury.purse;
    s.treasury.goods[0][G.bread] = 10;
    const r = dispatch(s, give({ amount: 3 }));
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toBe('The Treasury handed 3 loaves of bread from its stores in Millbrook to each of 2 people without work there (6 in all).');
    expect(r.message).not.toMatch(FORBIDDEN);
    expect(a.pantry[G.bread]).toBeCloseTo(3);
    expect(b.pantry[G.bread]).toBeCloseTo(3);
    expect(c.pantry[G.bread]).toBe(0);
    expect(far.pantry[G.bread]).toBe(0);
    expect(s.treasury.goods[0][G.bread]).toBeCloseTo(4);
    expect(s.stats.acc['transfer_goods_' + G.bread]).toBeCloseTo(6);
    expect(s.stats.acc.transfer_goods_value).toBeCloseTo(12);
    expect(s.news.some((n) => n.kind === 'policy' && /handed 3 loaves of bread/.test(n.text))).toBe(true);
    // short: 4 left for three people → equal shares of what is held
    const r2 = dispatch(s, give({ group: 'all', amount: 5 }));
    expect(r2.ok).toBe(true);
    expect(r2.message).toMatch(/all its stores there held/);
    expect(a.pantry[G.bread]).toBeCloseTo(3 + 4 / 3);
    expect(c.pantry[G.bread]).toBeCloseTo(4 / 3);
    expect(s.treasury.goods[0][G.bread]).toBe(0);
    expect(s.treasury.purse).toBe(purse0);
    expect(s.treasury.flows.transfer ?? 0).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });

  it('hands goods to the firms of a trade (their stores) and nothing to others', () => {
    const s = tinyState();
    const owner = newPerson(s, 1, 'Owner');
    const m1 = newFirm(s, 'coalmine', 1, -1, owner.id, 'Mine 1');
    const m2 = newFirm(s, 'coalmine', 1, -1, owner.id, 'Mine 2');
    const smelter = newFirm(s, 'smelter', 1, -1, owner.id, 'Smelter');
    const own = newFirm(s, 'coalmine', 1, -1, STATE, 'Treasury Mine');
    const away = newFirm(s, 'coalmine', 0, -1, owner.id, 'Far Mine');
    s.treasury.goods[1][G.tools] = 20;
    const r = dispatch(s, give({ group: 'firms', town: 1, good: G.tools, sector: 'coalmine', amount: 3 }));
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toBe('The Treasury handed 3 sets of tools from its stores in Slateridge to each of 2 coal mines there (6 in all).');
    expect(m1.inv[G.tools]).toBeCloseTo(3);
    expect(m2.inv[G.tools]).toBeCloseTo(3);
    expect(smelter.inv[G.tools]).toBe(0);
    expect(own.inv[G.tools]).toBe(0); // the Treasury's own workshops are not recipients
    expect(away.inv[G.tools]).toBe(0);
    expect(s.treasury.goods[1][G.tools]).toBeCloseTo(14);
    // every firm in town (no trade): the smelter too
    expect(executeGoodsTransfer(s, 'firms', 1, G.tools, 1)).toBeCloseTo(3);
    expect(smelter.inv[G.tools]).toBeCloseTo(1);
    // money transfers to firms honour the trade too
    s.treasury.autoMint = true;
    reconcileBank(s);
    const paid = executeTransfer(s, 'firms', 1, 10, 1, 'coalmine');
    expect(paid).toBeCloseTo(20);
    expect(m1.cash).toBeCloseTo(10);
    expect(smelter.cash).toBe(0);
    const r2 = dispatch(s, { type: 'transfer', group: 'firms', town: 1, amount: 5, dir: 1, sector: 'smelter' });
    expect(r2.ok, r2.message).toBe(true);
    expect(r2.message).toMatch(/handed ¤5\.00 to the one smelter in Slateridge/);
    expect(smelter.cash).toBeCloseTo(5);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('tools handed to working mines join their tool stock by evening', () => {
    const g = Game.create({ seed: 1, warmup: false });
    g.dispatch({ type: 'setEvents', value: false });
    g.step(5);
    const s = g.s;
    const mining = s.towns.find((t) => t.kind === 'mining')!.id;
    const mines = s.firms.filter((f) => f.alive && f.status === 'active' && f.sector === 'coalmine' && f.town === mining && f.owner !== STATE);
    expect(mines.length).toBeGreaterThan(0);
    const copy = Game.load(g.save());
    s.treasury.goods[mining][G.tools] = 3 * mines.length;
    const r = g.dispatch({ type: 'transfer', group: 'firms', town: mining, good: G.tools, sector: 'coalmine', amount: 3, dir: 1 });
    expect(r.ok, r.message).toBe(true);
    for (const f of mines) expect(f.inv[G.tools]).toBeGreaterThanOrEqual(3);
    g.step(1);
    copy.step(1);
    for (const f of mines) {
      expect(f.inv[G.tools]).toBeLessThan(1e-9); // absorbed into the tool stock
      const twin = copy.s.firms[f.id];
      expect(f.tools - twin.tools).toBeGreaterThan(1.5); // (the twin may have bought a little)
    }
  });
});
