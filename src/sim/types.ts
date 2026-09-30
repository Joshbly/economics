// ============================================================================
// Realm Ledger — core state types. THIS FILE IS THE CONTRACT between modules.
// All state is plain JSON data (no classes, Maps, Sets, typed arrays, NaN or
// Infinity). Use -1 as the "none" sentinel for ids and optional numbers.
// See DESIGN.md for semantics.
// ============================================================================

/** Index of a good, 0..N_GOODS-1. See `G` in goods.ts. */
export type GoodId = number;
/** Index of a town, 0..towns.length-1. */
export type TownId = number;

/**
 * Compact numeric agent reference (used in orders, ownership, loans...).
 *   person  : id               (0 .. 999_999)
 *   firm    : FIRM_BASE + id   (1_000_000 ..)
 *   STATE   : -1  the Treasury (the player)
 *   BANK    : -2  the commercial bank
 *   FOREIGN : -3  the outside world's desk at the port
 * Helpers live in ledger.ts (personRef, firmRef, isPerson, isFirm, refId).
 */
export type Ref = number;
export const FIRM_BASE = 1_000_000;
export const STATE: Ref = -1;
export const BANK: Ref = -2;
export const FOREIGN: Ref = -3;

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
export const Terrain = {
  DeepWater: 0,
  Water: 1, // shallow / coastal water (fishing)
  Sand: 2,
  Grass: 3,
  Forest: 4,
  Hills: 5,
  Mountain: 6,
  Marsh: 7,
} as const;
export type TerrainId = (typeof Terrain)[keyof typeof Terrain];

export interface MapData {
  w: number;
  h: number;
  /** Terrain per tile, index = y * w + x. */
  terrain: number[];
  /** Elevation 0..1 (visual shading). */
  elev: number[];
  /** Farm fertility 0..1. */
  fert: number[];
  /** Richness 0..1 of the tile's natural resource (timber/coal/ore/oil/fish). 0 = none. */
  deposit: number[];
  /** 1 if this tile holds a river (impassable unless road >= 1 = bridge). */
  river: number[];
  /** 0 none, 1 dirt track, 2 paved road. */
  road: number[];
  /** Building id occupying the tile, or -1. */
  occ: number[];
  /** Town whose market this tile belongs to, or -1. */
  district: number[];
}

// ---------------------------------------------------------------------------
// Towns
// ---------------------------------------------------------------------------
export type TownKind = 'capital' | 'farm' | 'mining' | 'harbor';

