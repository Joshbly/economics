// Map renderer: pure helpers (camera maths, timetables, polylines, road/river
// networks, ground painter, overlay values). No DOM needed.
import { describe, expect, it } from 'vitest';
import { clampCamera, fitZoom, newCamera, panBy, pickLod, sx, sy, wx, wy, zoomAround } from '../src/ui/map/camera';
import { CHUNK_FADE_MS, CHUNK_MARGIN, LODS, ZOOM_MAX, ZOOM_MIN } from '../src/ui/map/constants';
import { buildFields, chamfer, fillGround } from '../src/ui/map/fields';
import { overlayValues, relColor, townPrice } from '../src/ui/map/overlay';
import { chaikin, riverCourses, roadChains } from '../src/ui/map/roads';
import { activeRoutes, chevronsAt, distToPath, offsetPath, roundQty, routeLabel, slicePoly, treasuryWagonText, trimSpan } from '../src/ui/map/routes';
import { commuteTrip, hash01, Leg, polyFromPoints, polyFromTiles, samplePoly, shipmentProgress, strollTrip, tripAt } from '../src/ui/map/schedule';
import { fadeIn, forestTrees, grassBush, standInOrder } from '../src/ui/map/terrain';
import { newMarket, newPerson, newShipment, newSimState, newTown } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { STATE, Terrain, type CarryRule } from '../src/sim/types';
import { generateMap } from '../src/sim/world/mapgen';

describe('camera', () => {
  it('screen ↔ world round-trips', () => {
    const c = newCamera();
    c.vw = 1000;
    c.vh = 700;
    c.x = 40.5;
    c.y = 20.25;
    c.z = 1.7;
    for (const [x, y] of [
      [0, 0],
      [37.2, 55.9],
      [111, 75],
    ]) {
      expect(wx(c, sx(c, x))).toBeCloseTo(x, 9);
      expect(wy(c, sy(c, y))).toBeCloseTo(y, 9);
    }
  });

  it('zoomAround keeps the anchored world point under the cursor and clamps', () => {
    const c = newCamera();
    c.vw = 900;
    c.vh = 600;
    const ax = wx(c, 123);
    const ay = wy(c, 456);
    zoomAround(c, 123, 456, 2.5);
    expect(c.z).toBe(2.5);
    expect(wx(c, 123)).toBeCloseTo(ax, 9);
    expect(wy(c, 456)).toBeCloseTo(ay, 9);
    zoomAround(c, 10, 10, 99);
    expect(c.z).toBe(ZOOM_MAX);
    zoomAround(c, 10, 10, 0.01);
    expect(c.z).toBe(ZOOM_MIN);
    zoomAround(c, 10, 10, NaN);
    expect(Number.isFinite(c.z)).toBe(true);
  });

  it('panBy moves content with the pointer', () => {
    const c = newCamera();
    const before = sx(c, 30);
    panBy(c, 50, 0);
    expect(sx(c, 30)).toBeCloseTo(before + 50, 9);
  });

  it('clampCamera centres a map that fits and bounds one that does not', () => {
    const c = newCamera();
    c.vw = 2000;
    c.vh = 1500;
    c.z = 0.5;
    c.x = -40;
    c.y = 300;
    clampCamera(c, 112, 76);
    expect(c.x).toBe(56);
    expect(c.y).toBe(38);
    c.vw = 800;
    c.vh = 600;
    c.z = 3;
    c.x = 1000;
    c.y = -1000;
    clampCamera(c, 112, 76);
    expect(c.x).toBeLessThanOrEqual(112 + 4);
    expect(c.y).toBeGreaterThanOrEqual(-4);
    c.x = NaN;
    clampCamera(c, 112, 76);
    expect(Number.isFinite(c.x)).toBe(true);
  });

  it('picks the smallest sufficient level of detail', () => {
    expect(pickLod(8)).toBe(8);
    expect(pickLod(9)).toBe(8); // small magnification allowed
    expect(pickLod(12)).toBe(16);
    expect(pickLod(16)).toBe(16);
    expect(pickLod(33)).toBe(32);
    expect(pickLod(40)).toBe(64);
    expect(pickLod(1e6)).toBe(LODS[LODS.length - 1]);
  });

  it('fitZoom stays within the zoom range', () => {
    expect(fitZoom(1000, 800, 112, 76)).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(fitZoom(100000, 80000, 1, 1)).toBe(ZOOM_MAX);
    expect(fitZoom(10, 10, 112, 76)).toBe(ZOOM_MIN);
  });
});

