// ============================================================================
// Building icons: small procedural vector drawings, one per kind / sector.
//
// Style: a gentle three-quarter view from the south (roofs seen from above,
// the front wall visible), light from the north-west, soft contact shadows.
// Everything is drawn in tile units relative to the footprint's top-left tile
// (the caller sets the transform), so the same code serves every zoom level.
// Each drawing also reports where its windows, chimneys and furnace mouths are
// (SpriteMeta) so the renderer can light windows at night and emit smoke.
//
// Variants: 'active', 'vacant' (desaturated and boarded up — applied by the
// sprite layer on top of the active drawing), 'scaffold' (foundations and
// scaffolding over the footprint, drawn over a fading ghost of the finished
// building while it is under construction).
// ============================================================================
import type { BuildingKind, Sector, TownKind } from '../../sim/types';
import { DOOR, ROOFS, SHADOW, STONE, STONE_DARK, TIMBER, TIMBER_DARK, WALLS, WINDOW_DAY, shade } from './palette';
import { hash01 } from './schedule';

export interface SpriteMeta {
  /** Window rectangles [x, y, w, h, …] (tiles, relative to the footprint's top-left). */
  windows: number[];
  /** Smoke emitters [x, y, kind, …]; kind 0 dark smoke, 1 light smoke, 2 steam. */
  smoke: number[];
  /** Furnace / oven mouths that glow while working [x, y, r, …]. */
  glow: number[];
  /** Night lamps (always lit after dark) [x, y, …]. */
  lamps: number[];
  /** Highest point of the drawing above the footprint top (tiles, ≤ 0). */
  top: number;
}

export interface Look {
  id: number;
  kind: BuildingKind;
  sector: Sector | '';
  w: number;
  h: number;
  level: number;
  townKind: TownKind;
  town: number;
  /** Owned by the Treasury → a gold pennant. */
  treasury: boolean;
  /** 0 spring … 3 winter (farm fields). */
  season: number;
  /** Direction of the open water from the footprint: 0 E, 1 W, 2 S, 3 N, -1 none. */
  waterDir: number;
  /** The footprint itself stands on water (a pier). */
  onWater: boolean;
}

/** Flag colours per town id. */
export const TOWN_FLAGS = ['#b8433a', '#3f70b3', '#3f8f5a', '#c7902c', '#7d5a9c', '#3a9aa0'];

type Ctx = CanvasRenderingContext2D;

function newMeta(): SpriteMeta {
  return { windows: [], smoke: [], glow: [], lamps: [], top: 0 };
}

function pick<T>(arr: readonly T[], h: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(h * arr.length))];
}

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

function fillRR(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, color: string): void {
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, color: string): void {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(1e-4, rx), Math.max(1e-4, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, w: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

interface BlockOpts {
  roof: string;
  wall: string;
  /** Roof ridge direction. */
  ridge: 'x' | 'y' | 'flat' | 'thatch';
  /** Window columns per storey (0 = none). */
  windows?: number;
  storeys?: number;
  door?: 'centre' | 'left' | 'right' | 'wide' | 'none';
  chimney?: 'left' | 'right' | 'none';
  /** Roof overhang (tiles). */
  eave?: number;
}

/**
 * The house-like block every building is made of: contact shadow, front
 * wall with windows and a door, roof above. (x, y) is the top-left of the
 * roof; d = roof depth, wh = wall height (both tiles).
 */
function block(ctx: Ctx, meta: SpriteMeta, px: number, x: number, y: number, w: number, d: number, wh: number, o: BlockOpts): { chimX: number; chimY: number } {
  const e = o.eave ?? 0.04;
  const storeys = o.storeys ?? 1;
  // contact shadow (light from the north-west → shadow to the south-east)
  ctx.fillStyle = SHADOW;
  rr(ctx, x + 0.05, y + 0.08, w + 0.06, d + wh, 0.05);
  ctx.fill();
  // front wall
  ctx.fillStyle = o.wall;
  ctx.fillRect(x, y + d - 0.02, w, wh + 0.02);
  ctx.fillStyle = shade(o.wall, -0.22);
  ctx.fillRect(x, y + d + wh - Math.max(px, 0.028), w, Math.max(px, 0.028));
  // side shading on the right end of the wall
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.fillRect(x + w - Math.max(px, w * 0.08), y + d, Math.max(px, w * 0.08), wh);
  // windows
  const cols = o.windows ?? 0;
  const doorKind = o.door ?? 'centre';
  if (cols > 0) {
    const ww = Math.min(0.1, (w / cols) * 0.36);
    const wwh = Math.min(0.1, (wh / storeys) * 0.42);
    for (let st = 0; st < storeys; st++) {
      const wy = y + d + (wh / storeys) * st + (wh / storeys) * 0.24;
      for (let c = 0; c < cols; c++) {
        const cx = x + (w / cols) * (c + 0.5);
        // leave the door bay free on the ground floor
        if (st === storeys - 1 && doorKind !== 'none' && doorKind !== 'wide') {
          const dx = doorKind === 'left' ? x + w * 0.22 : doorKind === 'right' ? x + w * 0.78 : x + w / 2;
          if (Math.abs(cx - dx) < ww * 1.2) continue;
        }
        ctx.fillStyle = WINDOW_DAY;
        ctx.fillRect(cx - ww / 2, wy, ww, wwh);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(cx - ww / 2, wy, ww, Math.max(px, wwh * 0.25));
        meta.windows.push(cx - ww / 2, wy, ww, wwh);
      }
    }
  }
  if (doorKind !== 'none') {
    const dw = doorKind === 'wide' ? Math.min(w * 0.4, 0.34) : Math.min(0.12, w * 0.2);
    const dh = Math.min(wh * 0.62, 0.17);
    const dx = doorKind === 'left' ? x + w * 0.22 : doorKind === 'right' ? x + w * 0.78 : x + w / 2;
    ctx.fillStyle = DOOR;
    ctx.fillRect(dx - dw / 2, y + d + wh - dh - Math.max(px, 0.02), dw, dh);
  }
  // roof
  const rx = x - e;
  const rw = w + 2 * e;
  if (o.ridge === 'x') {
    ctx.fillStyle = shade(o.roof, 0.14);
    ctx.fillRect(rx, y, rw, d * 0.46);
    ctx.fillStyle = o.roof;
    ctx.fillRect(rx, y + d * 0.46, rw, d * 0.54);
    line(ctx, rx, y + d * 0.46, rx + rw, y + d * 0.46, shade(o.roof, 0.32), Math.max(px, 0.02));
    ctx.fillStyle = shade(o.roof, -0.3);
    ctx.fillRect(rx, y + d - Math.max(px, 0.03), rw, Math.max(px, 0.03));
  } else if (o.ridge === 'y') {
    ctx.fillStyle = shade(o.roof, 0.14);
    ctx.fillRect(rx, y, rw / 2, d);
    ctx.fillStyle = shade(o.roof, -0.1);
    ctx.fillRect(rx + rw / 2, y, rw / 2, d);
    line(ctx, rx + rw / 2, y, rx + rw / 2, y + d, shade(o.roof, 0.3), Math.max(px, 0.02));
    // gable end facing us
    ctx.fillStyle = o.wall;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.12, y + d);
    ctx.lineTo(x + w / 2, y + d - Math.min(0.14, d * 0.4));
    ctx.lineTo(x + w * 0.88, y + d);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shade(o.roof, -0.3);
    ctx.fillRect(rx, y + d - Math.max(px, 0.025), rw * 0.12, Math.max(px, 0.025));
    ctx.fillRect(rx + rw * 0.88, y + d - Math.max(px, 0.025), rw * 0.12, Math.max(px, 0.025));
  } else if (o.ridge === 'thatch') {
    fillRR(ctx, rx, y, rw, d + 0.02, Math.min(0.12, d * 0.4), o.roof);
    ctx.fillStyle = shade(o.roof, 0.16);
    rr(ctx, rx + 0.02, y + 0.01, rw - 0.04, d * 0.45, Math.min(0.1, d * 0.3));
    ctx.fill();
    ctx.strokeStyle = shade(o.roof, -0.25);
    ctx.lineWidth = Math.max(px, 0.015);
    ctx.beginPath();
    for (let k = 1; k < 5; k++) {
      const yy = y + (d * k) / 5;
      ctx.moveTo(rx + 0.05, yy);
      ctx.lineTo(rx + rw - 0.05, yy);
    }
    ctx.stroke();
  } else {
    ctx.fillStyle = o.roof;
    ctx.fillRect(rx, y, rw, d);
    ctx.fillStyle = shade(o.roof, 0.18);
    ctx.fillRect(rx, y, rw, Math.max(px, 0.035));
    ctx.fillStyle = shade(o.roof, -0.3);
    ctx.fillRect(rx, y + d - Math.max(px, 0.03), rw, Math.max(px, 0.03));
  }
  // chimney on the back slope
  let chimX = -1;
  let chimY = -1;
  if (o.chimney && o.chimney !== 'none') {
    const cw = 0.075;
    const ch = 0.17;
    const cx = o.chimney === 'left' ? x + w * 0.22 : x + w * 0.76;
    const cy = y + d * 0.28;
    ctx.fillStyle = '#6b5446';
    ctx.fillRect(cx - cw / 2, cy - ch, cw, ch);
    ctx.fillStyle = '#3d312a';
    ctx.fillRect(cx - cw / 2 - 0.01, cy - ch, cw + 0.02, Math.max(px, 0.025));
    chimX = cx;
    chimY = cy - ch;
    meta.top = Math.min(meta.top, chimY);
  }
  meta.top = Math.min(meta.top, y);
  return { chimX, chimY };
}

/** Small gold pennant on a pole (Treasury property). */
function pennant(ctx: Ctx, meta: SpriteMeta, px: number, x: number, y: number, big = false): void {
  const hgt = big ? 0.5 : 0.32;
  line(ctx, x, y, x, y - hgt, '#3b3228', Math.max(px, 0.022));
  ctx.fillStyle = '#e1b54f';
  ctx.beginPath();
  ctx.moveTo(x + 0.01, y - hgt);
  ctx.lineTo(x + (big ? 0.3 : 0.2), y - hgt + (big ? 0.07 : 0.05));
  ctx.lineTo(x + 0.01, y - hgt + (big ? 0.15 : 0.1));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,240,190,0.45)';
  ctx.fillRect(x + 0.01, y - hgt, Math.max(px, 0.03), big ? 0.15 : 0.1);
  meta.top = Math.min(meta.top, y - hgt);
}

