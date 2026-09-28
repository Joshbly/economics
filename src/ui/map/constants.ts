// ============================================================================
// Map renderer constants (UI-only tunables; the simulation's live in
// src/sim/config.ts). Everything visual that a designer might want to tweak
// without reading the drawing code sits here.
// ============================================================================

/** CSS pixels per tile at zoom 1. */
export const TILE_PX = 16;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
/** Zoom step for +/− keys, buttons and double-click. */
export const ZOOM_STEP = 1.6;

/**
 * Terrain levels of detail: device pixels per tile of a pre-rendered chunk.
 * The renderer picks the smallest level that is at least the on-screen scale
 * (allowing a little upscaling, see LOD_SLACK), so zooming stays crisp.
 */
export const LODS = [8, 16, 32, 64, 128] as const;
/** A level may be magnified by up to this factor before the next one is used. */
export const LOD_SLACK = 1.15;
/** Every chunk canvas is at most this many device pixels on a side. */
export const CHUNK_PX = 512;
/** Per-pixel ground colour is computed at most at this many px per tile (then upscaled; vector detail stays crisp). */
export const GROUND_MAX_PX = 32;
/** Terrain chunks kept in memory (≈ 1 MB each at 512²). */
export const CHUNK_CACHE_MAX = 64;
/** Wall-clock budget per frame for rendering missing terrain chunks (ms); at least one chunk is always rendered. */
export const CHUNK_BUDGET_MS = 7;
/** Tiles of neighbouring terrain drawn into a chunk so overhanging trees/peaks join seamlessly. */
export const CHUNK_MARGIN = 2;

/** Building sprite margins (tiles) around the footprint: sides, above (chimneys, cranes, derricks), below. */
export const SPRITE_MX = 0.6;
export const SPRITE_MTOP = 1.5;
export const SPRITE_MBOT = 0.45;
/** Sprites kept in memory. */
export const SPRITE_CACHE_MAX = 900;
/** Wall-clock budget per frame for (re)building sprites (ms). */
export const SPRITE_BUDGET_MS = 6;

// ---- people & wagons -------------------------------------------------------
/** Hide walkers at or above this speed level (commutes flash by too fast to read). */
export const PEOPLE_HIDE_SPEED = 4;
/** Hide walkers below this zoom. */
export const PEOPLE_MIN_ZOOM = 0.55;
/** New commute paths computed per frame at most (ms of A*). */
export const PATH_BUDGET_MS = 2.5;
/** Leave home between these fractions of the day (per-person jitter). */
export const COMMUTE_LEAVE: [number, number] = [0.24, 0.3];
/** Arrive at work between these fractions of the day. */
export const COMMUTE_ARRIVE: [number, number] = [0.33, 0.38];
/** Leave work between these fractions. */
export const COMMUTE_BACK: [number, number] = [0.7, 0.75];
/** Latest arrival home. */
export const COMMUTE_HOME_BY = 0.82;
/** Shortest walk (fraction of a day) so short commutes still show. */
export const COMMUTE_MIN_WALK = 0.035;
/** Share of the unemployed who stroll to the market square at midday. */
export const STROLL_SHARE = 0.65;
/** Strollers leave home / leave the square between these fractions. */
export const STROLL_OUT: [number, number] = [0.4, 0.47];
export const STROLL_BACK: [number, number] = [0.56, 0.64];
/** Walker dot radius (tiles) and screen clamp (CSS px). */
export const DOT_R = 0.13;
export const DOT_MIN_PX = 1.3;
export const DOT_MAX_PX = 3.4;
/** Carts in a convoy drawn at most (one shipment may use many wagons). */
export const CONVOY_MAX = 3;
/** Visual delivery trips per producer per day (small handcarts to the market hall). */
export const DELIVERY_MIN_PATH = 3;

// ---- smoke ------------------------------------------------------------------
export const SMOKE_MAX = 1400;
/** Puffs per real second from a building producing at its usual rate. */
export const SMOKE_RATE = 3;

// ---- day & night ------------------------------------------------------------
/** Night tint (multiplied) and dusk/dawn warm tint. */
export const NIGHT_TINT: [number, number, number] = [118, 132, 188];
export const DUSK_TINT: [number, number, number] = [255, 196, 150];
/** Tint strength by speed level (fast clocks must not strobe). */
export const TINT_BY_SPEED = [1, 1, 0.75, 0.3, 0, 0];

// ---- colours shared by several layers ----------------------------------------
export const GOLD = '#d8ab4e';
export const GOLD_HI = '#f2cd72';
export const INK = '#f1e9d8';
export const HALO = 'rgba(9,11,15,0.78)';
export const UNEMPLOYED_COLOR = '#9a978f';
export const HOMELESS_COLOR = '#6f6b64';
export const TREASURY_COLOR = '#f0c75a';
/**
 * Walker dot colour by workplace sector. Distinct hues on the map's greens and
 * browns; grey is reserved for the jobless and gold for Treasury workers, so no
 * private trade uses either (coal and iron's own colours are grey, tools' gold).
 */
export const SECTOR_DOT: Record<string, string> = {
  farm: '#ead06a',
  fishery: '#62bde6',
  lumber: '#86c45a',
  coalmine: '#e3866a',
  oilwell: '#b394f0',
  oremine: '#e06d8c',
  smelter: '#f09a3e',
  toolworks: '#52c7b4',
  bakery: '#f5b98f',
  brewery: '#c98d4e',
  furniture: '#c77dd6',
  builder: '#e3d2a8',
  trader: '#9cc3dc',
  stateworks: TREASURY_COLOR,
};
export const GOOD_TONE = '#57b8a5';
export const BAD_TONE = '#e8845a';
export const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
export const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif';