describe('timetables', () => {
  it('commutes leave in the morning, arrive by 0.38 and come home in the evening', () => {
    for (let id = 0; id < 500; id++) {
      for (const len of [0, 3, 12, 40, NaN, -5]) {
        const t = commuteTrip(id, len);
        expect(t.d0).toBeLessThan(t.a0);
        expect(t.a0).toBeLessThan(t.d1);
        expect(t.d1).toBeLessThan(t.a1);
        expect(t.a0).toBeGreaterThanOrEqual(0.33 - 1e-9);
        expect(t.a0).toBeLessThanOrEqual(0.38 + 1e-9);
        expect(t.d0).toBeGreaterThanOrEqual(0.19 - 1e-9);
        expect(t.d1).toBeGreaterThanOrEqual(0.7 - 1e-9);
        expect(t.d1).toBeLessThanOrEqual(0.75 + 1e-9);
        expect(t.a1).toBeLessThanOrEqual(0.9);
      }
    }
    // longer walks set out earlier
    expect(commuteTrip(7, 30).d0).toBeLessThan(commuteTrip(7, 2).d0);
  });

  it('tripAt walks out, stays, walks back', () => {
    const t = commuteTrip(42, 10);
    const o = { leg: Leg.AtA as Leg, f: 0 };
    expect(tripAt(t, 0.1, o).leg).toBe(Leg.AtA);
    tripAt(t, (t.d0 + t.a0) / 2, o);
    expect(o.leg).toBe(Leg.Out);
    expect(o.f).toBeGreaterThan(0.2);
    expect(o.f).toBeLessThan(0.8);
    expect(tripAt(t, (t.a0 + t.d1) / 2, o).leg).toBe(Leg.AtB);
    tripAt(t, (t.d1 + t.a1) / 2, o);
    expect(o.leg).toBe(Leg.Back);
    expect(o.f).toBeGreaterThan(0.2);
    expect(tripAt(t, 0.95, o).leg).toBe(Leg.AtA);
    // progress is monotone along the morning walk
    let prev = -1;
    for (let k = 0; k <= 20; k++) {
      const f = tripAt(t, t.d0 + ((t.a0 - t.d0) * k) / 20.0001, o).f;
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f;
    }
  });

  it('about two in three of the jobless stroll to the square at midday', () => {
    let n = 0;
    for (let id = 0; id < 2000; id++) {
      const t = strollTrip(id, 8);
      if (!t) continue;
      n++;
      expect(t.d0).toBeGreaterThanOrEqual(0.4);
      expect(t.a0).toBeLessThan(t.d1);
      expect(t.a1).toBeLessThan(0.8);
    }
    expect(n / 2000).toBeGreaterThan(0.58);
    expect(n / 2000).toBeLessThan(0.72);
  });

  it('shipment progress is clamped and safe', () => {
    expect(shipmentProgress(10, 0.5, 10, 12)).toBeCloseTo(0.25, 9);
    expect(shipmentProgress(5, 0, 10, 12)).toBe(0);
    expect(shipmentProgress(20, 0, 10, 12)).toBe(1);
    expect(shipmentProgress(10, 0, 10, 10)).toBe(1);
    expect(shipmentProgress(10, 0, NaN, 12)).toBe(1);
  });

  it('hash01 is deterministic and in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const h = hash01(i, 3);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(hash01(i, 3)).toBe(h);
    }
  });
});

describe('polylines', () => {
  it('samples by arc length with directions', () => {
    const p = polyFromTiles([0, 1, 2, 12, 22], 10); // (0,0)→(2,0)→(2,2)
    expect(p.len).toBeCloseTo(4, 9);
    const o = { x: 0, y: 0, dx: 0, dy: 0 };
    samplePoly(p, 0, o);
    expect([o.x, o.y]).toEqual([0.5, 0.5]);
    samplePoly(p, 1, o);
    expect(o.x).toBeCloseTo(1.5, 6);
    expect(o.dx).toBeCloseTo(1, 6);
    samplePoly(p, 3, o);
    expect(o.x).toBeCloseTo(2.5, 6);
    expect(o.y).toBeCloseTo(1.5, 6);
    expect(o.dy).toBeCloseTo(1, 6);
    samplePoly(p, 99, o);
    expect(o.y).toBeCloseTo(2.5, 6);
    samplePoly(p, -5, o);
    expect(o.x).toBeCloseTo(0.5, 6);
  });

  it('handles empty and single-point paths', () => {
    const o = { x: 9, y: 9, dx: 0, dy: 0 };
    samplePoly(polyFromTiles([], 10), 1, o);
    expect(Number.isFinite(o.x) && Number.isFinite(o.dx)).toBe(true);
    samplePoly(polyFromTiles([5], 10), 1, o);
    expect([o.x, o.y]).toEqual([5.5, 0.5]);
    expect(polyFromPoints([1, 2, 4, 6]).len).toBeCloseTo(5, 9);
  });
});

