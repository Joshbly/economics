// ============================================================================
// DEV ONLY: the map renderer on a freshly generated world (no simulation
// needed). Built by scripts/mapdev.mjs into dist/mapdev.html.
//
// URL parameters (all optional):
//   seed=1        world seed
//   x=, y=, z=    camera centre (tiles) and zoom (0.5–4); default: fit the towns
//   t=0.3         time of day (0 midnight, 0.5 noon)
//   anim=0.05     advance the time of day by this many days per second
//   speed=1       speed level shown (0–5) — affects tint/people hiding only
//   people=1000   add synthetic households until this many exist
//   wagons=100    add synthetic shipments until this many are on the roads
//   overlay=price&good=8   overlay (price|unemployment|wealth|health|rent)
//   place=farm&town=1      placement mode (house|pier|<sector>)
//   sel=building:12 | person:40 | town:0 | market:1
//   mx=, my=      pointer position (CSS px) for a hover tooltip
//   step=30       try to simulate this many days first (ignored if the sim throws)
//   day=300       jump the calendar to this day (seasons: farm fields, winter frost, chimney smoke)
//   bench=300     measure this many frames; result in window.__bench and the console
//   dpr=2         override devicePixelRatio
//   pave=0-1      pave the road between towns 0 and 1 (tests paved roads, bridges, chunk invalidation)
//   constr=6      put this many buildings under construction (fake projects, random progress)
//   vacant=4      leave this many workshops standing empty
//   routes=3      add this many synthetic Treasury supply routes (route orders + Treasury wagons on the road)
//   sync=1        (with bench) force rasterisation every frame so timings include drawing
// window.__map exposes { view, debug, ui, s } for scripted checks.
// ============================================================================
import '../styles.css';
import { stepDay } from '../../sim/engine';
import { newPerson, newShipment } from '../../sim/factory';
import { Game } from '../../sim/game';
import { N_GOODS, SECTORS } from '../../sim/goods';
import { STATE, type PlayerOrder, type SimState } from '../../sim/types';
import { createWorld } from '../../sim/world/init';
import { routeBetweenTowns } from '../../sim/world/paths';
import { newProject } from '../../sim/factory';
import { invalidateRoutes, touchBuildings } from '../../sim/runtime';
import { initToasts } from '../modal';
import { initUi, select, setOverlay, setPlacing, ui, type OverlayId } from '../uiState';
import { createMapViewImpl } from './view';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = q.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

if (q.has('dpr')) Object.defineProperty(window, 'devicePixelRatio', { get: () => num('dpr', 1) });