function flag(ctx: Ctx, meta: SpriteMeta, px: number, x: number, y: number, hgt: number, color: string): void {
  line(ctx, x, y, x, y - hgt, '#2e2a26', Math.max(px, 0.025));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + 0.012, y - hgt);
  ctx.quadraticCurveTo(x + 0.16, y - hgt - 0.03, x + 0.3, y - hgt + 0.02);
  ctx.lineTo(x + 0.3, y - hgt + 0.16);
  ctx.quadraticCurveTo(x + 0.16, y - hgt + 0.1, x + 0.012, y - hgt + 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x + 0.2, y - hgt + 0.01, 0.1, 0.15);
  meta.top = Math.min(meta.top, y - hgt - 0.03);
}

function groundPatch(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, color: string): void {
  ellipse(ctx, cx, cy, rx, ry, color);
}

// ---------------------------------------------------------------------------
// Houses
// ---------------------------------------------------------------------------

function house(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const id = L.id;
  const h1 = hash01(id, 1);
  const h2 = hash01(id, 2);
  const h3 = hash01(id, 3);
  const h4 = hash01(id, 4);
  const h5 = hash01(id, 5);
  const h6 = hash01(id, 6);
  const tk = L.townKind;
  const roof = pick(ROOFS[tk] ?? ROOFS.capital, h1);
  const wall = pick(WALLS[tk] ?? WALLS.capital, h2);
  const tall = tk === 'capital' ? h3 < 0.5 : h3 < 0.18;
  const w = 0.6 + 0.2 * h4;
  const d = 0.34 + 0.08 * h5;
  const wh = tall ? 0.36 : 0.25;
  const x = 0.5 - w / 2 + (h6 - 0.5) * (1 - w) * 0.7;
  const y = Math.max(-0.1, 0.94 - d - wh - 0.06 * h3);
  // a garden patch or a bush beside some houses
  if (h5 > 0.55 && tk !== 'capital') {
    ellipse(ctx, h6 > 0.5 ? 0.12 : 0.88, 0.86, 0.1, 0.08, 'rgba(40,70,36,0.5)');
    ellipse(ctx, h6 > 0.5 ? 0.11 : 0.87, 0.83, 0.08, 0.065, '#5c8a45');
  }
  const ridge: BlockOpts['ridge'] = tk === 'farm' && h1 < 0.55 ? 'thatch' : h3 > 0.62 ? 'y' : 'x';
  block(ctx, meta, px, x, y, w, d, wh, {
    roof,
    wall,
    ridge,
    windows: w > 0.72 ? 3 : 2,
    storeys: tall ? 2 : 1,
    door: h4 < 0.33 ? 'left' : h4 > 0.66 ? 'right' : 'centre',
    chimney: h2 < 0.7 ? (h6 < 0.5 ? 'left' : 'right') : 'none',
  });
  if (L.treasury) pennant(ctx, meta, px, x + w - 0.04, y + d * 0.35);
}

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

const SEASON_FIELDS: [string, string][] = [
  ['#8d7a52', '#86a85a'], // spring: soil and green shoots
  ['#6f9e4b', '#88b35a'], // summer: tall green
  ['#d2ae5c', '#bf9a4a'], // autumn: gold before the harvest
  ['#8a7457', '#7b6750'], // winter: bare soil
];