export interface Town {
  id: TownId;
  name: string;
  kind: TownKind;
  x: number; // centre tile
  y: number;
  radius: number; // settlement radius in tiles
  market: number; // building id of the market hall
  hasPort: boolean;
  // ---- derived each day by stats (read by agents & UI) ----
  pop: number;
  employed: number;
  unemployed: number;
  vacancies: number;
  homeless: number;
  vacantSlots: number;
  avgWage: number; // employment-weighted posted wage
  avgRent: number; // average rent per occupied slot per day
  cpi: number; // town consumer price index (base 100)
  contentment: number; // mean 0..1
  health: number; // mean 0..1
  // ---- state ----
  strikeDays: number; // > 0 while a strike is on (production reduced)
  unrestDays: number; // consecutive days contentment < threshold
  droughtDays: number; // > 0 while a drought hits farms here
  evictions?: number; // households turned out for unpaid rent so far this month (for the month's news)
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------
export type BuildingKind = 'house' | 'firm' | 'market' | 'bank' | 'palace' | 'port';
export type BuildingStatus = 'active' | 'construction' | 'vacant' | 'ruin';

export interface Building {
  id: number;
  kind: BuildingKind;
  town: TownId;
  x: number; // top-left tile
  y: number;
  w: number; // footprint in tiles
  h: number;
  status: BuildingStatus;
  level: number; // 1.. ; firms: capacity = sector.capacityPerLevel * level
  sector: Sector | ''; // for kind 'firm'
  firm: number; // firm id or -1
  // houses
  slots: number; // households it can hold (0 for non-houses)
  residents: number[]; // person ids
  rent: number; // ¤ per slot per day asked by the landlord
  owner: Ref; // landlord / owner (-1 STATE allowed)
  vacantDays: number; // consecutive days with at least one empty slot
  cost: number; // book value ¤ (construction cost) — collateral & yields
  built: number; // day completed (-1 if not yet)
  project: number; // active project id or -1
}

// ---------------------------------------------------------------------------
// People (households)
// ---------------------------------------------------------------------------
export interface Person {
  id: number;
  alive: boolean;
  name: string;
  town: TownId; // residence town (shops here)
  home: number; // house building id or -1 (homeless)
  job: number; // firm id or -1
  wage: number; // current posted wage of their job (gross), 0 if unemployed
  cash: number; // bank deposit ¤ (never negative)
  iou: number; // IOUs held (units)
  gold: number; // gold held (oz)
  /** Goods at home, length N_GOODS. furniture = durable comfort stock. */
  pantry: number[];
  health: number; // 0..1
  contentment: number; // 0..1
  joy: number; // EMA of ale enjoyment 0..1
  income: number; // EMA of disposable income ¤/day
  lastWage: number; // last net wage earned (reservation wage anchor)
  expInfl: number; // expected annual inflation (fraction)
  unempDays: number;
  tenure: number; // days in current job
  arrears: number; // days of unpaid rent
  age: number; // years
  skill: number; // productivity multiplier (~1)
  owns: number[]; // firm ids owned
  houses: number[]; // house building ids owned
  foodSat: number; // yesterday's food satisfaction 0..1.3
  heatSat: number; // yesterday's heat satisfaction 0..1
  commute: number; // tiles between home and job (0 if none)
  born: number; // day of birth/arrival
  // ---- daily scratch (reset each day, still serialised) ----
  budget: number; // today's spending budget
  spent: number; // ¤ spent in markets today
  earned: number; // ¤ received today (wages net, transfers, dividends, rent, interest)
}

// ---------------------------------------------------------------------------
// Firms
// ---------------------------------------------------------------------------
export type Sector =
  | 'farm'
  | 'fishery'
  | 'lumber'
  | 'coalmine'
  | 'oilwell'
  | 'oremine'
  | 'smelter'
  | 'toolworks'
  | 'bakery'
  | 'brewery'
  | 'furniture'
  | 'builder'
  | 'trader'
  | 'stateworks';

export type FirmStatus = 'active' | 'liquidating' | 'closed';

export interface Firm {
  id: number;
  alive: boolean; // false once closed and fully wound down
  status: FirmStatus;
  name: string;
  sector: Sector;
  town: TownId; // trades in this town's market
  building: number; // building id (-1 for stateworks)
  owner: Ref; // person ref, or STATE — the controlling owner (largest share), who runs it
  /** Other part-owners (people or firms) and their shares of the firm; the owner holds the rest (agents/ownership.ts). Absent = the owner holds it all. */
  partners?: { ref: Ref; share: number }[];
  workers: number[]; // person ids
  capacity: number; // max workers
  target: number; // desired workforce
  wage: number; // posted gross wage ¤/day
  vacancyDays: number; // consecutive days with unfilled vacancies
  applicants: number; // applicants seen today
  hired: number; // today
  fired: number; // today
  tools: number; // capital stock (tools units)
  inv: number[]; // inventory at the firm, length N_GOODS
  cash: number; // bank deposit ¤
  // expectations & accounting
  pExp: number; // expected NET output price per unit
  sales: number; // EMA units sold/day
  output: number; // EMA units produced/day
  producedToday: number;
  soldToday: number;
  unitCost: number; // EMA unit cost ¤
  profit: number; // EMA daily profit ¤
  monthProfit: number; // accumulated profit this month (for profit levies, dividends)
  revenue: number; // today ¤ received from sales (net of seller levies)
  spent: number; // today ¤ spent in markets (gross incl. buyer levies)
  wageBill: number; // today ¤ paid in wages (incl. employer levies)
  otherCosts: number; // today ¤ interest, levies, rent...
  distress: number; // consecutive distress days
  founded: number; // day
  liquidationDays: number;
  lossDays: number; // consecutive days the profit EMA has been negative (voluntary exit) // added by firms engineer
  salesLong: number; // slow EMA (SALES_LONG_EMA) of de-seasonalised daily sales: the normal rate of sales output is planned on (0 = none yet)
  salesMonths: number[]; // mean units sold a day in each calendar month over the last year, length 12 (-1 = no record): the learnt season
  monthSold: number; // units sold so far this month
  profitLong: number; // slow EMA (PROFIT_LONG_EMA) of daily profit: a seasonal trade judges losses over the year
  /** Profit summed over its life (¤): what the investors learn from (agents/experience.ts). Absent in old saves. */
  profitLife?: number;
  // specialisations
  trade: TraderState | null;
  build: BuilderState | null;
}

export interface TraderState {
  wagons: number; // wagons owned
  busy: number[]; // for each busy wagon: day it returns home
  /** Stock held at each town for sale there: [town][good]. */
  stock: number[][];
  /** Average landed cost per unit: [town][good]. */
  basis: number[][];
  /** Days the current stock has been waiting: [town][good]. */
  age: number[][];
  freightEma: number; // ¤ per unit per tile (EMA), for the shipping index
  shippedToday: number; // units
  wantEma: number; // EMA of wagons the trader wanted on the road (busy + wanted today) — drives drivers & wagon investment // added by finance-trade
  /** Units a day it ships to each town (EMA, LANE_EMA; length = towns): what a road on that lane would save it. Absent in old saves. */
  lane?: number[];
}

export interface BuilderState {
  queue: number[]; // project ids in priority order
}

// ---------------------------------------------------------------------------
// Construction projects
// ---------------------------------------------------------------------------
export type ProjectKind = 'house' | 'firm' | 'expand' | 'reopen' | 'road' | 'pier';
export type ProjectStatus = 'queued' | 'active' | 'stalled' | 'done' | 'cancelled';

export interface Materials {
  labor: number; // worker-days
  wood: number;
  iron: number;
  tools: number;
}

export interface Project {
  id: number;
  kind: ProjectKind;
  town: TownId;
  owner: Ref; // who pays (person, firm, STATE)
  builder: number; // builder firm id
  sector: Sector | ''; // for firm / reopen
  building: number; // target building id (created in 'construction' status for new builds), or -1 for roads
  tiles: number[]; // road: tile indices to build, in order along the way
  /** Road: 1 = a dirt track (map.road 1); absent = paving (map.road 2). */
  grade?: 1;
  need: Materials;
  done: Materials;
  billed: number; // ¤ billed so far
  status: ProjectStatus;
  created: number;
  loan: number; // financing loan id or -1
  stalledDays: number;
  label: string;
  prepaid: number; // ¤ the owner has advanced to the builder and not yet been billed (a liability of the builder) // added by firms engineer
  loanWanted: number; // ¤ of financing requested from the bank and not yet granted; > 0 = waiting, no work starts // added by firms engineer
  /** Co-investors of a new venture and the shares of the firm they will hold (the owner holds the rest); what each advanced. */
  partners?: { ref: Ref; share: number; paid: number }[];
  /** Treasury projects: labour-days its Treasury workers put in today, and about how many of them that was. */
  crewToday?: number;
  crewHeads?: number;
}

// ---------------------------------------------------------------------------
// Shipments (goods on wagons)
// ---------------------------------------------------------------------------
export interface Shipment {
  id: number;
  owner: Ref; // trader firm ref, or STATE (moved Treasury goods)
  from: TownId;
  to: TownId;
  good: GoodId;
  qty: number;
  basis: number; // landed cost per unit (purchase + freight + levies)
  depart: number; // day (fractional allowed)
  arrive: number; // day (fractional allowed)
  wagons: number;
  order: number; // the Treasury carry rule (CarryRule.id) that loaded this cargo, or -1
  /** Treasury freight line (FreightLine.id) whose wagons carry this cargo, or -1 (the owner's own wagons / a trading house's). */
  line: number;
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------
export type LoanPurpose = 'working' | 'invest' | 'startup' | 'house' | 'project';

export interface Loan {
  id: number;
  borrower: Ref;
  principal: number; // outstanding ¤
  spread: number; // over the bank's base rate (annual), set when the loan is made
  rate: number; // current annual rate
  /**
   * true: the rate agreed when the loan was made holds for its life (term credit — invest,
   * startup, house, project); the borrower refinances at the day's terms if they fall at least
   * LOAN_REFI_GAP below it. false: it floats daily at base rate + spread (working credit).
   */
  fixed: boolean;
  term: number; // total days
  left: number; // days left
  purpose: LoanPurpose;
  overdue: number; // consecutive days a payment was missed
  start: number;
  active: boolean;
}

export interface LoanRequest {
  borrower: Ref;
  amount: number;
  term: number; // days
  purpose: LoanPurpose;
  project: number; // project id or -1
}

export interface Bank {
  owner: number; // person id
  reserves: number; // ¤ held at the Treasury (may go negative only transiently)
  windowDebt: number; // ¤ borrowed from the Treasury window
  iou: number; // IOUs held (units)
  iouBook: number; // book value ¤ of IOUs held
  equity: number; // explicit equity ¤ (reconciled)
  baseRate: number; // annual: funding cost + base spread
  depositRate: number; // annual rate paid on deposits
  requests: LoanRequest[]; // queued today
  approved: number; // today
  rejected: number; // today
  defaultEma: number; // EMA of default losses / loans (daily)
  writeoffs: number; // cumulative ¤ written off
  stance: number; // 0 (loose) .. 1 (tight) lending standards
  failed: boolean;
  failedDays: number;
  profitMonth: number; // ¤ earned this month (for dividends)
  interestIn: number; // today
  interestOut: number; // today
}

// ---------------------------------------------------------------------------
// Treasury (the player)
// ---------------------------------------------------------------------------
export interface Treasury {
  purse: number; // ¤ the Treasury holds
  minted: number; // cumulative ¤ created
  burned: number; // cumulative ¤ destroyed
  goods: number[][]; // [town][good] Treasury holdings
  gold: number; // oz
  iouOutstanding: number; // IOUs held by the public (bank + people)
  reserveRate: number; // annual rate paid on bank reserves
  lendRate: number; // annual rate charged at the window
  autoMint: boolean;
  givesSuspended: boolean; // true today if gives could not be paid
  /** Today's flows by category, ¤ (positive = into the Purse). Reset daily. */
  flows: Record<string, number>;
  /** Month-to-date flows by category. Reset at month start. */
  flowsMonth: Record<string, number>;
  /** Previous full month's flows. */
  flowsLastMonth: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Outside world
// ---------------------------------------------------------------------------
export interface Foreign {
  /** World price per unit in gold (0 = not tradable abroad), length N_GOODS. */
  world: number[];
  /** Baseline world prices at game start (for the world price index). */
  world0: number[];
  /** Ship capacity per good per day (units), length N_GOODS. */
  shipCap: number[];
  goldPrice: number; // last clearing ¤ per oz (the exchange rate)
  goldEma: number;
  dealerValue: number; // dealers' fair-value estimate ¤/oz
  ppp: number; // purchasing-power-parity gold price estimate
  coin: number; // desk's ¤ balance (a private deposit)
  importsQty: number[]; // today, per good
  exportsQty: number[]; // today, per good
  importValue: number; // today ¤
  exportValue: number; // today ¤
  shocks: WorldShock[];
  piers: number; // pier count (raises shipCap)
  tradeEma: number; // EMA of daily port trade (¤, (imports + exports) / 2) — sets the desk's working-coin target; 0 = not yet known // added by finance-trade
}

export interface WorldShock {
  good: GoodId;
  factor: number;
  until: number; // day
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------
/** Instruments beyond goods: national markets. */
export const IOU_GOOD = 100;
export const GOLD_GOOD = 101;

export interface Wedge {
  bPct: number; // buyer pays base*(1+bPct)+bUnit
  bUnit: number;
  sPct: number; // seller receives base*(1-sPct)-sUnit
  sUnit: number;
}

export interface CurveSnapshot {
  /** Aggregated demand: flattened [basePrice, cumulativeQty, ...] descending by price. */
  bids: number[];
  /** Aggregated supply: flattened [basePrice, cumulativeQty, ...] ascending by price. */
  asks: number[];
  /** Treasury orders on this market: flattened [side(0 buy/1 sell), basePrice, qty, ...]. */
  state: number[];
  price: number;
  volume: number;
  wedge: Wedge;
  ceiling: number; // -1 none
  floor: number; // -1 none
}

export interface MarketState {
  town: TownId; // -1 for national markets
  good: number; // GoodId, IOU_GOOD or GOLD_GOOD
  price: number; // last clearing (or indicative) base price
  gross: number; // last price paid by buyers incl. buyer levies
  net: number; // last price received by sellers net of seller levies
  ema: number; // smoothed base price (reference for bidders)
  volume: number; // today
  volEma: number;
  shortage: number; // today: demand rationed away at the clearing price (units)
  surplus: number; // today: supply left unsold at the clearing price
  /** The last MARKET_BALANCE_DAYS days' shortage and surplus (markets.recentBalance averages them). */
  shortHist?: number[];
  surplusHist?: number[];
  /** …and what the Treasury's own asks sold here each of those days. */
  stateHist?: number[];
  /** The town's own flows of the good over the same days (stats/flows.ts): made, used up, brought in, sent out. */
  madeHist?: number[];
  usedHist?: number[];
  inHist?: number[];
  outHist?: number[];
  traded: boolean; // true if volume > 0 today
  bestBid: number;
  bestAsk: number;
  hist: number[]; // daily base price, last MARKET_HIST_DAYS
  volHist: number[]; // daily volume
  curve: CurveSnapshot | null;
  /**
   * The market's own price: what today's auction would have cleared at without the Treasury's
   * orders (= price on days it has none), and its smoothed value. Treasury orders that follow the
   * market anchor to ownEma, so a large order does not chase the price its own buying raised.
   */
  own?: number;
  ownEma?: number;
  /** Today's sessions (opening, midday, close): price and volume of each. */
  sess?: number[];
  sessVol?: number[];
}

/** Transient order (lives only during one day's market phase). */
export interface Order {
  ref: Ref;
  side: 0 | 1; // 0 = buy (bid), 1 = sell (ask)
  /** Limit in the owner's terms: buyers = max gross per unit, sellers = min net per unit. */
  limit: number;
  qty: number;
  exempt: boolean; // Treasury orders ignore levies
  /** Extra per-order levy (e.g. port duties): fraction of base, and ¤ per unit. Positive = to the Treasury. */
  xPct: number;
  xUnit: number;
  /** Owner-specific tag (e.g. trader destination town, player order id). */
  tag: number;
  // ---- set by the auction ----
  base: number; // limit converted to base-price terms
  filled: number; // units executed (during a session: in that session; after the day: in all)
  price: number; // base price of execution
  paid: number; // ¤ actually paid (buyer, gross) or received (seller, net)
  // ---- the day's three sessions (markets.clearAll) ----
  /** The day's quantity as placed (qty is each session's release while they run). */
  dayQty?: number;
  /** Still to trade today. */
  left?: number;
  /** Released in the current session (before the Treasury's own crossing orders cancelled). */
  released?: number;
  filledDay?: number;
  paidDay?: number;
  /** Trade only in this session (0 opening, 1 midday, 2 close); absent/−1 = spread over the day. */
  session?: number;
}

export interface Book {
  town: TownId; // -1 national
  good: number;
  bids: Order[];
  asks: Order[];
  wedge: Wedge;
  ceiling: number; // -1 none
  floor: number; // -1 none
}

// ---------------------------------------------------------------------------
// Policy (the player's levers)
// ---------------------------------------------------------------------------
export type LevyBase =
  | 'sale'
  | 'wage'
  | 'profit'
  | 'money'
  | 'goods'
  | 'head'
  | 'rent'
  | 'interest'
  | 'shipment'
  | 'import'
  | 'export'
  | 'building'
  | 'estate';

export type LevyUnit = 'pct' | 'perUnit' | 'flat';

export type LevyPayer =
  | 'buyer'
  | 'seller'
  | 'employer'
  | 'worker'
  | 'holder'
  | 'tenant'
  | 'landlord'
  | 'owner'
  | 'receiver';

export type Group =
  | 'all'
  | 'employed'
  | 'unemployed'
  | 'homeless'
  | 'owners'
  | 'nonowners'
  | 'hungry'
  | 'persons'
  | 'firms';

export interface Levy {
  id: number;
  label: string;
  enabled: boolean;
  dir: 1 | -1; // 1 = take (Treasury receives), -1 = give (Treasury pays)
  base: LevyBase;
  unit: LevyUnit;
  /** pct: fraction (0.1 = 10 %; for 'money' it is per YEAR); perUnit / flat: ¤. Always >= 0; sign is `dir`. */
  rate: number;
  payer: LevyPayer;
  threshold: number; // only the part of the base above this is levied (¤ per agent per day, or per event)
  good: number; // GoodId or -1 any
  town: number; // TownId or -1 any
  toTown: number; // shipments: destination or -1 any
  sector: Sector | 'any';
  group: Group;
  buildingKind: BuildingKind | 'any';
  created: number;
  until: number; // day it expires, -1 never
  /**
   * Aimed rate (sale rules in %, on one good). Each morning the rate is re-set, town by
   * town, so that what the payer pays (buyers: auction price + the rate) or receives
   * (sellers: auction price − the rate) moves toward `aim` (¤ per unit), never above
   * `aimMax`. 0 or less = a fixed rate. While aimed, `rate` holds today's highest town rate
   * and `aimRates` the rate in each town (length = number of towns). Absent on fixed rules.
   */
  aim?: number;
  aimMax?: number;
  aimRates?: number[];
  // accounting (¤, positive = collected, negative = paid out)
  today: number;
  month: number;
  lastMonth: number;
  total: number;
}

/** A levy as the player states it (the aimed-rate fields are optional; see Levy.aim). */
export type LevyInput = Omit<Levy, 'id' | 'created' | 'today' | 'month' | 'lastMonth' | 'total' | 'aimRates'>;

export type LimitKind =
  | 'priceMax'
  | 'priceMin'
  /** How far a price may move in a day: the auction's ceiling/floor are yesterday's price × (1 ± value). */
  | 'priceMove'
  | 'wageMin'
  | 'wageMax'
  | 'rentMax'
  | 'rentMin'
  | 'rateMax'
  | 'rateMin'
  | 'importMax'
  | 'exportMax'
  | 'shipMax'
  | 'reserveMin'
  /** Replaces the bank's standing capital rule (BANK_MIN_CAPITAL), higher or lower (never below BANK_OWN_MIN_CAPITAL). */
  | 'capitalMin';

export interface Limit {
  id: number;
  label: string;
  enabled: boolean;
  kind: LimitKind;
  /** GoodId, -1 any / n.a.; the price kinds (priceMax/priceMin/priceMove) also take IOU_GOOD / GOLD_GOOD (town -1). */
  good: number;
  town: number; // -1 all towns / n.a. (shipMax: origin)
  toTown: number; // shipMax destination, -1 any
  value: number; // price ¤, wage ¤, rent ¤, rate fraction, quantity/day, ratio fraction; priceMove: fraction a day
  created: number;
  until: number; // -1 never
  binding: number; // days (this month) the limit actually bound
}

export type OrderMarket =
  | { kind: 'good'; town: TownId; good: GoodId }
  | { kind: 'labor'; town: TownId }
  | { kind: 'iou' }
  | { kind: 'gold' };

export interface PlayerOrder {
  id: number;
  label: string;
  enabled: boolean;
  market: OrderMarket;
  side: 'buy' | 'sell';
  price: number; // limit (base terms; labour: wage)
  qty: number; // per day (labour: number of workers wanted)
  total: number; // lifetime cap on units, -1 none
  until: number; // last day active, -1 never
  once: boolean; // true = active for a single day
  filled: number; // lifetime units
  value: number; // lifetime ¤ (positive = spent)
  filledToday: number;
  created: number;
  /**
   * How the limit is set each day: 'fixed' = `price` as entered; 'follow' = the market's
   * going price (its smoothed clearing price) plus `band` for buys / minus `band` for sells,
   * re-set every morning; 'any' = no limit (buys keep buying through spikes, capped only by
   * the Purse; sells take whatever the auction pays). For 'follow'/'any', `price` holds
   * today's effective limit.
   */
  priceMode: OrderPriceMode;
  band: number; // fraction, for 'follow' (0.1 = within 10 % of the going price)
  /**
   * 'follow' orders (not labour): 'patient' bids as low as it can (sells: asks as much as it
   * can) — each day it opens at its step (`offset`) and, when a session leaves it short, bids
   * higher in the next (the close at the band's edge if need be); the next day opens a step below
   * the lowest step that filled, so it keeps probing for the lowest price that gets its quantity;
   * 'eager' always bids the band's edge.
   * Absent = 'eager' (orders from before this choice). New orders default to 'patient'.
   */
  pace?: OrderPace;
  /**
   * 'patient' orders: the step away from the going price (fraction within ±band; + = pays more /
   * accepts less) — the day opens at it and a session left short raises it for the rest of the day;
   * after the close it holds where tomorrow opens.
   */
  offset?: number;
  /** 'patient' orders: the highest step the day reached (for display). */
  reached?: number;
  /** Units of today's order cancelled against the Treasury's own opposite order in the same market (it never trades with itself). */
  nettedToday?: number;
  /**
   * When in the day it trades: 0 the opening, 1 midday, 2 the close — all of the day's quantity in
   * that session, none elsewhere. Absent: spread over the day's three sessions like everyone's.
   */
  session?: number;
  /**
   * Labour orders only. 'projects': each morning the number of people employed is re-set to
   * what the Treasury's building projects in the town can use (construction.treasuryCrewWanted),
   * never more than `qty`; as projects finish the crew is let go. Absent: a fixed number (`qty`).
   * For labour, priceMode 'follow' means the town's going wage (its average posted wage) + band.
   */
  staff?: 'projects';
  /** 'projects' orders: the number of people wanted today. */
  staffToday?: number;
}

export type OrderPriceMode = 'fixed' | 'follow' | 'any';
export type OrderPace = 'patient' | 'eager';

/**
 * A Treasury carry rule: moves the Treasury's own goods from its store in `from` to its store in
 * `to` by wagon — on a Treasury freight line on that road if it has room, otherwise with the
 * trading house of `from`, for freight paid from the Purse. It neither buys nor sells: orders fill
 * and empty the stores, a carry only moves what is held. Loads leave after a market session
 * (policy/carry.ts), and arrivals land in the store at `to` (where a sell order can offer them).
 */
export interface CarryRule {
  id: number; // shares s.ids.policy with levies, limits, orders and lines
  label: string;
  enabled: boolean;
  from: TownId;
  /**
   * Several stores to pull from (≥ 2 towns, `from` = the first): each load draws on them equally
   * (as far as each holds the good). Absent: `from` alone.
   */
  sources?: TownId[];
  /**
   * The town it carries to, or −1: wherever the good runs short — each load goes to the town, among
   * those where the Treasury has a sell order for the good, that needs it most (carry.shortTargets:
   * its 14-day shortage plus what the Treasury sells there a day, over the days a load takes, less
   * what the Treasury holds there or has on the road to it).
   */
  to: TownId;
  good: GoodId;
  /** Units a day at most; −1 = everything the Treasury holds of the good in `from`, as it comes in. */
  qty: number;
  /**
   * true: carry only what the destination needs (carry.destNeed — its shortage over the last days
   * plus what the Treasury sells there a day, over the days a load takes plus one, less what the
   * Treasury holds there or has on the road to it). Rules to "where it runs short" always do.
   */
  need?: boolean;
  /**
   * 'full': a wagon leaves once it is CARRY_FULL_SHARE full — or once the goods have waited as long
   * as they keep (carry.carryHoldDays), a Treasury freight line on the road has room, or the rule's
   * last day has come; 'now': what is held leaves after every market session (quicker; dearer per
   * unit when loads are small, since the Purse pays a whole wagon's trip however little it carries).
   */
  wagons: 'full' | 'now';
  until: number; // last day active, −1 never
  created: number;
  /** qty ≥ 0 rules: units it may still load (qty is added each morning; banked while goods wait for a fuller wagon). */
  allow: number;
  /** Day the goods now waiting for a fuller wagon began waiting (−1: none waiting). */
  heldSince: number;
  carriedToday: number;
  carried: number; // lifetime units loaded
  freightToday: number;
  freight: number; // lifetime ¤ of freight paid
}

/** How a Treasury freight line charges for what it carries: a fixed ¤ per unit, its own running cost per unit, or nothing. */
/**
 * What a Treasury freight line charges the trading houses per unit carried: 'fixed' ¤, 'cost' — what
 * its trips cost it × (1 + margin), 'under' — the house's own freight on that leg × (1 − margin)
 * (the most they would pay, less a share), or 'free'.
 */
export type LineFare = 'fixed' | 'cost' | 'under' | 'free';
/** How a Treasury freight line keeps its drivers (FreightLine.staffing). */
export type LineStaffing = 'asNeeded' | 'permanent';

/**
 * A Treasury freight line: Treasury wagons (tools held by the line) driven by Treasury
 * workers of town `a` carry other people's goods between `a` and `b`, in both directions.
 * Wagons are kept, drivers hired, and fuel and wagons bought in `a`. Trading houses of
 * `a` and `b` load onto it when its fare is below their own cost of carting; the fare is
 * paid to the Purse, and the Purse pays the drivers, the oil and the wagons. The Treasury's
 * own cargo between the two towns rides it too (no fare). See policy/lines.ts.
 */
export interface FreightLine {
  id: number; // shares s.ids.policy with levies, limits and orders
  label: string;
  enabled: boolean; // false = paused: takes no new loads, buys nothing, keeps only the drivers on the road
  a: TownId; // the depot town
  b: TownId;
  wagonsWanted: number; // fleet the Treasury keeps (whole wagons)
  fare: LineFare;
  farePrice: number; // ¤ per unit when fare === 'fixed'
  /**
   * 'cost': the markup over what its trips cost per unit (0 = at cost, 0.2 = +20 %, below 0 =
   * the Purse pays part); 'under': how far below the trading houses' own freight the fare is set
   * (0.1 = 10 % less than their own wagons would cost them on that leg). Absent = 0 / 0.1.
   */
  margin?: number;
  fareToday: number; // ¤ per unit charged today (the rule applied each morning; 'under': the mean of the two legs)
  wage: number; // daily wage offered to its drivers (the going carters' wage in `a`)
  created: number;
  // ---- capital & stores (Treasury property, kept apart from treasury.goods) ----
  tools: number; // tools making up the wagons (wagons = floor(tools / TOOLS_PER_WAGON))
  wagons: number;
  oil: number; // fuel store (units)
  oilBasis: number; // average cost of the fuel in store (¤/unit)
  busy: number[]; // for each wagon on the road: day it is free again
  drivers: number; // Treasury workers of `a` the line wants today
  crew: number; // of whom it had today
  /**
   * How the line keeps its drivers: 'asNeeded' — as many as the wagons asked for need (the EMA of
   * use × LINE_DRIVER_SLACK), the rest back to the town's works crew; 'permanent' — one driver per
   * wagon of the fleet, kept on while the line runs or is paused (let go only when it closes).
   * Absent: 'asNeeded' (lines from before the choice).
   */
  staffing?: LineStaffing;
  /**
   * The line's own drivers (person ids): Treasury workers of `a` posted to it (lines.staffLines).
   * They drive only for this line — never on building sites — and are the last let go when the
   * town's Treasury crew shrinks.
   */
  staff: number[];
  useEma: number; // EMA of wagons wanted on the road (busy + loads asked for)
  costEma: number; // EMA of the daily cost of its trips (¤: drivers' days on the road, fuel burnt, road wear) — the 'at cost' fare
  unitsEma: number; // EMA of units carried a day
  // ---- today ----
  carriedToday: number; // units loaded today (both directions)
  legsToday: number; // loaded wagon departures today
  faresToday: number; // ¤ received
  costToday: number; // ¤ running cost (drivers + fuel burnt + wear)
  // ---- lifetime ----
  carried: number; // units
  legs: number; // loaded wagon departures
  fares: number; // ¤ received from traders
  wages: number; // ¤ paid to its drivers
  fuelCost: number; // ¤ of fuel burnt (at what it cost)
  wear: number; // ¤ of wagons worn out (at the tools price of the day)
  oilSpent: number; // ¤ paid for fuel
  toolsSpent: number; // ¤ paid for wagons (tools bought)
}

export interface Policy {
  levies: Levy[];
  limits: Limit[];
  orders: PlayerOrder[];
  /** Treasury freight lines. */
  lines: FreightLine[];
  /** Standing rules carrying the Treasury's goods between its stores. */
  carries: CarryRule[];
}

// ---------------------------------------------------------------------------
// Player actions (UI -> Game.dispatch)
// ---------------------------------------------------------------------------
export type TransferGroup = Group | 'bank';

export type PlayerAction =
  | { type: 'mint'; amount: number }
  | { type: 'burn'; amount: number }
  | {
      type: 'placeOrder';
      market: OrderMarket;
      side: 'buy' | 'sell';
      price: number;
      qty: number;
      total?: number;
      days?: number; // undefined/0 = standing until cancelled
      once?: boolean;
      label?: string;
      /** Default 'fixed'. With 'follow'/'any', `price` may be omitted (it is set daily from the market). Labour: 'fixed' or 'follow' (the going wage + band). */
      priceMode?: OrderPriceMode;
      band?: number;
      /** 'follow' orders: 'patient' (default) or 'eager' (see PlayerOrder.pace). */
      pace?: OrderPace;
      /** Trade in one market session only (0 opening, 1 midday, 2 close); default: all day. */
      session?: number;
      /** Labour orders: staff the town's Treasury projects automatically (`qty` = the most to employ). */
      staff?: 'projects';
    }
  | {
      type: 'updateOrder';
      id: number;
      patch: Partial<Pick<PlayerOrder, 'price' | 'qty' | 'enabled' | 'total' | 'until' | 'priceMode' | 'band' | 'pace'>> & {
        /** Market session to trade in (0 opening, 1 midday, 2 close), or −1 for all day. */
        session?: number;
        /** Labour orders: 'projects' = staff the town's Treasury projects automatically; 'fixed' = a set number. */
        staff?: 'projects' | 'fixed';
      };
    }
  | { type: 'cancelOrder'; id: number }
  | {
      /**
       * Carry Treasury goods from its store in `from` to its store in `to`. `once`: now, `qty` units
       * (−1 = all held), and no rule is kept. Otherwise a standing rule (CarryRule): up to `qty` a day
       * (−1 = everything held, as it comes in) for `days` days (absent/0 = until removed).
       */
      type: 'carry';
      from: TownId;
      to: TownId;
      good: GoodId;
      qty: number;
      /** Pull from several stores equally (≥ 2 towns; `from` must be one of them). */
      sources?: TownId[];
      /** Carry only what the destination needs (see CarryRule.need). */
      need?: boolean;
      once?: boolean;
      days?: number;
      wagons?: CarryRule['wagons'];
      label?: string;
    }
  | { type: 'updateCarry'; id: number; patch: { qty?: number; need?: boolean; enabled?: boolean; wagons?: CarryRule['wagons']; until?: number } }
  | { type: 'removeCarry'; id: number }
  | { type: 'addLevy'; levy: LevyInput }
  | { type: 'updateLevy'; id: number; patch: Partial<Levy> }
  | { type: 'removeLevy'; id: number }
  | { type: 'addLimit'; limit: Omit<Limit, 'id' | 'created' | 'binding'> }
  | { type: 'updateLimit'; id: number; patch: Partial<Limit> }
  | { type: 'removeLimit'; id: number }
  | { type: 'setWindow'; reserveRate: number; lendRate: number }
  /** Road between two towns: paving along the way wagons go (grade 2, the default), or a new dirt track (grade 1). */
  | { type: 'build'; kind: 'road'; from: TownId; to: TownId; grade?: 1 | 2 }
  /** Road between any two tiles `a` and `b` (tile indices): a dirt track (grade 1) or paving (grade 2, the default). */
  | { type: 'build'; kind: 'track'; a: number; b: number; grade?: 1 | 2 }
  | { type: 'build'; kind: 'house' | 'pier'; town: TownId; x?: number; y?: number }
  | { type: 'build'; kind: 'firm'; sector: Sector; town: TownId; x?: number; y?: number }
  | { type: 'build'; kind: 'expand'; firm: number }
  | { type: 'cancelProject'; id: number }
  | {
      /** Open a Treasury freight line between two towns (wagons, drivers and fuel kept in `a`). */
      type: 'openLine';
      a: TownId;
      b: TownId;
      wagons: number;
      fare: LineFare;
      /** ¤ per unit, for fare 'fixed'. */
      farePrice?: number;
      /** 'cost': markup over the line's cost (0.2 = +20 %); 'under': share below the houses' own freight (0.1 = 10 %). */
      margin?: number;
      /** How it keeps its drivers (default 'asNeeded'). */
      staffing?: LineStaffing;
      label?: string;
    }
  | { type: 'updateLine'; id: number; patch: { wagons?: number; fare?: LineFare; farePrice?: number; margin?: number; enabled?: boolean; staffing?: LineStaffing } }
  /** Close a line: its wagons (tools) and fuel go to the Treasury's stores in its depot town. */
  | { type: 'closeLine'; id: number }
  | {
      type: 'transfer';
      group: TransferGroup;
      town: number;
      amount: number; // ¤ per recipient; or, with `good`, units per recipient
      dir: 1 | -1;
      /** In kind: hand out (dir 1) units of a good the Treasury holds in `town` (town required). */
      good?: GoodId;
      /** With group 'firms': only workshops of this trade. */
      sector?: Sector;
    }
  | { type: 'setAutoMint'; value: boolean }
  | { type: 'setEvents'; value: boolean };

export interface ActionResult {
  ok: boolean;
  message: string;
  id?: number;
}

// ---------------------------------------------------------------------------
// Statistics & news
// ---------------------------------------------------------------------------
export interface Stats {
  /** Daily series, each capped to STATS_DAILY_CAP most recent values. */
  daily: Record<string, number[]>;
  /** Monthly series (one value per 30-day month), whole history. */
  monthly: Record<string, number[]>;
  /** Day index of daily[k][0] (daily series share one start). */
  dailyStart: number;
  /** Month index of monthly[k][0]. */
  monthlyStart: number;
  /** Latest values of every tracked indicator (for the top bar / panels). */
  latest: Record<string, number>;
  /** CPI basket: base quantities per consumer good (length N_GOODS) and base rent weight. */
  basket: number[];
  basketRent: number;
  basePrices: number[]; // national base-price vector used for real GDP (length N_GOODS)
  baseCost: number; // basket cost at base (for CPI = 100)
  baseWage: number;
  baseRent: number;
  baseFreight: number;
  /** Today's accumulators (reset at beginDay). Keys documented in stats.ts. */
  acc: Record<string, number>;
  /** Month accumulators (reset at month start). */
  macc: Record<string, number>;
}

export type NewsKind = 'info' | 'good' | 'bad' | 'policy' | 'market' | 'crisis';

export interface NewsItem {
  day: number;
  text: string;
  kind: NewsKind;
  town: number; // -1 national
}

// ---------------------------------------------------------------------------
// Whole simulation state
// ---------------------------------------------------------------------------
export interface Settings {
  events: boolean; // random events on/off
  scenario: string;
  realmName: string;
}

export interface Ids {
  person: number;
  firm: number;
  building: number;
  loan: number;
  shipment: number;
  project: number;
  policy: number; // levies, limits and player orders share this counter
}

export interface SimState {
  version: number;
  seed: number;
  /** The realm's investment experience (agents/experience.ts). Absent until the first venture is judged. */
  invest?: InvestState;
  rng: number[]; // RNG state words
  day: number; // days since founding (warm-up included)
  startDay: number; // day the player took control (after warm-up)
  map: MapData;
  towns: Town[];
  buildings: Building[]; // index = id
  people: Person[]; // index = id
  firms: Firm[]; // index = id
  loans: Loan[]; // active loans only (inactive ones are pruned)
  shipments: Shipment[]; // in transit
  projects: Project[]; // active/queued (done ones pruned after a while)
  markets: MarketState[]; // index = town * N_GOODS + good
  iouMarket: MarketState;
  goldMarket: MarketState;
  bank: Bank;
  treasury: Treasury;
  foreign: Foreign;
  policy: Policy;
  stats: Stats;
  news: NewsItem[]; // newest last, capped
  ids: Ids;
  settings: Settings;
}

// ---------------------------------------------------------------------------
// Investment experience (agents/experience.ts)
// ---------------------------------------------------------------------------
export interface InvestState {
  /** A small neural network: features → how far off the investors' formula is (annual return). */
  net: { w1: number[]; b1: number[]; w2: number[]; b2: number; trained: number; err: number };
  /** Ventures waiting to be judged: what was known, the return promised, the capital put in. */
  pending: { project: number; firm: number; day: number; x: number[]; promised: number; capital: number }[];
}