function lcg(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function enrich(s: SimState): void {
  const r = lcg(7);
  // smoke: pretend today's output equals the usual output
  for (const f of s.firms) if (f && f.alive && !(f.producedToday > 0)) f.producedToday = f.output > 0 ? f.output * (0.6 + 0.8 * r()) : 0;
  // more households (dense crowds for perf checks)
  const target = num('people', 0);
  const workplaces = s.firms.filter((f) => f && f.alive && f.building >= 0 && f.sector !== 'stateworks');
  const houses = s.buildings.filter((b) => b && b.kind === 'house' && b.status === 'active');
  let alive = s.people.filter((p) => p && p.alive).length;
  while (alive < target && workplaces.length && houses.length) {
    const h = houses[Math.floor(r() * houses.length)];
    const p = newPerson(s, h.town, 'Extra ' + alive);
    p.home = h.id;
    if (r() < 0.9) {
      const local = workplaces.filter((f) => f.town === h.town);
      const f = (local.length ? local : workplaces)[Math.floor(r() * (local.length || workplaces.length))];
      p.job = f.id;
      p.wage = f.wage;
    }
    alive++;
  }
  // more wagons
  const want = num('wagons', 0);
  const nt = s.towns.length;
  let n = s.shipments.length;
  while (n < want && nt > 1) {
    const a = Math.floor(r() * nt);
    let b = Math.floor(r() * nt);
    if (b === a) b = (a + 1) % nt;
    const days = Math.max(0.3, routeBetweenTowns(s, a, b).days);
    const depart = s.day - r() * days;
    newShipment(s, r() < 0.12 ? STATE : 1_000_000 + (s.firms.find((f) => f && f.sector === 'trader' && f.town === a)?.id ?? 0), a, b, Math.floor(r() * N_GOODS), 5 + r() * 40, 3, depart, depart + days, 1 + Math.floor(r() * 3));
    n++;
  }
  // paved roads
  const pave = q.get('pave');
  if (pave) {
    for (const pair of pave.split(',')) {
      const [a, b] = pair.split('-').map(Number);
      if (!(a >= 0 && b >= 0 && a < nt && b < nt && a !== b)) continue;
      for (const i of routeBetweenTowns(s, a, b).tiles) if (s.map.occ[i] < 0) s.map.road[i] = 2;
    }
    invalidateRoutes(s);
  }
  // construction and vacancy
  const pickB = (pred: (b: SimState['buildings'][number]) => boolean, n: number) => {
    const list = s.buildings.filter((b) => b && pred(b));
    const out: typeof list = [];
    for (let k = 0; k < n && list.length; k++) out.push(list.splice(Math.floor(r() * list.length), 1)[0]);
    return out;
  };
  for (const b of pickB((b) => b.status === 'active' && (b.kind === 'house' || (b.kind === 'firm' && b.sector !== 'builder' && b.sector !== 'trader')), num('constr', 0))) {
    const p = newProject(s, b.kind === 'house' ? 'house' : 'firm', b.town, b.owner, -1, 'test');
    p.building = b.id;
    p.need = { labor: 1000, wood: 200, iron: 20, tools: 10 };
    const f = r();
    p.done = { labor: 1000 * f, wood: 200 * f, iron: 20 * f, tools: 10 * f };
    p.status = 'active';
    b.project = p.id;
    b.status = 'construction';
  }
  for (const b of pickB((b) => b.status === 'active' && b.kind === 'firm' && b.sector !== 'builder' && b.sector !== 'trader', num('vacant', 0))) b.status = 'vacant';
  // Treasury supply routes: route orders and their wagons at various points of the road
  const nRoutes = Math.min(6, num('routes', 0));
  const plan: [number, number, number, number][] = [
    [0, 3, 8, 20], // bread, capital → harbour
    [2, 0, 3, 12], // coal, mining town → capital
    [1, 2, 0, 30], // grain, farming town → mining town
    [3, 1, 1, 8], // fish, harbour → farming town
    [0, 2, 7, 4], // tools, capital → mining town
    [3, 0, 2, 15], // wood, harbour → capital
  ];
  for (let k = 0; k < nRoutes && nt > 1; k++) {
    const [a0, b0, g, perDay] = plan[k];
    const a = a0 % nt;
    const b = b0 % nt === a ? (a + 1) % nt : b0 % nt;
    const days = Math.max(0.3, routeBetweenTowns(s, a, b).days);
    const o: PlayerOrder = {
      id: s.ids.policy++,
      label: 'test route',
      enabled: true,
      market: { kind: 'good', town: a, good: g },
      side: 'buy',
      price: 2 + r() * 4,
      qty: perDay,
      total: -1,
      until: -1,
      once: false,
      filled: perDay * 6,
      value: 0,
      filledToday: perDay,
      created: s.day - 6,
      priceMode: 'fixed',
      band: 0,
      route: { to: b, sell: 'cost', sellPrice: 0, sellMargin: 0.05, inTransit: 0, waiting: perDay * 0.5, landed: 3, shippedToday: perDay, soldToday: perDay * 0.8, shippedTotal: perDay * 6, soldTotal: perDay * 4, freightPaid: 20, revenue: 60 },
    };
    s.policy.orders.push(o);
    for (const f of [0.18, 0.52, 0.83]) {
      const q = Math.round(perDay * (1.5 + r()));
      const depart = s.day + 0.45 - f * days;
      const sh = newShipment(s, STATE, a, b, g, q, 3, depart, depart + days, 1 + Math.floor(r() * 2));
      sh.order = o.id;
      o.route!.inTransit += q;
    }
  }
  touchBuildings(s);
  void SECTORS;
}

const t0 = performance.now();
const s = createWorld({ seed: num('seed', 1) });
const steps = num('step', 0);
let stepped = 0;
for (let i = 0; i < steps; i++) {
  try {
    stepDay(s);
    stepped++;
  } catch (e) {
    console.warn('[mapdev] stepDay failed on day', s.day, e);
    break;
  }
}
enrich(s);
if (q.has('day')) s.day = Math.max(0, Math.floor(num('day', s.day)));
const game = new Game(s);
initUi(game);
initToasts();
ui.dayFrac = num('t', 0.45);
ui.speed = num('speed', 0);
const ov = q.get('overlay') as OverlayId | null;
if (ov) setOverlay(ov, num('good', 8));
const place = q.get('place');
if (place) {
  const kind = place === 'house' || place === 'pier' ? place : 'firm';
  setPlacing({ kind, sector: kind === 'firm' ? place : undefined, town: q.has('town') ? num('town', 0) : undefined });
}
const sel = q.get('sel');
if (sel) {
  const [kind, id] = sel.split(':');
  const n = Number(id);
  if (kind === 'building' || kind === 'person' || kind === 'town' || kind === 'firm') select({ kind, id: n } as never);
  else if (kind === 'market') select({ kind: 'market', town: n, good: 8 });
}

const root = document.getElementById('app')!;
root.style.cssText = 'position:fixed;inset:0;';
const wrap = document.createElement('main');
wrap.className = 'mapwrap';
wrap.style.cssText = 'position:absolute;inset:0;';
root.appendChild(wrap);
const view = createMapViewImpl(wrap);
if (q.has('z')) view.debug.setCamera(num('x', 56), num('y', 38), num('z', 1));
view.debug.flush();
if (q.has('mx')) view.debug.pointAt(num('mx', 0), num('my', 0));
console.log(`[mapdev] world ${s.settings.realmName} seed ${s.seed}: ${s.people.length} people, ${s.buildings.length} buildings, ${s.shipments.length} shipments, stepped ${stepped} days; ready in ${(performance.now() - t0).toFixed(0)} ms`);

const anim = num('anim', 0);
const syncRaster = num('sync', 0) > 0;
const rasterCtx = (wrap.querySelector('canvas') as HTMLCanvasElement | null)?.getContext('2d') ?? null;
let last = 0;
const bench = num('bench', 0);
let frames = 0;
let cpu = 0;
let benchStart = 0;
function loop(t: number): void {
  requestAnimationFrame(loop);
  const dt = last ? Math.min(0.25, (t - last) / 1000) : 0;
  last = t;
  if (anim) ui.dayFrac = (ui.dayFrac + anim * dt) % 1;
  const c0 = performance.now();
  view.frame(dt);
  // sync=1: force the canvas to rasterise now, so the timing includes drawing (not just JS)
  if (syncRaster) rasterCtx?.getImageData(0, 0, 1, 1);
  const c1 = performance.now();
  if (bench > 0 && frames < bench) {
    if (frames === 0) benchStart = t;
    else cpu += c1 - c0;
    frames++;
    if (frames === bench) {
      const wall = (t - benchStart) / 1000;
      const r = { ...view.debug.perf(), frames: bench - 1, cpuMsPerFrame: cpu / (bench - 1), fps: (bench - 1) / Math.max(1e-6, wall) };
      (window as unknown as Record<string, unknown>).__bench = r;
      console.log('[mapdev] bench ' + JSON.stringify(r));
    }
  }
}
requestAnimationFrame(loop);
(window as unknown as Record<string, unknown>).__map = { view, debug: view.debug, ui, s };