function grid(w: number, h: number, rows: string[]): number[] {
  const out = new Array(w * h).fill(0);
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) out[y * w + x] = r[x] === '#' ? 2 : r[x] === '+' ? 1 : 0;
  });
  return out;
}

describe('road network', () => {
  // grid(): '#' paved, '+' dirt, '.' none
  it('chaikin keeps the ends of open chains and closes loops', () => {
    const open = chaikin([0, 0, 1, 0, 1, 1, 2, 1], 2);
    expect(open.slice(0, 2)).toEqual([0, 0]);
    expect(open.slice(-2)).toEqual([2, 1]);
    const loop = chaikin([0, 0, 1, 0, 1, 1, 0, 1, 0, 0], 1, true);
    expect(loop.slice(0, 2)).toEqual(loop.slice(-2));
  });

  it('a straight track is one chain end to end', () => {
    const w = 8;
    const road = grid(w, 3, ['........', '.++++++.', '........']);
    const ch = roadChains(w, 3, road);
    expect(ch.length).toBe(1);
    const p = ch[0].pts;
    const ends = [p[0], p[p.length - 2]].sort((a, b) => a - b);
    expect(ends).toEqual([1.5, 6.5]);
    expect(ch[0].level).toBe(1);
  });

  it('splits at junctions and where the surface changes', () => {
    const w = 7;
    const t = roadChains(w, 5, grid(w, 5, ['.......', '.+++++.', '...+...', '...+...', '.......']));
    expect(t.length).toBe(3);
    // the whole track is one base chain; the paved network is extracted on its own
    const road = grid(w, 3, ['.......', '.+++###', '.......']);
    const base = roadChains(w, 3, road);
    expect(base.length).toBe(1);
    const paved = roadChains(w, 3, road, undefined, 2, 2);
    expect(paved.length).toBe(1);
    expect(paved[0].level).toBe(2);
    expect(paved[0].x0).toBeGreaterThanOrEqual(4.5 - 1e-9);
    // paving that cuts a staircase corner diagonally stays one chain
    const stair = grid(w, 4, ['#+.....', '.#+....', '..##...', '.......']);
    expect(roadChains(w, 4, stair, undefined, 2, 2).length).toBe(1);
  });

  it('finds loops, diagonal touches and isolated tiles; honours skip', () => {
    const w = 6;
    const loop = roadChains(w, 5, grid(w, 5, ['......', '.+++..', '.+.+..', '.+++..', '......']));
    expect(loop.length).toBe(1);
    expect(loop[0].closed).toBe(true);
    const diag = roadChains(w, 4, grid(w, 4, ['++....', '..++..', '......', '....+.']));
    // two tracks touching at a corner join into one chain; the lone tile still draws
    expect(diag.length).toBe(2);
    expect(diag.some((c) => c.pts.length >= 8)).toBe(true);
    const skipped = roadChains(w, 3, grid(w, 3, ['......', '.++++.', '......']), (i) => i === 8 || i === 9);
    expect(skipped.length).toBe(2);
  });

  it('orders the river from its spring to the sea and runs into the water', () => {
    const w = 5;
    const h = 6;
    const river = new Array(w * h).fill(0);
    const elev = new Array(w * h).fill(0.5);
    for (let y = 0; y < 5; y++) {
      river[y * w + 2] = 1;
      elev[y * w + 2] = 0.9 - y * 0.1;
    }
    const water = (i: number) => Math.floor(i / w) === 5;
    const rs = riverCourses(w, h, river, elev, water);
    expect(rs.length).toBe(1);
    const p = rs[0].pts;
    expect(p[1]).toBeCloseTo(0.5, 6); // starts at the spring (top)
    expect(p[p.length - 1]).toBeGreaterThan(5); // ends in the sea
    expect(rs[0].width[0]).toBeLessThan(rs[0].width[rs[0].width.length - 1]);
  });
});