function farm(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const h1 = hash01(L.id, 11);
  const h2 = hash01(L.id, 12);
  const W = L.w;
  const H = L.h;
  const [c1, c2] = SEASON_FIELDS[Math.max(0, Math.min(3, L.season))];
  // fields: two plots with different furrow directions
  const inset = 0.08;
  const barnLeft = h1 < 0.5;
  const plots: [number, number, number, number, boolean][] = [
    [inset, inset + 0.95, W - 2 * inset, H - 0.95 - 2 * inset, h2 < 0.5],
    [barnLeft ? 1.02 : inset, inset, W - 1.02 - inset, 0.9 - inset, h2 >= 0.5],
  ];
  for (const [x, y, w, h, vert] of plots) {
    if (w <= 0.05 || h <= 0.05) continue;
    ctx.fillStyle = 'rgba(40,34,20,0.25)';
    ctx.fillRect(x + 0.03, y + 0.03, w, h);
    ctx.fillStyle = c1;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c2;
    const n = Math.max(3, Math.round((vert ? w : h) / 0.11));
    const step = (vert ? w : h) / n;
    for (let k = 0; k < n; k += 2) {
      if (vert) ctx.fillRect(x + k * step, y, step * 0.55, h);
      else ctx.fillRect(x, y + k * step, w, step * 0.55);
    }
    ctx.strokeStyle = 'rgba(110,86,52,0.75)';
    ctx.lineWidth = Math.max(px, 0.02);
    ctx.strokeRect(x, y, w, h);
  }
  // haystacks after the harvest
  if (L.season === 2 || L.season === 1) {
    const hx = barnLeft ? 1.5 : 0.55;
    ellipse(ctx, hx + 0.03, 1.55 + 0.03, 0.1, 0.07, 'rgba(0,0,0,0.25)');
    ellipse(ctx, hx, 1.55, 0.1, 0.08, '#d8b560');
    ellipse(ctx, hx - 0.02, 1.53, 0.05, 0.035, '#ebcf7c');
  }
  // barn and silo in the free corner
  const bx = barnLeft ? 0.1 : W - 0.92;
  block(ctx, meta, px, bx, 0.1, 0.62, 0.36, 0.3, { roof: '#7d352c', wall: '#a8473a', ridge: 'x', windows: 0, door: 'wide', chimney: 'none' });
  // white cross on the barn door
  const dcx = bx + 0.31;
  const dy = 0.1 + 0.36 + 0.3 - 0.17 - 0.02;
  line(ctx, dcx - 0.1, dy, dcx + 0.1, dy + 0.17, 'rgba(240,230,210,0.8)', Math.max(px, 0.018));
  line(ctx, dcx + 0.1, dy, dcx - 0.1, dy + 0.17, 'rgba(240,230,210,0.8)', Math.max(px, 0.018));
  // silo
  const sx = barnLeft ? bx + 0.74 : bx - 0.06;
  ctx.fillStyle = SHADOW;
  ctx.fillRect(sx - 0.06, 0.25, 0.16, 0.5);
  ctx.fillStyle = '#b9b4a8';
  ctx.fillRect(sx - 0.09, 0.2, 0.18, 0.54);
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(sx + 0.03, 0.2, 0.06, 0.54);
  ellipse(ctx, sx, 0.2, 0.09, 0.05, '#8f8a7e');
  meta.windows.push(bx + 0.08, 0.52, 0.08, 0.07);
  if (L.treasury) pennant(ctx, meta, px, bx + 0.55, 0.18);
}

/** Vector from the footprint toward open water for dir 0 E, 1 W, 2 S, 3 N. */
const WDX = [1, -1, 0, 0];
const WDY = [0, 0, 1, -1];

function boat(ctx: Ctx, px: number, x: number, y: number, horiz: boolean, sail: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  if (!horiz) ctx.rotate(Math.PI / 2);
  ellipse(ctx, 0.03, 0.05, 0.22, 0.07, 'rgba(10,30,40,0.4)');
  ctx.fillStyle = '#5e3f28';
  ctx.beginPath();
  ctx.moveTo(-0.2, -0.05);
  ctx.lineTo(0.2, -0.05);
  ctx.quadraticCurveTo(0.26, 0, 0.2, 0.05);
  ctx.lineTo(-0.2, 0.05);
  ctx.quadraticCurveTo(-0.24, 0, -0.2, -0.05);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#9b7550';
  ctx.fillRect(-0.16, -0.03, 0.32, 0.06);
  if (sail) {
    ctx.restore();
    ctx.save();
    ctx.translate(x, y);
    line(ctx, 0, 0, 0, -0.3, '#3a2c20', Math.max(px, 0.018));
    ctx.fillStyle = '#efe7d6';
    ctx.beginPath();
    ctx.moveTo(0.01, -0.3);
    ctx.lineTo(0.16, -0.06);
    ctx.lineTo(0.01, -0.06);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function fishery(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const d = L.waterDir >= 0 ? L.waterDir : 2;
  const dx = WDX[d];
  const dy = WDY[d];
  // jetty into the water, a boat moored alongside its end (kept inside the sprite margins)
  const jx0 = 0.5 + dx * 0.25;
  const jy0 = 0.62 + dy * 0.2;
  const jx1 = 0.5 + dx * 0.86;
  const jy1 = 0.62 + dy * 0.6;
  ctx.lineCap = 'butt';
  line(ctx, jx0 + 0.03, jy0 + 0.04, jx1 + 0.03, jy1 + 0.04, 'rgba(10,30,40,0.35)', 0.13);
  line(ctx, jx0, jy0, jx1, jy1, '#8b6a45', 0.12);
  line(ctx, jx0, jy0, jx1, jy1, 'rgba(60,40,24,0.5)', Math.max(px, 0.015));
  const bxp = dy !== 0 ? jx1 + 0.25 : jx1 - dx * 0.02;
  const byp = dy !== 0 ? jy1 - 0.04 : jy1 + 0.2;
  boat(ctx, px, bxp, byp, true, hash01(L.id, 3) < 0.6);
  meta.top = Math.min(meta.top, -0.2);
  // drying rack
  const rx = d === 0 ? 0.12 : 0.62;
  line(ctx, rx, 0.3, rx, 0.48, TIMBER_DARK, Math.max(px, 0.02));
  line(ctx, rx + 0.26, 0.3, rx + 0.26, 0.48, TIMBER_DARK, Math.max(px, 0.02));
  line(ctx, rx, 0.32, rx + 0.26, 0.32, 'rgba(60,50,40,0.8)', Math.max(px, 0.012));
  ctx.fillStyle = '#9fb8c0';
  for (let k = 0; k < 4; k++) ctx.fillRect(rx + 0.03 + k * 0.06, 0.33, 0.025, 0.07);
  // the hut
  const hx = d === 1 ? 0.42 : 0.12;
  block(ctx, meta, px, hx, 0.34, 0.46, 0.26, 0.2, { roof: '#40677e', wall: '#d8d0bf', ridge: 'x', windows: 1, door: 'right', chimney: 'left' });
  if (L.treasury) pennant(ctx, meta, px, hx + 0.4, 0.42);
}

function logPile(ctx: Ctx, px: number, x: number, y: number, n: number): void {
  ellipse(ctx, x + 0.16, y + 0.13, 0.22, 0.07, 'rgba(0,0,0,0.25)');
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < n - r; k++) {
      const lx = x + k * 0.1 + r * 0.05;
      const ly = y - r * 0.08;
      ctx.fillStyle = '#9a6f45';
      ctx.fillRect(lx, ly - 0.04, 0.09, 0.08);
      ellipse(ctx, lx + 0.045, ly, 0.045, 0.04, '#d8b584');
      ellipse(ctx, lx + 0.045, ly, 0.02, 0.018, '#b18655');
    }
  }
}

function lumber(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  groundPatch(ctx, 0.5, 0.58, 0.48, 0.38, 'rgba(160,130,86,0.55)');
  groundPatch(ctx, 0.52, 0.6, 0.38, 0.28, 'rgba(186,156,106,0.5)');
  // stumps
  for (let k = 0; k < 3; k++) {
    const sx = 0.15 + 0.3 * k + 0.1 * hash01(L.id, 20 + k);
    const sy = 0.84 - 0.08 * hash01(L.id, 30 + k);
    ellipse(ctx, sx + 0.02, sy + 0.02, 0.05, 0.03, 'rgba(0,0,0,0.3)');
    ellipse(ctx, sx, sy, 0.05, 0.035, '#c9a372');
    ellipse(ctx, sx, sy, 0.02, 0.014, '#8d6a44');
  }
  logPile(ctx, px, 0.44, 0.72, 4);
  block(ctx, meta, px, 0.1, 0.2, 0.4, 0.26, 0.2, { roof: '#6d4a2e', wall: '#a4825a', ridge: 'x', windows: 1, door: 'right', chimney: 'none' });
  // a saw-horse
  line(ctx, 0.66, 0.42, 0.9, 0.42, TIMBER_DARK, Math.max(px, 0.03));
  line(ctx, 0.7, 0.36, 0.72, 0.5, TIMBER_DARK, Math.max(px, 0.02));
  line(ctx, 0.86, 0.36, 0.84, 0.5, TIMBER_DARK, Math.max(px, 0.02));
  if (L.treasury) pennant(ctx, meta, px, 0.45, 0.28);
}

