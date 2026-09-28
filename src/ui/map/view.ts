// ============================================================================
// The map view: camera, input and the per-frame composition of all layers.
//
// Draw order (device pixels):
//   terrain chunks → water shimmer → overlay district tints → placement area
//   → road works → selected person's path → buildings (+ construction bars)
//   → wagons & carts → walkers → smoke → day/night tint → lights (windows,
//   furnaces, lamps) → selection / hover rings → placement ghost → labels and
//   overlay badges.
// Input: drag / two-finger scroll pans (with inertia); pinch (ctrl+wheel, or
// Safari gesture events) zooms at the cursor; +/− keys, double-click and the
// buttons zoom smoothly; arrows pan. Hover shows a tooltip; click selects
// (building, person, market hall, town label; a wagon selects its trading
// house); in placement mode valid sites are tinted and a click commissions
// the building through ui.game.dispatch.
// ============================================================================
import { SECTORS } from '../../sim/goods';
import { isFirm, refId } from '../../sim/ledger';
import { rt } from '../../sim/runtime';
import { Terrain, type PlayerAction, type Sector, type SimState } from '../../sim/types';
import { footprintOf, isResourceSector, isValidSite, nearestTown, siteQuality, type SiteWhat } from '../../sim/world/layout';
import { isTyping } from '../dom';
import { act, emit, on, select, setPlacing, toast, ui, type Selection } from '../uiState';
import { hideTip, showTip } from '../widgets/tooltip';
import { createBuildingLayer, lookOf, type BInfo } from './buildings';
import { clampCamera, fitZoom, newCamera, panBy, pickLod, smoothK, wx, wy, zoomAround, clampZoom, type Camera } from './camera';
import {
  DUSK_TINT,
  GOLD,
  GOLD_HI,
  HALO,
  INK,
  NIGHT_TINT,
  PEOPLE_HIDE_SPEED,
  PEOPLE_MIN_ZOOM,
  SERIF,
  SANS,
  TILE_PX,
  TINT_BY_SPEED,
  ZOOM_STEP,
} from './constants';
import { createControls } from './controls';
import { hoverContent, sameTarget, type HoverTarget } from './hover';
import { createLifeLayer, type View } from './life';
import { overlayValues, relColor, type TownValue } from './overlay';
import type { MapView } from './renderer';
import { samplePoly, type PolySample } from './schedule';
import type { Look } from './sprites';
import { createTerrainLayer } from './terrain';

export interface MapDebug {
  cam: Camera;
  /** Render every chunk and sprite the current view needs (synchronously). */
  flush(): void;
  perf(): { frameMs: number; fps: number; walkers: number; carts: number; particles: number; chunksPending: number; pathsPending: number };
  /** Simulate the pointer at a CSS-px point (hover + tooltip). */
  pointAt(x: number, y: number): void;
  /** Simulate a click at a CSS-px point. */
  clickAt(x: number, y: number): void;
  setCamera(x: number, y: number, z: number): void;
}

const KIND_LABEL: Record<string, string> = { capital: 'Capital', farm: 'Farming town', mining: 'Mining town', harbor: 'Harbour' };

function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Night strength 0..1 and dusk/dawn warmth 0..1 at a day fraction (0 = midnight). */
export function daylight(t: number): { night: number; warm: number } {
  const f = ((t % 1) + 1) % 1;
  let night: number;
  if (f < 0.19 || f > 0.87) night = 1;
  else if (f < 0.3) night = 1 - smooth01((f - 0.19) / 0.11);
  else if (f > 0.75) night = smooth01((f - 0.75) / 0.12);
  else night = 0;
  const warm = Math.max(0, 1 - Math.abs(f - 0.265) / 0.07) + Math.max(0, 1 - Math.abs(f - 0.8) / 0.075);
  return { night, warm: Math.min(1, warm) };
}

