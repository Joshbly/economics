// ============================================================================
// Name generation (people, firms, towns, the realm). OWNER: world agent.
// Pure functions of an RNG holder: deterministic for a given RNG state.
// The flavour is a loose late-medieval English/Norse mix: short given names,
// occupational and topographic family names, compound place names.
// ============================================================================
import type { RngHolder } from '../rng';
import { pick, rand } from '../rng';

const GIVEN: readonly string[] = [
  'Ada', 'Agnes', 'Alaric', 'Aldous', 'Alys', 'Amice', 'Anselm', 'Arden', 'Avice', 'Beatrix',
  'Bennet', 'Bertram', 'Blanche', 'Bran', 'Brice', 'Cecily', 'Colin', 'Constance', 'Cuthbert', 'Dunstan',
  'Edith', 'Edmund', 'Edric', 'Elinor', 'Elspeth', 'Emmet', 'Esme', 'Ewan', 'Fenna', 'Florian',
  'Gareth', 'Gilbert', 'Godric', 'Greta', 'Gwen', 'Hamlin', 'Hawise', 'Hester', 'Hilda', 'Hugh',
  'Idony', 'Isolde', 'Ivo', 'Jasper', 'Joan', 'Jocelyn', 'Kit', 'Lambert', 'Leofric', 'Lettice',
  'Linnet', 'Lorne', 'Mabel', 'Magnus', 'Margery', 'Maud', 'Merrick', 'Milo', 'Muriel', 'Nell',
  'Nicolas', 'Odo', 'Orrin', 'Osric', 'Oswin', 'Petra', 'Piers', 'Quenby', 'Ralf', 'Reyna',
  'Rohesia', 'Rowan', 'Rufus', 'Sabine', 'Sibyl', 'Silas', 'Tamsin', 'Tancred', 'Thora', 'Tobias',
  'Ulric', 'Ursula', 'Wade', 'Walter', 'Wilmot', 'Winifred', 'Wren', 'Wystan', 'Yvain', 'Ysolde',
];

const FAMILY: readonly string[] = [
  'Ashdown', 'Baker', 'Barrow', 'Bell', 'Blackwood', 'Bramble', 'Brewer', 'Carter', 'Carver', 'Chandler',
  'Cooper', 'Crane', 'Dyer', 'Fairweather', 'Fisher', 'Fletcher', 'Forester', 'Fuller', 'Gorse', 'Hale',
  'Harrow', 'Hayward', 'Hollis', 'Kettle', 'Larkin', 'Marlow', 'Mason', 'Mercer', 'Miller', 'Nettle',
  'Oakes', 'Pike', 'Potter', 'Quill', 'Radley', 'Reeve', 'Rook', 'Sallow', 'Sawyer', 'Shepherd',
  'Smith', 'Tanner', 'Thatcher', 'Thorne', 'Turner', 'Underhill', 'Vane', 'Warrick', 'Weaver', 'Whitlock',
  'Wright', 'Yarrow', 'Tillman', 'Coombe', 'Penrose', 'Hartley', 'Ingram', 'Lowther', 'Moberly', 'Pellow',
];

const FAMILY_A: readonly string[] = [
  'Ash', 'Black', 'Bram', 'Brook', 'Cold', 'Crow', 'Elm', 'Fern', 'Gold', 'Grey',
  'Hawk', 'High', 'Iron', 'Mill', 'Moss', 'Oak', 'Red', 'Stone', 'Thorn', 'West',
  'White', 'Wild', 'Wolf', 'Birch', 'Hazel', 'Rush', 'Bright', 'Hol', 'Wick', 'Marsh',
];
const FAMILY_B: readonly string[] = [
  'wood', 'field', 'ley', 'ford', 'well', 'mere', 'stone', 'wick', 'by', 'ham',
  'ridge', 'brook', 'more', 'worth', 'combe', 'dale', 'hurst', 'shaw', 'ton', 'thwaite',
];

/** A family name: half from a list of occupational names, half compound topographic. */
export function familyName(h: RngHolder): string {
  if (rand(h) < 0.55) return pick(h, FAMILY);
  const a = pick(h, FAMILY_A);
  let b = pick(h, FAMILY_B);
  // Avoid awkward doubled letters at the seam ("Hollley").
  if (a[a.length - 1] === b[0]) b = b.slice(1);
  return a + b;
}

/** A person's full name ("Maud Blackwood"). */
export function personName(h: RngHolder): string {
  return pick(h, GIVEN) + ' ' + familyName(h);
}