function heap(ctx: Ctx, x: number, y: number, rx: number, ry: number, color: string): void {
  ellipse(ctx, x + 0.04, y + 0.02, rx * 1.05, ry * 0.45, 'rgba(0,0,0,0.3)');
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x - rx * 0.25, y - ry * 0.35, rx * 0.45, ry * 0.4, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fill();
}

function minecart(ctx: Ctx, px: number, x: number, y: number, load: string): void {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x - 0.08, y + 0.02, 0.18, 0.05);
  ctx.fillStyle = '#5a5550';
  ctx.fillRect(x - 0.09, y - 0.06, 0.18, 0.08);
  ellipse(ctx, x, y - 0.06, 0.08, 0.035, load);
  ellipse(ctx, x - 0.05, y + 0.03, 0.025, 0.025, '#2b2826');
  ellipse(ctx, x + 0.05, y + 0.03, 0.025, 0.025, '#2b2826');
}

function coalmine(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  groundPatch(ctx, 0.5, 0.62, 0.5, 0.36, 'rgba(46,44,42,0.45)');
  heap(ctx, 0.74, 0.86, 0.22, 0.2, '#2e2d2e');
  // engine house
  const r = block(ctx, meta, px, 0.06, 0.42, 0.42, 0.24, 0.22, { roof: '#403c3c', wall: '#8e5b45', ridge: 'x', windows: 1, door: 'left', chimney: 'right' });
  if (r.chimX >= 0) meta.smoke.push(r.chimX, r.chimY, 0);
  // headframe
  const hx = 0.66;
  const top = -0.45;
  const lw = Math.max(px, 0.035);
  line(ctx, hx - 0.18, 0.62, hx, top, '#4a3a2c', lw);
  line(ctx, hx + 0.18, 0.62, hx, top, '#4a3a2c', lw);
  line(ctx, hx - 0.1, 0.2, hx + 0.1, 0.2, '#4a3a2c', Math.max(px, 0.02));
  line(ctx, hx - 0.06, -0.08, hx + 0.06, -0.08, '#4a3a2c', Math.max(px, 0.02));
  ctx.beginPath();
  ctx.arc(hx, top + 0.02, 0.09, 0, Math.PI * 2);
  ctx.strokeStyle = '#2c2520';
  ctx.lineWidth = Math.max(px, 0.03);
  ctx.stroke();
  line(ctx, hx - 0.09, top + 0.02, hx + 0.09, top + 0.02, '#2c2520', Math.max(px, 0.015));
  line(ctx, hx + 0.05, top + 0.06, 0.4, 0.46, 'rgba(40,36,32,0.7)', Math.max(px, 0.01));
  meta.top = Math.min(meta.top, top - 0.1);
  minecart(ctx, px, 0.42, 0.9, '#232323');
  meta.lamps.push(hx, 0.16);
  if (L.treasury) pennant(ctx, meta, px, 0.1, 0.5);
}

function oilwell(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  groundPatch(ctx, 0.55, 0.7, 0.42, 0.26, 'rgba(34,30,40,0.45)');
  // tank
  ctx.fillStyle = SHADOW;
  ctx.fillRect(0.14, 0.6, 0.3, 0.3);
  ctx.fillStyle = '#5b5465';
  ctx.fillRect(0.1, 0.56, 0.28, 0.3);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(0.3, 0.56, 0.08, 0.3);
  ellipse(ctx, 0.24, 0.56, 0.14, 0.06, '#7a7386');
  line(ctx, 0.1, 0.7, 0.38, 0.7, 'rgba(0,0,0,0.3)', Math.max(px, 0.015));
  // derrick
  const bx = 0.66;
  const top = -0.7;
  const lw = Math.max(px, 0.028);
  const c = '#3a3230';
  line(ctx, bx - 0.2, 0.86, bx - 0.03, top, c, lw);
  line(ctx, bx + 0.2, 0.86, bx + 0.03, top, c, lw);
  for (let k = 1; k < 5; k++) {
    const t = k / 5;
    const yy = 0.86 + (top - 0.86) * t;
    const hw = 0.2 + (0.03 - 0.2) * t;
    line(ctx, bx - hw, yy, bx + hw, yy, c, Math.max(px, 0.014));
    if (k < 4) {
      const t2 = (k + 1) / 5;
      const y2 = 0.86 + (top - 0.86) * t2;
      const hw2 = 0.2 + (0.03 - 0.2) * t2;
      line(ctx, bx - hw, yy, bx + hw2, y2, 'rgba(58,50,48,0.7)', Math.max(px, 0.01));
    }
  }
  ctx.fillStyle = '#4a403c';
  ctx.fillRect(bx - 0.26, 0.82, 0.52, 0.07);
  meta.top = Math.min(meta.top, top - 0.05);
  meta.lamps.push(bx, top + 0.02);
  meta.smoke.push(bx, top, 0);
  if (L.treasury) pennant(ctx, meta, px, 0.14, 0.52);
}

