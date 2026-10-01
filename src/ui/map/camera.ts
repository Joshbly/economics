// ============================================================================
// Camera maths for the map (pure, DOM-free, unit-tested).
//
// World coordinates are in tiles (tile (x, y) covers [x, x+1) × [y, y+1)).
// The camera stores the world point at the centre of the view and the zoom;
// one tile is TILE_PX × zoom CSS pixels on screen.
// ============================================================================
import { LOD_SLACK, LODS, TILE_PX, ZOOM_MAX, ZOOM_MIN } from './constants';

export interface Camera {
  /** World point (tiles) at the centre of the view. */
  x: number;
  y: number;
  /** Zoom factor (ZOOM_MIN..ZOOM_MAX). */
  z: number;
  /** View size in CSS pixels. */
  vw: number;
  vh: number;
  /** Device pixel ratio. */
  dpr: number;
}

export function newCamera(): Camera {
  return { x: 56, y: 38, z: 1, vw: 800, vh: 600, dpr: 1 };
}

/** CSS pixels per tile. */
export function scaleOf(c: Camera): number {
  return TILE_PX * c.z;
}

/** World x → screen x (CSS px). */
export function sx(c: Camera, wx: number): number {
  return (wx - c.x) * TILE_PX * c.z + c.vw / 2;
}

/** World y → screen y (CSS px). */
export function sy(c: Camera, wy: number): number {
  return (wy - c.y) * TILE_PX * c.z + c.vh / 2;
}

/** Screen x (CSS px) → world x (tiles). */
export function wx(c: Camera, px: number): number {
  return (px - c.vw / 2) / (TILE_PX * c.z) + c.x;
}

/** Screen y (CSS px) → world y (tiles). */
export function wy(c: Camera, py: number): number {
  return (py - c.vh / 2) / (TILE_PX * c.z) + c.y;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return z < ZOOM_MIN ? ZOOM_MIN : z > ZOOM_MAX ? ZOOM_MAX : z;
}

/**
 * Zoom to `z` keeping the world point under screen point (px, py) fixed —
 * the behaviour users expect from pinch and wheel zoom.
 */
export function zoomAround(c: Camera, px: number, py: number, z: number): void {
  const nz = clampZoom(z);
  const ax = wx(c, px);
  const ay = wy(c, py);
  c.z = nz;
  // After the change, (ax, ay) must map back to (px, py).
  c.x = ax - (px - c.vw / 2) / (TILE_PX * nz);
  c.y = ay - (py - c.vh / 2) / (TILE_PX * nz);
}

/** Pan by a screen-space delta (CSS px): content follows the pointer. */
export function panBy(c: Camera, dx: number, dy: number): void {
  const k = TILE_PX * c.z;
  if (!(k > 0)) return;
  c.x -= dx / k;
  c.y -= dy / k;
}

/**
 * Keep the map in view: the view centre may not leave the map (plus a small
 * margin); when the whole map fits on screen along an axis it is centred.
 */
export function clampCamera(c: Camera, mapW: number, mapH: number, marginTiles = 4): void {
  const k = TILE_PX * c.z;
  const halfW = c.vw / 2 / k;
  const halfH = c.vh / 2 / k;
  if (!Number.isFinite(c.x)) c.x = mapW / 2;
  if (!Number.isFinite(c.y)) c.y = mapH / 2;
  if (halfW * 2 >= mapW + marginTiles * 2) c.x = mapW / 2;
  else c.x = Math.min(mapW + marginTiles - halfW, Math.max(halfW - marginTiles, c.x));
  if (halfH * 2 >= mapH + marginTiles * 2) c.y = mapH / 2;
  else c.y = Math.min(mapH + marginTiles - halfH, Math.max(halfH - marginTiles, c.y));
}

/** Zoom at which a w×h tile box fills the view (with `pad` CSS px on each side). */
export function fitZoom(vw: number, vh: number, wTiles: number, hTiles: number, pad = 24): number {
  const zx = (vw - 2 * pad) / (Math.max(1, wTiles) * TILE_PX);
  const zy = (vh - 2 * pad) / (Math.max(1, hTiles) * TILE_PX);
  return clampZoom(Math.min(zx, zy));
}

/** Visible world rectangle [x0, y0, x1, y1] (tiles), optionally padded by `pad` tiles. */
export function viewRect(c: Camera, pad = 0): [number, number, number, number] {
  return [wx(c, 0) - pad, wy(c, 0) - pad, wx(c, c.vw) + pad, wy(c, c.vh) + pad];
}

/**
 * Terrain level of detail for an on-screen scale of `devicePxPerTile`: the
 * smallest level that, magnified by at most LOD_SLACK, covers it; the
 * largest level otherwise.
 */
export function pickLod(devicePxPerTile: number): number {
  for (const L of LODS) if (L * LOD_SLACK >= devicePxPerTile) return L;
  return LODS[LODS.length - 1];
}

/** Exponential smoothing factor for a time step (frame-rate independent). */
export function smoothK(dt: number, rate: number): number {
  if (!(dt > 0)) return 0;
  return 1 - Math.exp(-dt * rate);
}