// ---- towns ------------------------------------------------------------------
// Each kind has a classic default name (DESIGN §1.2) and compound variations.
const TOWN_PARTS: Record<string, { classic: string; a: readonly string[]; b: readonly string[] }> = {
  capital: {
    classic: 'Kingsbridge',
    a: ['Kings', 'Queens', 'Crown', 'Eld', 'High', 'Ald', 'Regis', 'Castle'],
    b: ['bridge', 'ford', 'gate', 'stow', 'minster', 'bury', 'wark'],
  },
  farm: {
    classic: 'Millbrook',
    a: ['Mill', 'Barley', 'Wheat', 'Hay', 'Oat', 'Green', 'Meadow', 'Corn', 'Rye', 'Sheaf'],
    b: ['brook', 'field', 'ham', 'stead', 'dale', 'ley', 'worth', 'acre'],
  },
  mining: {
    classic: 'Coalridge',
    a: ['Coal', 'Iron', 'Black', 'Slate', 'Cinder', 'Stone', 'Flint', 'Copper', 'Soot', 'Anvil'],
    b: ['ridge', 'moor', 'fell', 'crag', 'hollow', 'pike', 'scar', 'tor'],
  },
  harbor: {
    classic: 'Saltmere',
    a: ['Salt', 'Gull', 'Sea', 'Brine', 'Tide', 'Shell', 'Herring', 'Kelp', 'Wave', 'Anchor'],
    b: ['mere', 'haven', 'port', 'mouth', 'strand', 'wick', 'sands', 'quay'],
  },
};

/**
 * A town name for its kind: the classic name (Kingsbridge, Millbrook, Coalridge,
 * Saltmere) about a third of the time, otherwise a compound in the same style.
 */
export function townName(h: RngHolder, kind: string): string {
  const parts = TOWN_PARTS[kind] ?? TOWN_PARTS.farm;
  if (rand(h) < 0.34) return parts.classic;
  for (let tries = 0; tries < 6; tries++) {
    const a = pick(h, parts.a);
    const b = pick(h, parts.b);
    const name = a + b;
    if (name !== parts.classic && a[a.length - 1] !== b[0]) return name;
  }
  return parts.classic;
}

const REALM_PRE: readonly string[] = ['The Vale of', 'The March of', 'The Crown of', 'The Dales of', 'The Kingdom of', 'The Reach of', 'The Shire of'];
const REALM_A: readonly string[] = ['Aster', 'Bel', 'Cal', 'Dun', 'El', 'Fal', 'Gal', 'Hal', 'Lor', 'Mar', 'Or', 'Tam', 'Val', 'Wen'];
const REALM_B: readonly string[] = ['dor', 'mere', 'wyn', 'holm', 'mark', 'garth', 'wick', 'wold', 'land', 'ness'];

/** A name for the realm ("The Vale of Calmere"). */
export function realmName(h: RngHolder): string {
  return `${pick(h, REALM_PRE)} ${pick(h, REALM_A)}${pick(h, REALM_B)}`;
}

// ---- firms --------------------------------------------------------------------
const PLACE_PRE: readonly string[] = ['Old', 'North', 'South', 'East', 'West', 'High', 'Low', 'Upper', 'Nether', 'River', 'Hill', 'Green', 'Bridge', 'Market'];
const PLACE_SUF: readonly string[] = ['side', 'gate', 'field', 'end', 'croft', 'yard', 'row', 'lane'];

/**
 * A firm name: "<Family> <Sector>", "<Family> & Sons <Sector>", "<Family> Brothers
 * <Sector>", "<Town> <Sector>", or a place-style "Northgate <Sector>".
 * `sectorName` is the building name (e.g. "Bakery", "Coal Mine").
 */
export function firmName(h: RngHolder, sectorName: string, townName: string): string {
  const r = rand(h);
  if (r < 0.34) return `${familyName(h)} ${sectorName}`;
  if (r < 0.5) return `${familyName(h)} & ${rand(h) < 0.7 ? 'Sons' : 'Daughters'} ${sectorName}`;
  if (r < 0.58) return `${familyName(h)} Brothers ${sectorName}`;
  if (r < 0.72 && townName) return `${townName} ${sectorName}`;
  const pre = pick(h, PLACE_PRE);
  const suf = rand(h) < 0.6 ? pick(h, PLACE_SUF) : '';
  return `${pre}${suf} ${sectorName}`;
}