function oremine(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  // rock face with a timbered tunnel mouth
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0.52, 0.66, 0.5, 0.42, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8d8578';
  ctx.beginPath();
  ctx.ellipse(0.48, 0.62, 0.48, 0.44, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a9a092';
  ctx.beginPath();
  ctx.ellipse(0.36, 0.5, 0.26, 0.24, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#18140f';
  ctx.beginPath();
  ctx.ellipse(0.5, 0.62, 0.14, 0.17, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  const lw = Math.max(px, 0.035);
  line(ctx, 0.35, 0.63, 0.35, 0.42, TIMBER, lw);
  line(ctx, 0.65, 0.63, 0.65, 0.42, TIMBER, lw);
  line(ctx, 0.32, 0.43, 0.68, 0.43, TIMBER, lw);
  // rails and a cart of ore
  line(ctx, 0.46, 0.63, 0.44, 0.98, '#4d4540', Math.max(px, 0.014));
  line(ctx, 0.54, 0.63, 0.56, 0.98, '#4d4540', Math.max(px, 0.014));
  minecart(ctx, px, 0.5, 0.86, '#9a5a42');
  heap(ctx, 0.84, 0.88, 0.14, 0.14, '#9b5a42');
  meta.lamps.push(0.5, 0.5);
  if (L.treasury) pennant(ctx, meta, px, 0.2, 0.3);
}

function chimneyStack(ctx: Ctx, meta: SpriteMeta, px: number, x: number, yBase: number, top: number, w: number): void {
  ctx.fillStyle = SHADOW;
  ctx.fillRect(x - w / 2 + 0.05, top + 0.1, w, yBase - top);
  ctx.fillStyle = '#8a4b38';
  ctx.fillRect(x - w / 2, top, w, yBase - top);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x + w * 0.1, top, w * 0.4, yBase - top);
  ctx.fillStyle = '#3d2c24';
  ctx.fillRect(x - w / 2 - 0.015, top, w + 0.03, Math.max(px, 0.05));
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let yy = top + 0.12; yy < yBase - 0.05; yy += 0.12) ctx.fillRect(x - w / 2, yy, w, Math.max(px, 0.012));
  meta.smoke.push(x, top, 0);
  meta.top = Math.min(meta.top, top);
}

function smelter(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  groundPatch(ctx, 1.0, 0.7, 0.95, 0.3, 'rgba(60,46,40,0.35)');
  heap(ctx, 0.2, 0.9, 0.14, 0.12, '#9b5a42');
  heap(ctx, 0.46, 0.92, 0.12, 0.1, '#2e2d2e');
  block(ctx, meta, px, 0.14, 0.22, 1.24, 0.34, 0.3, { roof: '#454043', wall: '#95553f', ridge: 'x', windows: 3, door: 'wide', chimney: 'none' });
  // furnace mouth
  ctx.fillStyle = '#2a1a14';
  ctx.fillRect(0.3, 0.72, 0.16, 0.12);
  ctx.fillStyle = '#e8743a';
  ctx.fillRect(0.32, 0.75, 0.12, 0.08);
  meta.glow.push(0.38, 0.79, 0.22);
  chimneyStack(ctx, meta, px, 1.62, 0.9, -0.95, 0.18);
  if (L.level >= 2) chimneyStack(ctx, meta, px, 1.84, 0.92, -0.55, 0.12);
  if (L.treasury) pennant(ctx, meta, px, 0.24, 0.3);
}

function sign(ctx: Ctx, px: number, x: number, y: number, draw: (cx: number, cy: number) => void): void {
  line(ctx, x, y, x, y - 0.26, TIMBER_DARK, Math.max(px, 0.02));
  line(ctx, x, y - 0.24, x + 0.14, y - 0.24, TIMBER_DARK, Math.max(px, 0.018));
  ctx.fillStyle = '#e4d6b4';
  ctx.fillRect(x + 0.04, y - 0.23, 0.18, 0.13);
  ctx.strokeStyle = TIMBER_DARK;
  ctx.lineWidth = Math.max(px, 0.012);
  ctx.strokeRect(x + 0.04, y - 0.23, 0.18, 0.13);
  draw(x + 0.13, y - 0.165);
}

function townWorkshop(ctx: Ctx, L: Look, meta: SpriteMeta, px: number, o: { roof: string; wall: string; smoke: number; icon?: (cx: number, cy: number) => void; extra?: () => void }): { x: number; y: number; w: number; d: number; wh: number } {
  const lvl = Math.max(1, Math.min(4, L.level || 1));
  const w = Math.min(0.9, 0.66 + 0.06 * (lvl - 1));
  const d = 0.36;
  const wh = lvl >= 3 ? 0.34 : 0.27;
  const x = 0.5 - w / 2;
  const y = 0.92 - d - wh;
  o.extra?.();
  const r = block(ctx, meta, px, x, y, w, d, wh, { roof: o.roof, wall: o.wall, ridge: 'x', windows: 2, storeys: lvl >= 3 ? 2 : 1, door: 'centre', chimney: o.smoke >= 0 ? 'right' : 'none' });
  if (r.chimX >= 0 && o.smoke >= 0) meta.smoke.push(r.chimX, r.chimY, o.smoke);
  if (o.icon) sign(ctx, px, x - 0.02, y + d + wh, o.icon);
  if (L.treasury) pennant(ctx, meta, px, x + w * 0.35, y + d * 0.3);
  return { x, y, w, d, wh };
}

function toolworks(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  townWorkshop(ctx, L, meta, px, {
    roof: '#4b5058',
    wall: '#b7ab98',
    smoke: 0,
    icon: (cx, cy) => {
      ctx.fillStyle = '#34302c';
      ctx.fillRect(cx - 0.06, cy - 0.03, 0.12, 0.03);
      ctx.fillRect(cx - 0.025, cy, 0.05, 0.03);
      ctx.fillRect(cx - 0.05, cy + 0.03, 0.1, 0.015);
    },
  });
  meta.glow.push(0.5, 0.82, 0.16);
}

function bakery(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const b = townWorkshop(ctx, L, meta, px, {
    roof: '#a54a36',
    wall: '#ead9b7',
    smoke: -1,
    icon: (cx, cy) => {
      ellipse(ctx, cx, cy + 0.005, 0.065, 0.035, '#c98a45');
      line(ctx, cx - 0.03, cy - 0.01, cx - 0.01, cy + 0.02, '#8a5a2a', Math.max(px, 0.008));
      line(ctx, cx + 0.01, cy - 0.01, cx + 0.03, cy + 0.02, '#8a5a2a', Math.max(px, 0.008));
    },
  });
  // brick oven dome at the side, with its own flue
  const ox = b.x + b.w + 0.02;
  const oy = b.y + b.d + b.wh;
  ellipse(ctx, ox + 0.03, oy + 0.01, 0.16, 0.05, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = '#b0654a';
  ctx.beginPath();
  ctx.ellipse(ox, oy, 0.15, 0.2, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.ellipse(ox - 0.04, oy - 0.06, 0.07, 0.09, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2b1a12';
  ctx.beginPath();
  ctx.ellipse(ox, oy, 0.05, 0.06, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b5446';
  ctx.fillRect(ox + 0.04, oy - 0.34, 0.06, 0.18);
  meta.smoke.push(ox + 0.07, oy - 0.34, 1);
  meta.glow.push(ox, oy - 0.02, 0.14);
  meta.top = Math.min(meta.top, oy - 0.36);
}

function barrel(ctx: Ctx, px: number, x: number, y: number): void {
  ellipse(ctx, x + 0.02, y + 0.06, 0.06, 0.025, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = '#8a5a30';
  ctx.fillRect(x - 0.05, y - 0.06, 0.1, 0.12);
  ctx.fillStyle = '#3e3028';
  ctx.fillRect(x - 0.05, y - 0.03, 0.1, Math.max(px, 0.012));
  ctx.fillRect(x - 0.05, y + 0.03, 0.1, Math.max(px, 0.012));
  ellipse(ctx, x, y - 0.06, 0.05, 0.02, '#a9774a');
}

function brewery(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  townWorkshop(ctx, L, meta, px, {
    roof: '#6b4a34',
    wall: '#c49a6a',
    smoke: 2,
    icon: (cx, cy) => {
      ctx.fillStyle = '#c28a3a';
      ctx.fillRect(cx - 0.035, cy - 0.04, 0.06, 0.08);
      ctx.fillStyle = '#f2ead6';
      ctx.fillRect(cx - 0.035, cy - 0.045, 0.06, 0.018);
      ctx.strokeStyle = '#c28a3a';
      ctx.lineWidth = Math.max(px, 0.01);
      ctx.strokeRect(cx + 0.025, cy - 0.02, 0.02, 0.03);
    },
  });
  barrel(ctx, px, 0.86, 0.86);
  barrel(ctx, px, 0.76, 0.9);
  barrel(ctx, px, 0.82, 0.78);
}

function furniture(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  townWorkshop(ctx, L, meta, px, {
    roof: '#56724c',
    wall: '#cbb08a',
    smoke: 1,
    icon: (cx, cy) => {
      const c = '#5a3c26';
      const lw = Math.max(px, 0.012);
      line(ctx, cx - 0.03, cy - 0.05, cx - 0.03, cy + 0.05, c, lw);
      line(ctx, cx - 0.03, cy + 0.005, cx + 0.03, cy + 0.005, c, lw);
      line(ctx, cx + 0.03, cy + 0.005, cx + 0.03, cy + 0.05, c, lw);
    },
  });
  // planks stacked outside
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0.72, 0.84, 0.24, 0.06);
  for (let k = 0; k < 3; k++) {
    ctx.fillStyle = k % 2 ? '#c39a66' : '#d6b07a';
    ctx.fillRect(0.7, 0.8 - k * 0.035, 0.24, 0.035);
  }
}

// ---------------------------------------------------------------------------
// Services & civic buildings
// ---------------------------------------------------------------------------

function crane(ctx: Ctx, meta: SpriteMeta, px: number, x: number, yBase: number, top: number, jib: number): void {
  const c = '#5b4a36';
  line(ctx, x + 0.04, yBase + 0.02, x + 0.04 + 0.22, yBase + 0.06, 'rgba(0,0,0,0.3)', Math.max(px, 0.04));
  line(ctx, x, yBase, x, top, c, Math.max(px, 0.04));
  line(ctx, x - 0.12, top + 0.04, x + jib, top + 0.04, c, Math.max(px, 0.03));
  line(ctx, x, top - 0.1, x + jib * 0.8, top + 0.04, 'rgba(70,56,40,0.8)', Math.max(px, 0.012));
  line(ctx, x, top - 0.1, x - 0.12, top + 0.04, 'rgba(70,56,40,0.8)', Math.max(px, 0.012));
  ctx.fillStyle = '#6f6a62';
  ctx.fillRect(x - 0.16, top + 0.02, 0.07, 0.07);
  line(ctx, x + jib * 0.85, top + 0.05, x + jib * 0.85, top + 0.45, 'rgba(40,36,30,0.8)', Math.max(px, 0.01));
  ctx.fillStyle = '#b89a6a';
  ctx.fillRect(x + jib * 0.85 - 0.05, top + 0.45, 0.1, 0.06);
  meta.top = Math.min(meta.top, top - 0.12);
}

function builder(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  // yard fence
  ctx.fillStyle = 'rgba(150,126,86,0.4)';
  ctx.fillRect(0.06, 0.2, L.w - 0.12, 0.72);
  ctx.strokeStyle = '#7a5e3e';
  ctx.lineWidth = Math.max(px, 0.02);
  ctx.strokeRect(0.06, 0.2, L.w - 0.12, 0.72);
  // timber and stone
  logPile(ctx, px, 1.12, 0.84, 5);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0.66, 0.74, 0.3, 0.14);
  for (let k = 0; k < 3; k++) {
    ctx.fillStyle = k % 2 ? '#aaa295' : '#c1b9aa';
    ctx.fillRect(0.64 + k * 0.1, 0.72 - (k % 2) * 0.04, 0.09, 0.09);
  }
  block(ctx, meta, px, 0.12, 0.26, 0.46, 0.26, 0.22, { roof: '#7b5638', wall: '#b39570', ridge: 'x', windows: 1, door: 'right', chimney: 'none' });
  crane(ctx, meta, px, 1.52, 0.8, -0.6, 0.42);
  if (L.treasury) pennant(ctx, meta, px, 0.2, 0.32);
}

function wagonIcon(ctx: Ctx, px: number, x: number, y: number, load: string | null): void {
  ellipse(ctx, x + 0.03, y + 0.06, 0.2, 0.05, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = '#7a5634';
  ctx.fillRect(x - 0.16, y - 0.06, 0.32, 0.1);
  if (load) {
    ctx.fillStyle = load;
    rr(ctx, x - 0.14, y - 0.13, 0.28, 0.09, 0.03);
    ctx.fill();
  }
  ellipse(ctx, x - 0.1, y + 0.05, 0.045, 0.045, '#2d241c');
  ellipse(ctx, x + 0.1, y + 0.05, 0.045, 0.045, '#2d241c');
  line(ctx, x + 0.16, y, x + 0.3, y + 0.02, '#5a4028', Math.max(px, 0.015));
}

function trader(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  block(ctx, meta, px, 0.1, 0.16, 1.3, 0.4, 0.3, { roof: '#7a4e32', wall: '#c9ad85', ridge: 'x', windows: 3, door: 'wide', chimney: 'none', eave: 0.06 });
  // crates
  const cc = ['#a07a4c', '#8a6a42', '#b08654'];
  for (let k = 0; k < 3; k++) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(1.52 + (k % 2) * 0.13 + 0.02, 0.62 + Math.floor(k / 2) * 0.13 + 0.02, 0.12, 0.12);
    ctx.fillStyle = cc[k];
    ctx.fillRect(1.52 + (k % 2) * 0.13, 0.62 + Math.floor(k / 2) * 0.13, 0.12, 0.12);
    ctx.strokeStyle = 'rgba(60,40,24,0.6)';
    ctx.lineWidth = Math.max(px, 0.01);
    ctx.strokeRect(1.52 + (k % 2) * 0.13, 0.62 + Math.floor(k / 2) * 0.13, 0.12, 0.12);
  }
  wagonIcon(ctx, px, 0.46, 0.96, '#d9c9a0');
  if (L.treasury) pennant(ctx, meta, px, 0.3, 0.26);
}

function market(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const flagC = TOWN_FLAGS[L.town % TOWN_FLAGS.length];
  // stalls around the hall
  const stall = (x: number, y: number, c: string) => {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x + 0.03, y + 0.05, 0.24, 0.18);
    ctx.fillStyle = '#8a6a45';
    ctx.fillRect(x + 0.02, y + 0.1, 0.2, 0.1);
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 0.24, 0.11);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let k = 0; k < 3; k++) ctx.fillRect(x + 0.02 + k * 0.08, y, 0.035, 0.11);
  };
  stall(0.02, 1.58, '#b8433a');
  stall(1.72, 1.56, '#3f70b3');
  stall(0.0, 0.52, '#c7902c');
  // the hall: a great roof on posts
  const x = 0.22;
  const y = 0.18;
  const w = 1.56;
  const d = 0.92;
  const wh = 0.44;
  ctx.fillStyle = SHADOW;
  rr(ctx, x + 0.06, y + 0.1, w + 0.06, d + wh, 0.06);
  ctx.fill();
  // floor under the roof, seen between the posts
  ctx.fillStyle = '#8f7c5d';
  ctx.fillRect(x, y + d - 0.02, w, wh);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x, y + d - 0.02, w, wh * 0.35);
  // goods under the roof
  const goods = ['#d9934a', '#e3c26b', '#6fb7d6', '#9a6b3f', '#b5772b'];
  for (let k = 0; k < 5; k++) {
    ctx.fillStyle = goods[k];
    ctx.fillRect(x + 0.12 + k * 0.28, y + d + wh * 0.55, 0.16, 0.1);
  }
  // posts
  for (let k = 0; k <= 4; k++) {
    const px0 = x + 0.02 + (k * (w - 0.08)) / 4;
    ctx.fillStyle = '#5c4430';
    ctx.fillRect(px0, y + d - 0.02, 0.05, wh);
  }
  // roof with a striped awning edge
  ctx.fillStyle = '#7d4a36';
  ctx.fillRect(x - 0.06, y, w + 0.12, d * 0.5);
  ctx.fillStyle = '#945840';
  ctx.fillRect(x - 0.06, y + d * 0.5, w + 0.12, d * 0.5);
  line(ctx, x - 0.06, y + d * 0.5, x + w + 0.06, y + d * 0.5, '#b37558', Math.max(px, 0.025));
  const n = 12;
  const sw = (w + 0.12) / n;
  for (let k = 0; k < n; k++) {
    ctx.fillStyle = k % 2 ? '#efe4cc' : flagC;
    ctx.beginPath();
    const sx0 = x - 0.06 + k * sw;
    ctx.moveTo(sx0, y + d - 0.1);
    ctx.lineTo(sx0 + sw, y + d - 0.1);
    ctx.lineTo(sx0 + sw, y + d);
    ctx.quadraticCurveTo(sx0 + sw / 2, y + d + 0.07, sx0, y + d);
    ctx.closePath();
    ctx.fill();
  }
  // cupola and flag
  ctx.fillStyle = '#6a3e2e';
  ctx.fillRect(x + w / 2 - 0.12, y + 0.08, 0.24, 0.2);
  ctx.fillStyle = '#c9a25a';
  ctx.beginPath();
  ctx.moveTo(x + w / 2 - 0.15, y + 0.1);
  ctx.lineTo(x + w / 2, y - 0.06);
  ctx.lineTo(x + w / 2 + 0.15, y + 0.1);
  ctx.closePath();
  ctx.fill();
  flag(ctx, meta, px, x + w / 2, y - 0.05, 0.5, flagC);
  meta.lamps.push(x + 0.1, y + d + 0.1, x + w - 0.1, y + d + 0.1, x + w / 2, y + d + 0.2);
  meta.top = Math.min(meta.top, y - 0.6);
}