export function createMapViewImpl(container: HTMLElement): MapView & { debug: MapDebug } {
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas grab';
  canvas.setAttribute('aria-label', 'Map of the realm');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;

  const cam = newCamera();
  const terrain = createTerrainLayer();
  const blds = createBuildingLayer();
  const life = createLifeLayer();

  // camera animation
  let tz = cam.z;
  let zAnchor: { x: number; y: number } | null = null; // CSS px anchor for animated zoom
  let panTo: { x: number; y: number } | null = null;
  let velX = 0;
  let velY = 0;
  let needFit = true;

  let S: SimState | null = null;
  let time = 0;
  let frameMs = 0;
  let fps = 60;
  let lastDay = -1;
  // pointer
  let px = -1;
  let py = -1;
  let inside = false;
  let drag: { id: number; x: number; y: number; lx: number; ly: number; moved: boolean; t: number } | null = null;
  let gesture: number | null = null;
  let hover: HoverTarget = null;
  let hoverNote = '';
  let tipAt = 0;
  let hoverCheckAt = 0;
  // label hit boxes (CSS px): [x0, y0, x1, y1, town]
  let labelBoxes: number[] = [];
  // overlay cache
  let ovKey = '';
  let ovVals: TownValue[] | null = null;
  let ovTint: HTMLCanvasElement | null = null;
  // placement cache
  let plKey = '';
  let plArea: HTMLCanvasElement | null = null;
  let plValid: Uint8Array | null = null;
  // vignette & shimmer
  let vignette: HTMLCanvasElement | null = null;
  let sparkles: Float32Array | null = null; // x, y, phase, speed, len
  const smp: PolySample = { x: 0, y: 0, dx: 1, dy: 0 };

  const controls = createControls(container, {
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    fit: () => fitRealm(true),
  });

  // ---------------------------------------------------------------------------
  // Sizing
  // ---------------------------------------------------------------------------
  function resize(): void {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (w === cam.vw && h === cam.vh && dpr === cam.dpr && canvas.width === Math.round(w * dpr)) return;
    cam.vw = w;
    cam.vh = h;
    cam.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    vignette = null;
    if (S) clampCamera(cam, S.map.w, S.map.h);
  }

  function makeVignette(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(128, 128, 60, 128, 128, 182);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(6,8,12,0.42)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    return c;
  }

  // ---------------------------------------------------------------------------
  // Camera helpers
  // ---------------------------------------------------------------------------
  function townsBox(s: SimState): [number, number, number, number] {
    if (!s.towns.length) return [0, 0, s.map.w, s.map.h];
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (const t of s.towns) {
      const r = Math.max(6, t.radius + 3);
      x0 = Math.min(x0, t.x - r);
      y0 = Math.min(y0, t.y - r);
      x1 = Math.max(x1, t.x + r);
      y1 = Math.max(y1, t.y + r);
    }
    return [Math.max(0, x0), Math.max(0, y0), Math.min(s.map.w, x1), Math.min(s.map.h, y1)];
  }

  function fitRealm(animate: boolean): void {
    const s = S;
    if (!s) return;
    const [x0, y0, x1, y1] = townsBox(s);
    const z = fitZoom(cam.vw, cam.vh, x1 - x0, y1 - y0, 30);
    if (animate) {
      panTo = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      tz = z;
      zAnchor = null;
    } else {
      cam.x = (x0 + x1) / 2;
      cam.y = (y0 + y1) / 2;
      cam.z = tz = z;
    }
  }

  function zoomStep(dir: number, ax?: number, ay?: number): void {
    tz = clampZoom((dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP) * tz);
    zAnchor = ax !== undefined && ay !== undefined ? { x: ax, y: ay } : { x: cam.vw / 2, y: cam.vh / 2 };
    panTo = null;
  }

  function centerOn(x: number, y: number, z?: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    panTo = { x, y };
    velX = velY = 0;
    if (z !== undefined && Number.isFinite(z)) {
      tz = clampZoom(z);
      zAnchor = null;
    } else if (cam.z < 1.2) {
      tz = Math.max(tz, 1.4);
      zAnchor = null;
    }
  }

  function animateCamera(dt: number): void {
    const s = S!;
    // zoom toward target
    if (Math.abs(tz - cam.z) > 1e-4) {
      const k = smoothK(dt, 14);
      const nz = cam.z + (tz - cam.z) * k;
      const z = Math.abs(tz - nz) < 1e-3 ? tz : nz;
      if (zAnchor) zoomAround(cam, zAnchor.x, zAnchor.y, z);
      else cam.z = z;
    } else zAnchor = null;
    if (panTo) {
      const k = smoothK(dt, 9);
      cam.x += (panTo.x - cam.x) * k;
      cam.y += (panTo.y - cam.y) * k;
      if (Math.abs(panTo.x - cam.x) < 0.01 && Math.abs(panTo.y - cam.y) < 0.01) panTo = null;
    }
    // inertia after a drag
    if (!drag && (Math.abs(velX) > 5 || Math.abs(velY) > 5)) {
      panBy(cam, velX * dt, velY * dt);
      const decay = Math.exp(-dt * 5.5);
      velX *= decay;
      velY *= decay;
    } else if (!drag) velX = velY = 0;
    clampCamera(cam, s.map.w, s.map.h);
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  function doReset(s: SimState): void {
    S = s;
    blds.reset();
    life.reset();
    terrain.reset(s);
    ovKey = '';
    plKey = '';
    sparkles = null;
    hover = null;
    hideTip(canvas);
    needFit = true;
  }

  function buildSparkles(s: SimState): Float32Array {
    const m = s.map;
    const out: number[] = [];
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        const t = m.terrain[i];
        if (t !== Terrain.Water && t !== Terrain.DeepWater) continue;
        for (let k = 0; k < 2; k++) {
          const h = hashf(x * 7 + k, y * 13 + 5);
          if (h > (t === Terrain.Water ? 0.4 : 0.22)) continue;
          out.push(x + hashf(x + 3, y * 3 + k), y + hashf(x * 5 + k, y + 11), hashf(x + k * 17, y + 29) * 6.283, 0.7 + 0.9 * hashf(x * 11, y + k), 0.16 + 0.22 * hashf(x + 41, y + k * 3));
        }
      }
    }
    return Float32Array.from(out);
  }

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------
  function overlay(s: SimState): TownValue[] | null {
    const id = ui?.overlay ?? 'none';
    if (id === 'none') return null;
    const key = `${id}|${ui.overlayGood}|${s.day}|${s.towns.length}`;
    if (key === ovKey) return ovVals;
    ovKey = key;
    ovVals = overlayValues(s, id, ui.overlayGood);
    ovTint = null;
    if (ovVals) {
      const m = s.map;
      const c = document.createElement('canvas');
      c.width = m.w;
      c.height = m.h;
      const g = c.getContext('2d')!;
      const img = g.createImageData(m.w, m.h);
      const cols = ovVals.map((v) => parseRgba(relColor(v.rel, 1)));
      for (let i = 0; i < m.w * m.h; i++) {
        const d = m.district[i];
        const t = m.terrain[i];
        if (d < 0 || d >= cols.length || t === Terrain.Water || t === Terrain.DeepWater) continue;
        const c4 = cols[d];
        const rel = Math.abs(ovVals[d].rel);
        img.data[4 * i] = c4[0];
        img.data[4 * i + 1] = c4[1];
        img.data[4 * i + 2] = c4[2];
        img.data[4 * i + 3] = Math.round(255 * (0.1 + 0.32 * Math.min(1, rel)));
      }
      g.putImageData(img, 0, 0);
      ovTint = c;
    }
    return ovVals;
  }

  // ---------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------
  function placingWhat(): { what: SiteWhat; town: number | undefined; w: number; h: number } | null {
    const p = ui?.placing;
    if (!p) return null;
    const what: SiteWhat = p.kind === 'firm' ? ((p.sector || 'bakery') as Sector) : p.kind;
    const [w, h] = p.kind === 'house' ? [1, 1] : p.kind === 'pier' ? footprintOf('pier', '') : footprintOf('firm', what as Sector);
    return { what, town: p.town, w, h };
  }

  function placementMask(s: SimState): void {
    const pw = placingWhat();
    if (!pw) {
      plKey = '';
      plArea = null;
      plValid = null;
      return;
    }
    const r = rt(s);
    const key = `${pw.what}|${pw.town}|${r.buildingVersion}|${r.roadVersion}`;
    if (key === plKey) return;
    plKey = key;
    const m = s.map;
    const valid = new Uint8Array(m.w * m.h);
    const area = new Float32Array(m.w * m.h);
    const res = isResourceSector(pw.what);
    for (let y = 1; y < m.h - 1; y++) {
      for (let x = 1; x < m.w - 1; x++) {
        let ok = false;
        try {
          ok = isValidSite(s, pw.what, x, y, pw.town !== undefined && pw.town >= 0 ? pw.town : undefined);
        } catch {
          ok = false;
        }
        if (!ok) continue;
        valid[y * m.w + x] = 1;
        const q = res ? Math.max(0.15, siteQuality(m, pw.what as Sector, x, y, pw.w, pw.h)) : 0.7;
        for (let yy = y; yy < y + pw.h; yy++) for (let xx = x; xx < x + pw.w; xx++) {
          const j = yy * m.w + xx;
          if (area[j] < q) area[j] = q;
        }
      }
    }
    const c = document.createElement('canvas');
    c.width = m.w;
    c.height = m.h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(m.w, m.h);
    for (let i = 0; i < m.w * m.h; i++) {
      if (!(area[i] > 0)) continue;
      img.data[4 * i] = 120;
      img.data[4 * i + 1] = 220;
      img.data[4 * i + 2] = 150;
      img.data[4 * i + 3] = Math.round(40 + 90 * area[i]);
    }
    g.putImageData(img, 0, 0);
    plArea = c;
    plValid = valid;
  }

  function placementAt(s: SimState, cssX: number, cssY: number): { x: number; y: number; ok: boolean; town: number; w: number; h: number; what: SiteWhat } | null {
    const pw = placingWhat();
    if (!pw) return null;
    const fx = wx(cam, cssX);
    const fy = wy(cam, cssY);
    const x = Math.floor(fx - pw.w / 2 + 0.5);
    const y = Math.floor(fy - pw.h / 2 + 0.5);
    const town = pw.town !== undefined && pw.town >= 0 ? pw.town : nearestTown(s, x + pw.w / 2, y + pw.h / 2);
    let ok = false;
    if (x >= 0 && y >= 0 && x < s.map.w && y < s.map.h) {
      ok = plValid ? plValid[y * s.map.w + x] === 1 : false;
      if (!plValid) {
        try {
          ok = isValidSite(s, pw.what, x, y, town);
        } catch {
          ok = false;
        }
      }
    }
    return { x, y, ok, town, w: pw.w, h: pw.h, what: pw.what };
  }

  function whyNot(s: SimState, what: SiteWhat, x: number, y: number, town: number): string {
    const tn = s.towns[town]?.name ?? 'the town';
    const m = s.map;
    const i = y * m.w + x;
    if (i >= 0 && i < m.occ.length && m.occ[i] >= 0) return 'Something already stands here.';
    if (i >= 0 && i < m.road.length && m.road[i] >= 1) return 'Tracks must stay open; choose a spot beside the road.';
    switch (what) {
      case 'farm':
        return `Farms need open, fertile grassland within reach of ${tn} (outside the town itself).`;
      case 'fishery':
        return `A fishery must stand on the shore facing fishing grounds near ${tn}.`;
      case 'lumber':
        return `A lumber camp must stand in forest near ${tn}.`;
      case 'coalmine':
        return `A coal mine needs coal-bearing hills near ${tn}.`;
      case 'oremine':
        return `An ore mine needs mountains (or hills against them) near ${tn}.`;
      case 'oilwell':
        return `An oil well needs a marsh with oil seeps near ${tn}.`;
      case 'pier':
        return `A pier needs free shallow water by ${tn}’s shore.`;
      default:
        return `Choose open land close to ${tn}.`;
    }
  }

  function place(s: SimState, cssX: number, cssY: number): void {
    const p = ui.placing;
    const pl = placementAt(s, cssX, cssY);
    if (!p || !pl) return;
    if (!pl.ok) {
      toast(whyNot(s, pl.what, pl.x, pl.y, pl.town), 'info');
      return;
    }
    let a: PlayerAction;
    if (p.kind === 'firm') a = { type: 'build', kind: 'firm', sector: (p.sector || 'bakery') as Sector, town: pl.town, x: pl.x, y: pl.y };
    else a = { type: 'build', kind: p.kind, town: pl.town, x: pl.x, y: pl.y };
    const r = act(a, true);
    setPlacing(null);
    plKey = '';
    if (r.ok) emit('select', ui.selection);
  }

  // ---------------------------------------------------------------------------
  // Hit testing
  // ---------------------------------------------------------------------------
  function hitTest(s: SimState, cssX: number, cssY: number): HoverTarget {
    // town labels
    for (let i = 0; i + 4 < labelBoxes.length + 1; i += 5) {
      if (cssX >= labelBoxes[i] && cssX <= labelBoxes[i + 2] && cssY >= labelBoxes[i + 1] && cssY <= labelBoxes[i + 3]) return { kind: 'town', id: labelBoxes[i + 4] };
    }
    const d = cam.dpr;
    const pid = life.hitPerson(cssX * d, cssY * d, Math.max(5, 0.3 * TILE_PX * cam.z) * d);
    if (pid >= 0) return { kind: 'person', id: pid };
    const wid = life.hitWagon(cssX * d, cssY * d, Math.max(7, 0.4 * TILE_PX * cam.z) * d);
    if (wid >= 0) return { kind: 'wagon', id: wid };
    const fx = wx(cam, cssX);
    const fy = wy(cam, cssY);
    const m = s.map;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return null;
    const i = ty * m.w + tx;
    let o = m.occ[i];
    // tall drawings (chimneys, cranes) reach into the tile above their footprint
    if (o < 0 && ty + 1 < m.h && fy - ty > 0.45) {
      const below = m.occ[i + m.w];
      if (below >= 0 && s.buildings[below]?.kind !== 'house') o = below;
    }
    if (o >= 0 && s.buildings[o] && s.buildings[o].status !== 'ruin') return { kind: 'building', id: o };
    return { kind: 'tile', i };
  }

  function updateHover(force = false): void {
    const s = S;
    if (!s || !inside || drag?.moved) {
      if (hover) {
        hover = null;
        hideTip(canvas);
      }
      return;
    }
    let t = hitTest(s, px, py);
    let note = '';
    if (ui.placing) {
      const pl = placementAt(s, px, py);
      t = pl ? { kind: 'tile', i: Math.max(0, pl.y) * s.map.w + Math.max(0, pl.x) } : t;
      if (pl) note = pl.ok ? 'Click to build here.' : whyNot(s, pl.what, pl.x, pl.y, pl.town);
    }
    const now = performance.now();
    const changed = !sameTarget(t, hover) || note !== hoverNote;
    hover = t;
    hoverNote = note;
    canvas.classList.toggle('pointer', !ui.placing && !!t && t.kind !== 'tile');
    if (!t || (t.kind === 'tile' && !ui.placing && !(cam.z >= 1.2))) {
      hideTip(canvas);
      return;
    }
    if (changed || force || now - tipAt > 450) {
      tipAt = now;
      const c = hoverContent(s, t, ui.dayFrac, note || undefined);
      const r = canvas.getBoundingClientRect();
      if (c) showTip(c, r.left + px, r.top + py, canvas);
      else hideTip(canvas);
    }
  }

  function click(cssX: number, cssY: number): void {
    const s = S;
    if (!s) return;
    if (ui.placing) {
      place(s, cssX, cssY);
      return;
    }
    const t = hitTest(s, cssX, cssY);
    let sel: Selection = null;
    if (t) {
      switch (t.kind) {
        case 'town':
          sel = { kind: 'town', id: t.id };
          break;
        case 'person':
          sel = { kind: 'person', id: t.id };
          break;
        case 'wagon': {
          const sh = s.shipments.find((x) => x && x.id === t.id);
          if (sh && isFirm(sh.owner)) sel = { kind: 'firm', id: refId(sh.owner) };
          break;
        }
        case 'building': {
          const b = s.buildings[t.id];
          if (b && b.kind === 'market') sel = { kind: 'market', town: b.town, good: ui.marketGood };
          else sel = { kind: 'building', id: t.id };
          break;
        }
        default:
          sel = null;
      }
    }
    select(sel);
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  const cleanups: (() => void)[] = [];
  const listen = (el: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) => {
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };
  const local = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  listen(canvas, 'pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (e.button === 2) {
      if (ui?.placing) setPlacing(null);
      return;
    }
    if (e.button !== 0) return;
    const [x, y] = local(e);
    drag = { id: e.pointerId, x, y, lx: x, ly: y, moved: false, t: performance.now() };
    velX = velY = 0;
    panTo = null;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  listen(canvas, 'pointermove', (ev) => {
    const e = ev as PointerEvent;
    const [x, y] = local(e);
    px = x;
    py = y;
    inside = true;
    if (drag && e.pointerId === drag.id) {
      const dx = x - drag.lx;
      const dy = y - drag.ly;
      if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) > 4) {
        drag.moved = true;
        canvas.classList.add('grabbing');
        hideTip(canvas);
      }
      if (drag.moved) {
        panBy(cam, dx, dy);
        const now = performance.now();
        const dtm = Math.max(1, now - drag.t) / 1000;
        velX = 0.7 * velX + 0.3 * (dx / dtm);
        velY = 0.7 * velY + 0.3 * (dy / dtm);
        drag.t = now;
      }
      drag.lx = x;
      drag.ly = y;
      return;
    }
    updateHover();
  });
  const endDrag = (ev: Event, cancelled: boolean) => {
    const e = ev as PointerEvent;
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('grabbing');
    if (!d.moved && !cancelled) {
      velX = velY = 0;
      click(d.x, d.y);
    } else if (performance.now() - d.t > 80) velX = velY = 0; // paused before release: no fling
  };
  listen(canvas, 'pointerup', (e) => endDrag(e, false));
  listen(canvas, 'pointercancel', (e) => endDrag(e, true));
  listen(canvas, 'pointerleave', () => {
    inside = false;
    if (!drag) {
      hover = null;
      hideTip(canvas);
    }
  });
  listen(canvas, 'contextmenu', (e) => e.preventDefault());
  listen(canvas, 'dblclick', (ev) => {
    const e = ev as MouseEvent;
    const [x, y] = local(e);
    if (ui?.placing) return;
    zoomStep(e.shiftKey ? -1 : 1, x, y);
  });
  listen(
    canvas,
    'wheel',
    (ev) => {
      const e = ev as WheelEvent;
      e.preventDefault();
      const [x, y] = local(e);
      if (e.ctrlKey) {
        if (gesture !== null) return; // Safari reports the pinch as gesture events
        const f = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0125);
        zoomAround(cam, x, y, cam.z * f);
        tz = cam.z;
        zAnchor = null;
      } else if (e.deltaMode === 1) {
        // a line-stepping mouse wheel: zoom in steps
        zoomStep(e.deltaY < 0 ? 1 : -1, x, y);
      } else {
        panBy(cam, -e.deltaX, -e.deltaY);
        panTo = null;
      }
      velX = velY = 0;
      hideTip(canvas);
    },
    { passive: false },
  );
  // Safari trackpad pinch
  listen(canvas, 'gesturestart', (e) => {
    e.preventDefault();
    gesture = cam.z;
  });
  listen(canvas, 'gesturechange', (ev) => {
    ev.preventDefault();
    const e = ev as unknown as { scale: number; clientX: number; clientY: number };
    if (gesture === null) gesture = cam.z;
    const r = canvas.getBoundingClientRect();
    zoomAround(cam, e.clientX - r.left, e.clientY - r.top, gesture * (e.scale || 1));
    tz = cam.z;
    zAnchor = null;
  });
  listen(canvas, 'gestureend', (e) => {
    e.preventDefault();
    gesture = null;
  });
  listen(window, 'keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-backdrop, .modal')) return;
    const k = e.key;
    if (k === '+' || k === '=') {
      zoomStep(1);
      e.preventDefault();
    } else if (k === '-' || k === '_') {
      zoomStep(-1);
      e.preventDefault();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const step = 140 / (TILE_PX * cam.z);
      const base = panTo ?? { x: cam.x, y: cam.y };
      panTo = { x: base.x + (k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0), y: base.y + (k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0) };
      e.preventDefault();
    }
  });
  const offs = [
    on('center', (p) => {
      const q = p as { x: number; y: number; zoom?: number } | undefined;
      if (q) centerOn(q.x, q.y, q.zoom);
    }),
    on('placing', () => {
      plKey = '';
      canvas.classList.toggle('place', !!ui?.placing);
      updateHover(true);
    }),
    on('newgame', () => {
      S = null;
    }),
  ];

  // ---------------------------------------------------------------------------
  // Drawing helpers
  // ---------------------------------------------------------------------------
  function drawShimmer(v: View): void {
    const s = S!;
    if (!sparkles) sparkles = buildSparkles(s);
    const sp = sparkles;
    const k = v.k;
    const x0 = -v.ox / k - 1;
    const y0 = -v.oy / k - 1;
    const x1 = (v.vw - v.ox) / k + 1;
    const y1 = (v.vh - v.oy) / k + 1;
    const coarse = v.scale < 10;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    let n = 0;
    for (let i = 0; i < sp.length; i += 5) {
      const x = sp[i];
      const y = sp[i + 1];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (coarse && (i / 5) % 3 !== 0) continue;
      const ph = Math.sin(time * sp[i + 3] + sp[i + 2]);
      if (ph < 0.55) continue;
      const a = (ph - 0.55) / 0.45;
      const b = a > 0.75 ? 2 : a > 0.4 ? 1 : 0;
      const drift = Math.sin(time * 0.3 + sp[i + 2]) * 0.12;
      const len = sp[i + 4] * (0.6 + 0.4 * a);
      const sx = v.ox + (x + drift) * k;
      const sy = v.oy + y * k;
      paths[b].moveTo(sx - len * k * 0.5, sy);
      paths[b].lineTo(sx + len * k * 0.5, sy);
      n++;
    }
    if (!n) return;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 0.05 * k);
    const alphas = [0.16, 0.3, 0.5];
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = `rgba(225,242,240,${alphas[b]})`;
      ctx.stroke(paths[b]);
    }
  }

  function drawRoadWorks(s: SimState, v: View): void {
    const k = v.k;
    const w = s.map.w;
    let any = false;
    for (const p of s.projects) {
      if (!p || p.kind !== 'road' || p.status === 'done' || p.status === 'cancelled' || !p.tiles?.length) continue;
      if (!any) {
        any = true;
        ctx.fillStyle = 'rgba(242,205,114,0.85)';
      }
      for (const i of p.tiles) {
        if (s.map.road[i] >= 2) continue;
        const x = (i % w) + 0.5;
        const y = Math.floor(i / w) + 0.5;
        const sx = v.ox + x * k;
        const sy = v.oy + y * k;
        if (sx < -k || sy < -k || sx > v.vw + k || sy > v.vh + k) continue;
        const r = Math.max(1.2 * v.dpr, 0.07 * k);
        ctx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
      }
    }
  }

  function footprintRing(v: View, x: number, y: number, w: number, h: number, color: string, width: number, pulse: number): void {
    const k = v.k;
    const cx = v.ox + (x + w / 2) * k;
    const cy = v.oy + (y + h / 2 + 0.05) * k;
    const rx = (w / 2 + 0.34) * k;
    const ry = (h / 2 + 0.26) * k;
    ctx.save();
    if (pulse > 0) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35 * (1 - pulse);
      ctx.lineWidth = width * 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + pulse * 0.5 * k, ry + pulse * 0.4 * k, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = 'rgba(10,10,10,0.55)';
    ctx.lineWidth = width + 2 * v.dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  function drawSelection(s: SimState, v: View, under: boolean): void {
    const sel = ui?.selection;
    if (!sel) return;
    const pulse = (time * 0.7) % 1;
    const ring = (bid: number) => {
      const b = s.buildings[bid];
      if (b && b.status !== 'ruin') footprintRing(v, b.x, b.y, b.w, b.h, GOLD_HI, 2 * v.dpr, pulse);
    };
    switch (sel.kind) {
      case 'building':
        if (!under) ring(sel.id);
        break;
      case 'firm': {
        const f = s.firms[sel.id];
        if (!under && f && f.building >= 0) ring(f.building);
        break;
      }
      case 'market': {
        const t = s.towns[sel.town];
        if (!under && t && t.market >= 0) ring(t.market);
        break;
      }
      case 'town': {
        const t = s.towns[sel.id];
        if (!t || under) break;
        const k = v.k;
        ctx.save();
        ctx.setLineDash([6 * v.dpr, 5 * v.dpr]);
        ctx.lineDashOffset = -time * 12 * v.dpr;
        ctx.strokeStyle = 'rgba(242,205,114,0.8)';
        ctx.lineWidth = 1.6 * v.dpr;
        ctx.beginPath();
        ctx.arc(v.ox + t.x * k, v.oy + t.y * k, (Math.max(4, t.radius) + 1.5) * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'person': {
        const p = s.people[sel.id];
        if (!p || !p.alive) break;
        const k = v.k;
        if (under) {
          const poly = life.personPath(s, sel.id);
          if (poly && poly.len > 0) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            for (let i = 0; i < poly.cum.length; i++) {
              const x = v.ox + poly.xy[2 * i] * k;
              const y = v.oy + poly.xy[2 * i + 1] * k;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = 'rgba(10,10,10,0.45)';
            ctx.lineWidth = 4 * v.dpr;
            ctx.stroke();
            ctx.setLineDash([5 * v.dpr, 4 * v.dpr]);
            ctx.lineDashOffset = -time * 14 * v.dpr;
            ctx.strokeStyle = GOLD_HI;
            ctx.lineWidth = 2 * v.dpr;
            ctx.stroke();
            ctx.restore();
          }
          return;
        }
        if (p.home >= 0) ring(p.home);
        const f = p.job >= 0 ? s.firms[p.job] : undefined;
        if (f && f.building >= 0) ring(f.building);
        const at = life.personAt(sel.id);
        if (at) {
          const x = v.ox + at.x * k;
          const y = v.oy + at.y * k;
          const r = Math.max(6 * v.dpr, 0.35 * k);
          ctx.strokeStyle = 'rgba(10,10,10,0.6)';
          ctx.lineWidth = 4 * v.dpr;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = GOLD_HI;
          ctx.lineWidth = 2 * v.dpr;
          ctx.stroke();
        }
        break;
      }
    }
  }

  function drawHover(s: SimState, v: View): void {
    const t = hover;
    if (!t || drag?.moved || ui?.placing) return;
    if (t.kind === 'building') {
      const b = s.buildings[t.id];
      if (!b) return;
      const k = v.k;
      ctx.save();
      ctx.strokeStyle = 'rgba(241,233,216,0.7)';
      ctx.lineWidth = 1.2 * v.dpr;
      ctx.setLineDash([3 * v.dpr, 3 * v.dpr]);
      ctx.strokeRect(v.ox + b.x * k + 0.5, v.oy + b.y * k + 0.5, b.w * k, b.h * k);
      ctx.restore();
    } else if (t.kind === 'person') {
      const at = life.personAt(t.id);
      if (!at) return;
      const r = Math.max(5 * v.dpr, 0.3 * v.k);
      ctx.strokeStyle = 'rgba(241,233,216,0.85)';
      ctx.lineWidth = 1.5 * v.dpr;
      ctx.beginPath();
      ctx.arc(v.ox + at.x * v.k, v.oy + at.y * v.k, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawPlacement(s: SimState, v: View, L: number): void {
    if (!ui?.placing) return;
    placementMask(s);
    const k = v.k;
    if (plArea) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.55 + 0.15 * Math.sin(time * 3);
      ctx.drawImage(plArea, v.ox, v.oy, s.map.w * k, s.map.h * k);
      ctx.restore();
    }
    if (!inside) return;
    const pl = placementAt(s, px, py);
    if (!pl) return;
    const x = v.ox + pl.x * k;
    const y = v.oy + pl.y * k;
    const p = ui.placing;
    const kind = p.kind === 'pier' ? 'port' : p.kind;
    const look: Look = {
      id: 999_999,
      kind,
      sector: p.kind === 'firm' ? ((p.sector || 'bakery') as Sector) : '',
      w: pl.w,
      h: pl.h,
      level: 1,
      townKind: s.towns[pl.town]?.kind ?? 'capital',
      town: pl.town,
      treasury: true,
      season: 0,
      waterDir: 2,
      onWater: p.kind === 'pier',
    };
    blds.ghost(ctx, look, Math.min(64, L), k, v.ox, v.oy, pl.x, pl.y, pl.ok ? 0.85 : 0.35);
    ctx.save();
    ctx.lineWidth = 2 * v.dpr;
    ctx.strokeStyle = pl.ok ? 'rgba(130,230,160,0.95)' : 'rgba(240,120,90,0.95)';
    ctx.fillStyle = pl.ok ? 'rgba(130,230,160,0.14)' : 'rgba(240,120,90,0.14)';
    ctx.fillRect(x, y, pl.w * k, pl.h * k);
    ctx.strokeRect(x + 1, y + 1, pl.w * k - 2, pl.h * k - 2);
    ctx.restore();
  }

  function drawProgressBars(v: View, infos: readonly BInfo[]): void {
    const k = v.k;
    if (v.scale < 9) return;
    for (const info of infos) {
      if (info.progress < 0) continue;
      const b = info.b;
      const w = Math.max(18 * v.dpr, Math.min(b.w * k * 0.8, 60 * v.dpr));
      const h = Math.max(3 * v.dpr, 0.08 * k);
      const x = v.ox + (b.x + b.w / 2) * k - w / 2;
      const y = v.oy + (b.y + b.h) * k + 2 * v.dpr;
      if (x > v.vw || y > v.vh || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = 'rgba(12,14,18,0.8)';
      ctx.fillRect(x - v.dpr, y - v.dpr, w + 2 * v.dpr, h + 2 * v.dpr);
      ctx.fillStyle = 'rgba(80,72,56,0.9)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = GOLD;
      ctx.fillRect(x, y, w * Math.max(0, Math.min(1, info.progress)), h);
    }
  }

  function tint(s: SimState, v: View): number {
    const strength = TINT_BY_SPEED[ui?.speed ?? 0] ?? 0;
    const { night, warm } = daylight(ui?.dayFrac ?? 0.5);
    const n = night * strength;
    const w = warm * strength * (1 - 0.6 * night);
    if (n > 0.005 || w > 0.005) {
      let r = 255 + (NIGHT_TINT[0] - 255) * n;
      let g = 255 + (NIGHT_TINT[1] - 255) * n;
      let b = 255 + (NIGHT_TINT[2] - 255) * n;
      r += (DUSK_TINT[0] - 255) * w * 0.55 * (r / 255);
      g += (DUSK_TINT[1] - 255) * w * 0.55 * (g / 255);
      b += (DUSK_TINT[2] - 255) * w * 0.55 * (b / 255);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
      ctx.fillRect(0, 0, v.vw, v.vh);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (!vignette) vignette = makeVignette();
    ctx.globalAlpha = 0.75 + 0.25 * n;
    ctx.drawImage(vignette, 0, 0, v.vw, v.vh);
    ctx.globalAlpha = 1;
    return n;
  }

  function drawLabels(s: SimState, v: View, vals: TownValue[] | null): void {
    labelBoxes = [];
    const d = v.dpr;
    const k = v.k;
    const z = cam.z;
    const nameSize = Math.round(Math.max(11.5, Math.min(21, 10 + 5 * z)) * d);
    const subSize = Math.round(10.5 * d);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    const spacing = Math.max(1, nameSize * 0.14);
    const hasSpacing = 'letterSpacing' in ctx;
    for (const t of s.towns) {
      const lift = Math.max(2.6, Math.min(4.6, t.radius * 0.45)) + 0.4;
      const cx = v.ox + (t.x) * k;
      let cy = v.oy + (t.y - lift) * k;
      cy = Math.max(nameSize + 6 * d, cy);
      if (cx < -200 * d || cx > v.vw + 200 * d || cy < -40 * d || cy > v.vh + 80 * d) continue;
      const name = t.name.toUpperCase();
      ctx.font = `600 ${nameSize}px ${SERIF}`;
      if (hasSpacing) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
      const tw = ctx.measureText(name).width;
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 4 * d;
      ctx.strokeText(name, cx, cy);
      ctx.fillStyle = INK;
      ctx.fillText(name, cx, cy);
      // small gold rule under the name
      ctx.fillStyle = 'rgba(216,171,78,0.85)';
      ctx.fillRect(cx - Math.min(tw * 0.3, 40 * d), cy + 4 * d, Math.min(tw * 0.6, 80 * d), Math.max(1, d));
      let y = cy + 4 * d;
      if (hasSpacing) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
      if (z >= 0.75 && !vals) {
        const sub = `${KIND_LABEL[t.kind] ?? ''} · ${t.pop || 0} households`;
        ctx.font = `italic ${subSize}px ${SERIF}`;
        y += subSize + 3 * d;
        ctx.strokeStyle = HALO;
        ctx.lineWidth = 3 * d;
        ctx.strokeText(sub, cx, y);
        ctx.fillStyle = 'rgba(221,210,186,0.92)';
        ctx.fillText(sub, cx, y);
      }
      const v2 = vals?.[t.id];
      if (v2) {
        // overlay badge
        const fs = Math.round(12.5 * d);
        ctx.font = `700 ${fs}px ${SANS}`;
        const txt = v2.text;
        const bw = ctx.measureText(txt).width + 16 * d;
        const bh = fs + 9 * d;
        const bx = cx - bw / 2;
        const by = y + 5 * d;
        ctx.fillStyle = 'rgba(8,10,14,0.55)';
        roundRectPath(ctx, bx + d, by + 2 * d, bw, bh, bh / 2);
        ctx.fill();
        ctx.fillStyle = relColor(v2.rel, 0.96);
        roundRectPath(ctx, bx, by, bw, bh, bh / 2);
        ctx.fill();
        ctx.fillStyle = '#14171c';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, cx, by + bh / 2 + 0.5 * d);
        ctx.textBaseline = 'alphabetic';
        y = by + bh;
        if (v2.sub && z >= 0.6) {
          ctx.font = `${Math.round(10.5 * d)}px ${SANS}`;
          y += 13 * d;
          ctx.strokeStyle = HALO;
          ctx.lineWidth = 3 * d;
          ctx.strokeText(v2.sub, cx, y);
          ctx.fillStyle = 'rgba(221,210,186,0.95)';
          ctx.fillText(v2.sub, cx, y);
        }
      }
      labelBoxes.push((cx - tw / 2 - 6 * d) / d, (cy - nameSize) / d, (cx + tw / 2 + 6 * d) / d, (y + 4 * d) / d, t.id);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------
  function frame(dt: number): void {
    const t0 = performance.now();
    const s = ui?.game?.s;
    if (!s || !s.map || !(s.map.w > 0)) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0c0f13';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (canvas.width <= 1 || cam.vw <= 1) resize();
    if (s !== S) doReset(s);
    const d = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    time += d;
    if (d > 0) fps = fps * 0.95 + (1 / Math.max(1e-3, d)) * 0.05;
    terrain.sync(s);
    blds.sync(s);
    life.sync(s);
    if (needFit) {
      fitRealm(false);
      needFit = false;
    }
    animateCamera(d);
    const k = TILE_PX * cam.z * cam.dpr;
    const L = Math.min(128, pickLod(k));
    const v: View = {
      k,
      ox: (cam.vw * cam.dpr) / 2 - cam.x * k,
      oy: (cam.vh * cam.dpr) / 2 - cam.y * k,
      vw: canvas.width,
      vh: canvas.height,
      dpr: cam.dpr,
      scale: TILE_PX * cam.z,
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0b0e12';
    ctx.fillRect(0, 0, v.vw, v.vh);
    // soft shadow framing the map board
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 24 * cam.dpr;
    ctx.fillStyle = '#16304f';
    ctx.fillRect(v.ox, v.oy, s.map.w * k, s.map.h * k);
    ctx.restore();
    terrain.draw(ctx, cam, L);
    drawShimmer(v);
    const vals = overlay(s);
    if (ovTint) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(ovTint, v.ox, v.oy, s.map.w * k, s.map.h * k);
      ctx.restore();
    }
    drawPlacementArea(s, v);
    drawRoadWorks(s, v);
    drawSelection(s, v, true);
    const infos = blds.list();
    blds.draw(ctx, L, k, v.ox, v.oy, v.vw, v.vh, time);
    drawProgressBars(v, infos);
    const speed = ui?.speed ?? 0;
    if (ui?.showCarts !== false) life.drawCarts(ctx, s, v, ui?.dayFrac ?? 0.5, speed < PEOPLE_HIDE_SPEED);
    const showPeople = ui?.showPeople !== false && speed < PEOPLE_HIDE_SPEED && cam.z >= PEOPLE_MIN_ZOOM;
    const pAlpha = showPeople ? (speed >= 3 ? 0.6 : 1) * Math.min(1, (cam.z - PEOPLE_MIN_ZOOM) / 0.15 + 0.2) : 0;
    life.drawWalkers(ctx, s, v, ui?.dayFrac ?? 0.5, pAlpha);
    life.update(d, s, infos, v, time, speed);
    life.drawSmoke(ctx, v);
    const night = tint(s, v);
    life.drawLights(ctx, s, infos, v, night, time);
    drawSelection(s, v, false);
    drawHover(s, v);
    drawPlacementCursor(s, v, L);
    drawLabels(s, v, vals);
    // background work, within budget
    const spent = performance.now() - t0;
    const budget = Math.max(2, 12 - spent);
    const n = terrain.work(Math.min(8, budget));
    blds.work(Math.max(1.5, budget - (performance.now() - t0 - spent)));
    if (s.day !== lastDay) {
      lastDay = s.day;
      if (hover) updateHover(true);
    }
    // walkers move under a still pointer: refresh the hover a few times a second
    const now = performance.now();
    if (inside && !drag && now - hoverCheckAt > 250) {
      hoverCheckAt = now;
      updateHover();
    }
    if (now - controlsAt > 300) {
      controlsAt = now;
      controls.sync();
    }
    void n;
    frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }
  let controlsAt = 0;

  function drawPlacementArea(s: SimState, v: View): void {
    if (!ui?.placing) return;
    placementMask(s);
    if (!plArea) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.5 + 0.15 * Math.sin(time * 3);
    ctx.drawImage(plArea, v.ox, v.oy, s.map.w * v.k, s.map.h * v.k);
    ctx.restore();
  }

  function drawPlacementCursor(s: SimState, v: View, L: number): void {
    if (!ui?.placing || !inside) return;
    const pl = placementAt(s, px, py);
    if (!pl) return;
    const k = v.k;
    const x = v.ox + pl.x * k;
    const y = v.oy + pl.y * k;
    const p = ui.placing;
    const look: Look = {
      id: 999_999,
      kind: p.kind === 'pier' ? 'port' : p.kind,
      sector: p.kind === 'firm' ? ((p.sector || 'bakery') as Sector) : '',
      w: pl.w,
      h: pl.h,
      level: 1,
      townKind: s.towns[pl.town]?.kind ?? 'capital',
      town: pl.town,
      treasury: true,
      season: 0,
      waterDir: 2,
      onWater: p.kind === 'pier',
    };
    ctx.save();
    ctx.lineWidth = 2 * v.dpr;
    ctx.strokeStyle = pl.ok ? 'rgba(130,230,160,0.95)' : 'rgba(240,120,90,0.95)';
    ctx.fillStyle = pl.ok ? 'rgba(130,230,160,0.16)' : 'rgba(240,120,90,0.16)';
    ctx.fillRect(x, y, pl.w * k, pl.h * k);
    ctx.restore();
    blds.ghost(ctx, look, Math.min(64, L), k, v.ox, v.oy, pl.x, pl.y, pl.ok ? 0.9 : 0.4);
    ctx.save();
    ctx.lineWidth = 2 * v.dpr;
    ctx.strokeStyle = pl.ok ? 'rgba(130,230,160,0.95)' : 'rgba(240,120,90,0.95)';
    ctx.strokeRect(x + v.dpr, y + v.dpr, pl.w * k - 2 * v.dpr, pl.h * k - 2 * v.dpr);
    ctx.restore();
  }
  void drawPlacement;
  void samplePoly;
  void smp;
  void lookOf;
  void SECTORS;

  resize();

  const debug: MapDebug = {
    cam,
    flush() {
      const s = ui?.game?.s;
      if (!s) return;
      if (s !== S) doReset(s);
      terrain.sync(s);
      blds.sync(s);
      if (needFit) {
        fitRealm(false);
        needFit = false;
      }
      clampCamera(cam, s.map.w, s.map.h);
      const k = TILE_PX * cam.z * cam.dpr;
      const L = Math.min(128, pickLod(k));
      terrain.flush(cam, L);
      // draw once to queue sprites, then build them all
      frame(0);
      for (let i = 0; i < 50 && blds.work(1e9) > 0; i++) frame(0);
      frame(0);
    },
    perf: () => {
      const st = life.stats();
      return { frameMs, fps, walkers: st.walkers, carts: st.carts, particles: st.particles, chunksPending: terrain.pending(), pathsPending: st.pending };
    },
    pointAt(x, y) {
      px = x;
      py = y;
      inside = true;
      updateHover(true);
    },
    clickAt(x, y) {
      click(x, y);
    },
    setCamera(x, y, z) {
      const s = ui?.game?.s;
      if (s && s !== S) doReset(s);
      cam.x = x;
      cam.y = y;
      cam.z = tz = clampZoom(z);
      needFit = false;
      panTo = null;
      zAnchor = null;
    },
  };

  return {
    frame,
    resize,
    centerOn: (x, y) => centerOn(x, y),
    reset() {
      S = null;
      const s = ui?.game?.s;
      if (s) doReset(s);
    },
    destroy() {
      for (const f of cleanups) f();
      for (const f of offs) f();
      hideTip(canvas);
      controls.destroy();
      canvas.remove();
    },
    debug,
  };
}

function hashf(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e37, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function parseRgba(s: string): [number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return [200, 200, 200];
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}