describe('ground painter', () => {
  it('chamfer distances are exact on axes and diagonals', () => {
    const d = chamfer(5, 5, (i) => i === 12);
    expect(d[12]).toBe(0);
    expect(d[13]).toBe(1);
    expect(d[14]).toBe(2);
    expect(d[18]).toBeCloseTo(Math.SQRT2, 5);
  });

  it('paints finite, opaque colours: land looks like land and deep water like water', () => {
    const { map } = generateMap(3);
    const F = buildFields(map, 3);
    const g = 4;
    const pw = map.w * g;
    const ph = map.h * g;
    const buf = new Uint8ClampedArray(pw * ph * 4);
    fillGround(F, buf, pw, ph, 0, 0, g);
    for (let k = 3; k < buf.length; k += 4) expect(buf[k]).toBe(255);
    for (let k = 0; k < buf.length; k++) expect(Number.isFinite(buf[k])).toBe(true);
    const px = (tx: number, ty: number) => {
      const i = ((ty * g + g / 2) * pw + tx * g + g / 2) * 4;
      return [buf[i], buf[i + 1], buf[i + 2]];
    };
    let checked = 0;
    for (let i = 0; i < map.w * map.h && checked < 400; i += 7) {
      const x = i % map.w;
      const y = Math.floor(i / map.w);
      const t = map.terrain[i];
      if (t === Terrain.DeepWater && F.depth[i] > 3) {
        const [r, , b] = px(x, y);
        expect(b).toBeGreaterThan(r);
        checked++;
      } else if (t === Terrain.Grass && F.shore[i] > 2) {
        const [r, gg, b] = px(x, y);
        expect(gg).toBeGreaterThan(b);
        expect(gg).toBeGreaterThan(r * 0.9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('overlay values', () => {
  function state() {
    const s = newSimState(1, { w: 4, h: 4, terrain: new Array(16).fill(3), elev: new Array(16).fill(0.3), fert: new Array(16).fill(0.5), deposit: new Array(16).fill(0), river: new Array(16).fill(0), road: new Array(16).fill(0), occ: new Array(16).fill(-1), district: new Array(16).fill(0) });
    for (let t = 0; t < 3; t++) s.towns.push(newTown(t, 'T' + t, 'farm', t, t, 3));
    for (let t = 0; t < 3; t++) for (let g = 0; g < N_GOODS; g++) s.markets[t * N_GOODS + g] = newMarket(t, g, 4 + t);
    return s;
  }

  it('prices compare each town with the realm average', () => {
    const s = state();
    const v = overlayValues(s, 'price', G.bread)!;
    expect(v.length).toBe(3);
    expect(v[0].rel).toBeLessThan(0);
    expect(v[2].rel).toBeGreaterThan(0);
    expect(v[1].rel).toBeCloseTo(0, 6);
    expect(townPrice(s, 2, G.bread)).toBe(6);
    expect(v[0].sub).toMatch(/▼/);
  });

  it('never produces NaN, even with empty towns', () => {
    const s = state();
    s.towns[0].employed = 0;
    s.towns[0].unemployed = 0;
    s.towns[1].health = NaN;
    const p = newPerson(s, 2, 'A');
    p.cash = 100;
    for (const id of ['unemployment', 'wealth', 'health', 'rent', 'price'] as const) {
      const v = overlayValues(s, id, G.fish)!;
      for (const x of v) {
        expect(Number.isFinite(x.rel)).toBe(true);
        expect(Math.abs(x.rel)).toBeLessThanOrEqual(1);
        expect(typeof x.text).toBe('string');
      }
    }
    expect(overlayValues(s, 'none', 0)).toBeNull();
    expect(relColor(NaN)).toMatch(/^rgba\(/);
  });
});

describe('terrain features and levels of detail', () => {
  it('trees and bushes depend on the world tile only, stay near it and within the chunk margin', () => {
    let trees = 0;
    let bushes = 0;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        for (const edge of [0, 1, 2, 3]) {
          const a = forestTrees(77, x, y, edge, 0.3);
          const b = forestTrees(77, x, y, edge, 0.3);
          expect(b).toEqual(a); // deterministic
          expect(a.length).toBeLessThanOrEqual(5);
          if (edge < 2) expect(a.length).toBe(5);
          for (const t of a) {
            trees++;
            // a crown (conifers are 2.3 r tall) plus its shadow stays well inside CHUNK_MARGIN of the tile
            expect(t.x - t.r).toBeGreaterThan(x - CHUNK_MARGIN);
            expect(t.x + t.r + 0.1).toBeLessThan(x + 1 + CHUNK_MARGIN);
            expect(t.y - t.r * 2.3 * 0.62).toBeGreaterThan(y - CHUNK_MARGIN);
            expect(t.r).toBeGreaterThan(0.15);
            expect(t.r).toBeLessThanOrEqual(0.3);
            expect([0, 1, 2]).toContain(t.b);
          }
        }
        for (const near of [false, true]) {
          const u = grassBush(77, x, y, near);
          expect(grassBush(77, x, y, near)).toEqual(u);
          if (u) {
            bushes++;
            expect(u.x).toBeGreaterThanOrEqual(x + 0.25);
            expect(u.x).toBeLessThanOrEqual(x + 0.75);
            expect(u.r).toBeGreaterThanOrEqual(0.14);
            expect(u.r).toBeLessThanOrEqual(0.24);
          }
        }
        // a bush that stands away from the woods also stands beside them (same spot, same size)
        const far = grassBush(77, x, y, false);
        if (far) expect(grassBush(77, x, y, true)).toEqual(far);
      }
    }
    expect(trees).toBeGreaterThan(20000);
    expect(bushes).toBeGreaterThan(100);
  });

  it('stand-in levels: the level shown before first, then the nearest, finer first on ties', () => {
    expect(standInOrder(64, 32)).toEqual([32, 128, 16, 8]);
    expect(standInOrder(64, -1)).toEqual([128, 32, 16, 8]);
    expect(standInOrder(8, 16)).toEqual([16, 32, 64, 128]);
    expect(standInOrder(128, 128)).toEqual([64, 32, 16, 8]);
    for (const L of LODS) {
      const o = standInOrder(L, -1);
      expect(o).not.toContain(L);
      expect(o.length).toBe(LODS.length - 1);
      if (L !== LODS[0]) expect(o).toContain(LODS[0]); // the coarsest level (always complete) is always a candidate
    }
  });

  it('fade-in ramps smoothly from 0 to 1 over CHUNK_FADE_MS', () => {
    expect(fadeIn(-5)).toBe(0);
    expect(fadeIn(0)).toBe(0);
    expect(fadeIn(NaN)).toBe(0);
    expect(fadeIn(CHUNK_FADE_MS / 2)).toBeCloseTo(0.5, 6);
    expect(fadeIn(CHUNK_FADE_MS)).toBe(1);
    expect(fadeIn(1e9)).toBe(1);
    let prev = 0;
    for (let t = 0; t <= CHUNK_FADE_MS; t += CHUNK_FADE_MS / 20) {
      const a = fadeIn(t);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
});

describe('carry rules on the map', () => {
  function state() {
    const n = 20 * 12;
    const s = newSimState(1, { w: 20, h: 12, terrain: new Array(n).fill(3), elev: new Array(n).fill(0.3), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0), river: new Array(n).fill(0), road: new Array(n).fill(0), occ: new Array(n).fill(-1), district: new Array(n).fill(0) });
    s.towns.push(newTown(0, 'Kingsbridge', 'capital', 3, 5, 4), newTown(1, 'Saltmere', 'harbor', 16, 6, 3));
    return s;
  }
  function carry(s: ReturnType<typeof state>, patch: Partial<CarryRule> = {}): CarryRule {
    const c: CarryRule = {
      id: s.ids.policy++,
      label: '',
      enabled: true,
      from: 0,
      to: 1,
      good: G.bread,
      qty: 20,
      wagons: 'full',
      until: -1,
      created: 0,
      allow: 20,
      heldSince: -1,
      carriedToday: 0,
      carried: 0,
      freightToday: 0,
      freight: 0,
      ...patch,
    };
    s.policy.carries.push(c);
    return c;
  }

  it('lists running carry rules, with lanes, and counts Treasury wagons on the road', () => {
    const s = state();
    s.day = 10;
    const a = carry(s);
    carry(s, { enabled: false }); // paused and nothing on the road
    carry(s, { until: 5 }); // lapsed
    const b = carry(s, { qty: 7.25 }); // a second rule on the same road
    const all = carry(s, { qty: -1 }); // everything held
    const c = carry(s, { enabled: false }); // paused, but its last load is still travelling
    const sh = newShipment(s, STATE, 0, 1, G.bread, 12, 3, 9, 12, 1);
    sh.order = c.id;
    const r = activeRoutes(s);
    expect(r.map((x) => x.order)).toEqual([a.id, b.id, all.id, c.id]);
    expect(r.map((x) => x.lane)).toEqual([0, 1, 2, 3]);
    expect(r[3].buying).toBe(false);
    expect(r[3].inTransit).toBe(12);
    expect(routeLabel(r[0], 'Saltmere')).toBe('bread · 20/day → Saltmere');
    expect(routeLabel(r[1], 'Saltmere')).toBe('bread · 7.3/day → Saltmere');
    expect(routeLabel(r[2], 'Saltmere')).toBe('bread · all → Saltmere');
    expect(routeLabel(r[3], 'Saltmere')).toBe('bread · 12 on the road → Saltmere');
    // no rules, a rule to its own town, or to a town that does not exist: nothing
    expect(activeRoutes(state())).toEqual([]);
    const s2 = state();
    carry(s2, { to: 0 });
    carry(s2, { to: 9 });
    expect(activeRoutes(s2)).toEqual([]);
  });

  it('Treasury wagon hover text', () => {
    const s = state();
    s.day = 10;
    const sh = newShipment(s, STATE, 0, 1, G.bread, 40, 3, 9.5, 11.85, 2);
    expect(treasuryWagonText(s, sh, 0.45)).toEqual(['Treasury: 40 bread → Saltmere', 'arrives in 1.4 days']);
    s.day = 11;
    expect(treasuryWagonText(s, sh, 0.83)[1]).toBe('arriving now');
    expect(roundQty(12.46)).toBe(12);
    expect(roundQty(2.46)).toBe(2.5);
    expect(roundQty(NaN)).toBe(0);
  });

  it('offsets a path to the right of travel, keeps its shape, and measures distances', () => {
    // eastward (y grows downwards, so "right" is +y), then southward ("right" is −x)
    const p = offsetPath([0, 0, 4, 0, 4, 4], 0.5);
    expect(p.length).toBe(6);
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(0.5, 9);
    expect(p[4]).toBeCloseTo(3.5, 9);
    expect(p[5]).toBeCloseTo(4, 9);
    // the mitred corner sits 0.5 from both legs
    expect(p[2]).toBeCloseTo(3.5, 9);
    expect(p[3]).toBeCloseTo(0.5, 9);
    expect(offsetPath([1, 1, 2, 2], 0)).toEqual([1, 1, 2, 2]);
    expect(distToPath([0, 0, 4, 0], 2, 3)).toBeCloseTo(3, 9);
    expect(distToPath([0, 0, 4, 0], 6, 0)).toBeCloseTo(2, 9);
    expect(distToPath([], 0, 0)).toBe(Infinity);
    for (const v of offsetPath([0, 0, 0, 0, 3, 0], 0.2)) expect(Number.isFinite(v)).toBe(true);
  });

  it('trims the line inside the towns and slices the visible part', () => {
    const poly = polyFromPoints([0, 0, 10, 0, 20, 0]);
    const [d0, d1] = trimSpan(poly, 0, 0, 3, 20, 0, 4);
    // the first vertex 3+ tiles from A is at 10 and the last 4+ tiles from B at 10,
    // but at most 40% of the length is trimmed from each end
    expect(d0).toBeCloseTo(8, 9);
    expect(d1).toBeCloseTo(12, 9);
    const fine = polyFromPoints(Array.from({ length: 41 }, (_, i) => [i * 0.5, 0]).flat());
    const [e0, e1] = trimSpan(fine, 0, 0, 3, 20, 0, 4);
    expect(e0).toBeCloseTo(3, 9);
    expect(e1).toBeCloseTo(16, 9);
    const sl = slicePoly(fine, e0, e1);
    expect(sl[0]).toBeCloseTo(3, 9);
    expect(sl[sl.length - 2]).toBeCloseTo(16, 9);
    expect(slicePoly(fine, 5, 5)).toEqual([]);
  });

  it('chevrons are evenly spaced and drift toward the destination', () => {
    const a = chevronsAt(2, 12, 2.5, 0);
    expect(a).toEqual([2, 4.5, 7, 9.5, 12]);
    const b = chevronsAt(2, 12, 2.5, 1);
    expect(b[0]).toBeCloseTo(3, 9);
    // a full gap of drift brings the same pattern back
    expect(chevronsAt(2, 12, 2.5, 2.5)).toEqual(a);
    expect(chevronsAt(2, 12, 0, 1)).toEqual([]);
    expect(chevronsAt(5, 2, 1, 0)).toEqual([]);
    expect(chevronsAt(0, 3, 1, -0.5)[0]).toBeCloseTo(0.5, 9);
  });
});