function bank(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const x = 0.1;
  const y = 0.12;
  const w = 1.8;
  const d = 0.34;
  const wh = 0.4;
  ctx.fillStyle = SHADOW;
  rr(ctx, x + 0.06, y + 0.12, w + 0.06, d + wh + 0.1, 0.05);
  ctx.fill();
  // steps
  ctx.fillStyle = '#c9c1b0';
  ctx.fillRect(x + 0.15, y + d + wh, w - 0.3, 0.06);
  ctx.fillStyle = '#b3ab9b';
  ctx.fillRect(x + 0.1, y + d + wh + 0.06, w - 0.2, 0.05);
  // façade
  ctx.fillStyle = '#ddd4c1';
  ctx.fillRect(x, y + d, w, wh);
  ctx.fillStyle = '#6c6456';
  ctx.fillRect(x + w / 2 - 0.1, y + d + wh - 0.24, 0.2, 0.24);
  // columns
  for (let k = 0; k < 6; k++) {
    const cx = x + 0.12 + (k * (w - 0.24)) / 5;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(cx + 0.02, y + d + 0.05, 0.07, wh - 0.05);
    ctx.fillStyle = '#f4efe4';
    ctx.fillRect(cx - 0.035, y + d + 0.04, 0.07, wh - 0.05);
  }
  ctx.fillStyle = '#efe8da';
  ctx.fillRect(x - 0.03, y + d, w + 0.06, 0.05);
  // roof and pediment
  ctx.fillStyle = '#a8a092';
  ctx.fillRect(x - 0.04, y, w + 0.08, d);
  ctx.fillStyle = '#e6dfd0';
  ctx.beginPath();
  ctx.moveTo(x + 0.05, y + d + 0.01);
  ctx.lineTo(x + w / 2, y + d - 0.26);
  ctx.lineTo(x + w - 0.05, y + d + 0.01);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#9e9584';
  ctx.lineWidth = Math.max(px, 0.018);
  ctx.stroke();
  ellipse(ctx, x + w / 2, y + d - 0.08, 0.06, 0.05, '#d8ab4e');
  meta.windows.push(x + 0.3, y + d + 0.12, 0.08, 0.12, x + w - 0.38, y + d + 0.12, 0.08, 0.12);
  meta.lamps.push(x + 0.08, y + d + wh + 0.05, x + w - 0.08, y + d + wh + 0.05);
  meta.top = Math.min(meta.top, y - 0.05);
}

function palace(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  // courtyard wall
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0.08, 0.14, 1.9, 1.84);
  ctx.fillStyle = '#b9ad95';
  ctx.fillRect(0.04, 0.1, 1.92, 1.84);
  ctx.fillStyle = '#9d9380';
  ctx.fillRect(0.12, 0.18, 1.76, 1.68);
  ctx.fillStyle = '#b7a784';
  ctx.fillRect(0.16, 1.1, 1.68, 0.72);
  // garden beds
  ellipse(ctx, 0.5, 1.5, 0.22, 0.12, '#5f8a48');
  ellipse(ctx, 1.5, 1.5, 0.22, 0.12, '#5f8a48');
  // gate
  ctx.fillStyle = '#b9ad95';
  ctx.fillRect(0.82, 1.84, 0.36, 0.12);
  ctx.fillStyle = '#4b3a2a';
  ctx.fillRect(0.9, 1.86, 0.2, 0.1);
  ctx.fillStyle = '#d8ab4e';
  ctx.fillRect(0.9, 1.86, 0.2, Math.max(px, 0.02));
  // main hall
  block(ctx, meta, px, 0.26, 0.3, 1.48, 0.42, 0.4, { roof: '#5b6f7c', wall: '#e8dfcb', ridge: 'x', windows: 6, storeys: 2, door: 'centre', chimney: 'none', eave: 0.05 });
  // corner towers
  const tower = (tx: number) => {
    ctx.fillStyle = SHADOW;
    ctx.fillRect(tx - 0.1, 0.62, 0.26, 0.6);
    ctx.fillStyle = '#e1d7c1';
    ctx.fillRect(tx - 0.13, 0.48, 0.26, 0.64);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(tx + 0.03, 0.48, 0.1, 0.64);
    ctx.fillStyle = '#4c5f6b';
    ctx.beginPath();
    ctx.moveTo(tx - 0.16, 0.5);
    ctx.lineTo(tx, 0.08);
    ctx.lineTo(tx + 0.16, 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(tx - 0.16, 0.5);
    ctx.lineTo(tx, 0.08);
    ctx.lineTo(tx - 0.02, 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = WINDOW_DAY;
    ctx.fillRect(tx - 0.03, 0.7, 0.06, 0.1);
    meta.windows.push(tx - 0.03, 0.7, 0.06, 0.1);
  };
  tower(0.24);
  tower(1.76);
  // the dome
  const cx = 1.0;
  const cy = 0.46;
  ellipse(ctx, cx + 0.04, cy + 0.04, 0.3, 0.1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = '#e8dfcb';
  ctx.fillRect(cx - 0.26, cy - 0.12, 0.52, 0.14);
  ctx.fillStyle = '#c99a3c';
  ctx.beginPath();
  ctx.ellipse(cx, cy - 0.1, 0.27, 0.32, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#eccb74';
  ctx.beginPath();
  ctx.ellipse(cx - 0.08, cy - 0.16, 0.1, 0.2, 0, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a57a2a';
  ctx.fillRect(cx - 0.04, cy - 0.5, 0.08, 0.1);
  // gold banner
  const top = cy - 0.5;
  line(ctx, cx, top, cx, top - 0.5, '#3b3228', Math.max(px, 0.025));
  ctx.fillStyle = '#e1b54f';
  ctx.beginPath();
  ctx.moveTo(cx + 0.01, top - 0.5);
  ctx.quadraticCurveTo(cx + 0.2, top - 0.54, cx + 0.42, top - 0.47);
  ctx.lineTo(cx + 0.36, top - 0.38);
  ctx.lineTo(cx + 0.42, top - 0.29);
  ctx.quadraticCurveTo(cx + 0.2, top - 0.35, cx + 0.01, top - 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,245,200,0.5)';
  ctx.fillRect(cx + 0.01, top - 0.5, 0.04, 0.2);
  meta.top = Math.min(meta.top, top - 0.56);
  meta.lamps.push(0.86, 1.86, 1.14, 1.86, 0.5, 1.2, 1.5, 1.2);
}

function port(ctx: Ctx, L: Look, meta: SpriteMeta, px: number): void {
  const d = L.waterDir >= 0 ? L.waterDir : 2;
  if (L.onWater) {
    // a pier: wooden deck on posts
    ctx.fillStyle = 'rgba(10,30,40,0.4)';
    ctx.fillRect(0.12, 0.3, L.w - 0.14, 0.5);
    ctx.fillStyle = '#8b6a45';
    ctx.fillRect(0.06, 0.24, L.w - 0.12, 0.48);
    ctx.strokeStyle = 'rgba(60,40,24,0.55)';
    ctx.lineWidth = Math.max(px, 0.012);
    ctx.beginPath();
    for (let x = 0.14; x < L.w - 0.08; x += 0.1) {
      ctx.moveTo(x, 0.24);
      ctx.lineTo(x, 0.72);
    }
    ctx.stroke();
    ctx.fillStyle = '#4a3726';
    for (let x = 0.08; x < L.w - 0.05; x += 0.36) {
      ctx.fillRect(x, 0.7, 0.06, 0.08);
      ctx.fillRect(x, 0.2, 0.06, 0.06);
    }
    ellipse(ctx, 0.4, 0.34, 0.04, 0.03, '#2f2a26');
    ellipse(ctx, 1.6, 0.34, 0.04, 0.03, '#2f2a26');
    meta.lamps.push(0.1, 0.3, L.w - 0.1, 0.3);
    if (L.treasury) pennant(ctx, meta, px, L.w - 0.2, 0.3);
    meta.top = Math.min(meta.top, 0);
    return;
  }
  // wharf toward the water
  const dx = WDX[d];
  const dy = WDY[d];
  const cx = L.w / 2 + dx * 0.9;
  const cy = 0.55 + dy * 0.7;
  ctx.lineCap = 'butt';
  line(ctx, L.w / 2 + 0.04, 0.6, cx + dx * 0.5 + 0.04, cy + dy * 0.5 + 0.05, 'rgba(10,30,40,0.35)', 0.34);
  line(ctx, L.w / 2, 0.55, cx + dx * 0.5, cy + dy * 0.5, '#8b6a45', 0.32);
  // warehouse
  block(ctx, meta, px, 0.1, 0.12, 1.12, 0.38, 0.3, { roof: '#3f6478', wall: '#d9cfbb', ridge: 'x', windows: 3, door: 'wide', chimney: 'none' });
  // barrels and crates on the quay
  barrel(ctx, px, 1.36, 0.8);
  barrel(ctx, px, 1.48, 0.86);
  ctx.fillStyle = '#9a7650';
  ctx.fillRect(1.56, 0.66, 0.14, 0.14);
  crane(ctx, meta, px, 1.74, 0.88, -0.5, 0.36);
  flag(ctx, meta, px, 0.18, 0.2, 0.42, TOWN_FLAGS[L.town % TOWN_FLAGS.length]);
  meta.lamps.push(cx, cy, 1.3, 0.95);
}

/** Paint a building in its active state. ctx is in tile units, origin at the footprint's top-left. */
export function paintBuilding(ctx: Ctx, look: Look, pxPerTile: number): SpriteMeta {
  const meta = newMeta();
  const px = 1 / Math.max(1, pxPerTile);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (look.kind) {
    case 'house':
      house(ctx, look, meta, px);
      break;
    case 'market':
      market(ctx, look, meta, px);
      break;
    case 'bank':
      bank(ctx, look, meta, px);
      break;
    case 'palace':
      palace(ctx, look, meta, px);
      break;
    case 'port':
      port(ctx, look, meta, px);
      break;
    case 'firm':
      switch (look.sector) {
        case 'farm':
          farm(ctx, look, meta, px);
          break;
        case 'fishery':
          fishery(ctx, look, meta, px);
          break;
        case 'lumber':
          lumber(ctx, look, meta, px);
          break;
        case 'coalmine':
          coalmine(ctx, look, meta, px);
          break;
        case 'oilwell':
          oilwell(ctx, look, meta, px);
          break;
        case 'oremine':
          oremine(ctx, look, meta, px);
          break;
        case 'smelter':
          smelter(ctx, look, meta, px);
          break;
        case 'toolworks':
          toolworks(ctx, look, meta, px);
          break;
        case 'bakery':
          bakery(ctx, look, meta, px);
          break;
        case 'brewery':
          brewery(ctx, look, meta, px);
          break;
        case 'furniture':
          furniture(ctx, look, meta, px);
          break;
        case 'builder':
          builder(ctx, look, meta, px);
          break;
        case 'trader':
          trader(ctx, look, meta, px);
          break;
        default:
          townWorkshop(ctx, look, meta, px, { roof: '#6d6a60', wall: '#c9bda4', smoke: -1 });
      }
      break;
    default:
      townWorkshop(ctx, look, meta, px, { roof: '#6d6a60', wall: '#c9bda4', smoke: -1 });
  }
  return meta;
}

/** Boards across the windows and door of a vacant building (drawn after desaturation). */
export function paintBoards(ctx: Ctx, look: Look, meta: SpriteMeta, pxPerTile: number): void {
  const px = 1 / Math.max(1, pxPerTile);
  ctx.lineCap = 'butt';
  const board = (x0: number, y0: number, x1: number, y1: number) => line(ctx, x0, y0, x1, y1, '#7a6246', Math.max(px * 1.5, 0.028));
  const w = meta.windows;
  for (let k = 0; k + 3 < w.length; k += 4) {
    board(w[k] - 0.01, w[k + 1], w[k] + w[k + 2] + 0.01, w[k + 1] + w[k + 3]);
    board(w[k] - 0.01, w[k + 1] + w[k + 3], w[k] + w[k + 2] + 0.01, w[k + 1]);
  }
  // a "closed" plank across the middle of the footprint
  const cx = look.w / 2;
  const cy = look.h * 0.78;
  board(cx - 0.22, cy - 0.04, cx + 0.22, cy + 0.04);
}

/** Foundations and scaffolding over a footprint under construction. */
export function paintScaffold(ctx: Ctx, look: Look, pxPerTile: number): SpriteMeta {
  const meta = newMeta();
  const px = 1 / Math.max(1, pxPerTile);
  const W = look.w;
  const H = look.h;
  if (look.onWater) {
    // piles driven into the water
    ctx.fillStyle = '#4a3726';
    for (let x = 0.1; x < W - 0.05; x += 0.3) for (let y = 0.25; y < H - 0.2; y += 0.4) ctx.fillRect(x, y, 0.06, 0.06);
    ctx.fillStyle = 'rgba(139,106,69,0.7)';
    ctx.fillRect(0.06, 0.26, W * 0.5, 0.2);
    return meta;
  }
  ctx.fillStyle = 'rgba(120,104,80,0.55)';
  ctx.fillRect(0.08, 0.14, W - 0.16, H - 0.22);
  ctx.strokeStyle = STONE_DARK;
  ctx.lineWidth = Math.max(px, 0.04);
  ctx.strokeRect(0.14, 0.2, W - 0.28, H - 0.34);
  ctx.fillStyle = STONE;
  ctx.fillRect(0.14, H - 0.2, W - 0.28, 0.06);
  // poles and planks
  const poleC = '#c9a878';
  const lw = Math.max(px, 0.028);
  const top = -0.2;
  const xs: number[] = [];
  for (let x = 0.16; x <= W - 0.14; x += Math.max(0.3, (W - 0.3) / Math.max(1, Math.round((W - 0.3) / 0.36)))) xs.push(x);
  for (const x of xs) line(ctx, x, H - 0.16, x, top, poleC, lw);
  for (let y = H - 0.36; y > top + 0.02; y -= 0.28) {
    line(ctx, xs[0] - 0.04, y, xs[xs.length - 1] + 0.04, y, '#a88458', Math.max(px, 0.045));
  }
  // diagonal braces
  line(ctx, xs[0], H - 0.2, xs[xs.length - 1], top + 0.1, 'rgba(160,126,84,0.8)', Math.max(px, 0.015));
  // a ladder and a pile of materials
  line(ctx, W - 0.2, H - 0.12, W - 0.24, top + 0.2, '#8a6a45', Math.max(px, 0.018));
  line(ctx, W - 0.12, H - 0.12, W - 0.16, top + 0.2, '#8a6a45', Math.max(px, 0.018));
  logPile(ctx, px, 0.12, H - 0.04, 3);
  meta.top = top;
  return meta;
}
