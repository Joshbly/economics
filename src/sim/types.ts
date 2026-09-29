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
  owner: Ref; // person ref, or STATE
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
  tiles: number[]; // road: tile indices to pave
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
  order: number; // Treasury supply-route order id this cargo belongs to, or -1
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------
export type LoanPurpose = 'working' | 'invest' | 'startup' | 'house' | 'project';

export interface Loan {
  id: number;
  borrower: Ref;
  principal: number; // outstanding ¤
  spread: number; // over the bank's base rate (annual)
  rate: number; // current annual rate
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
  traded: boolean; // true if volume > 0 today
  bestBid: number;
  bestAsk: number;
  hist: number[]; // daily base price, last MARKET_HIST_DAYS
  volHist: number[]; // daily volume
  curve: CurveSnapshot | null;
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
  filled: number; // units executed
  price: number; // base price of execution
  paid: number; // ¤ actually paid (buyer, gross) or received (seller, net)
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
  // accounting (¤, positive = collected, negative = paid out)
  today: number;
  month: number;
  lastMonth: number;
  total: number;
}

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
   * Supply route (goods buy orders only): every unit this order buys is loaded onto
   * the Treasury's wagons and carried to `route.to`, where it is offered in that
   * town's market. null = an ordinary order.
   */
  route: OrderRoute | null;
  /**
   * How the limit is set each day: 'fixed' = `price` as entered; 'follow' = the market's
   * going price (its smoothed clearing price) plus `band` for buys / minus `band` for sells,
   * re-set every morning; 'any' = no limit (buys keep buying through spikes, capped only by
   * the Purse; sells take whatever the auction pays). For 'follow'/'any', `price` holds
   * today's effective limit.
   */
  priceMode: OrderPriceMode;
  band: number; // fraction, for 'follow' (0.1 = within 10 % of the going price)
}

export type OrderPriceMode = 'fixed' | 'follow' | 'any';

/**
 * A Treasury supply route: buy in the order's town → carry → offer at the destination.
 * Composed entirely of real steps: the purchase clears in the origin auction, freight
 * is paid to the origin's trading house from the Purse, the goods ride real wagons,
 * and they are sold through the destination's auction like any other ask.
 */
export interface OrderRoute {
  to: TownId; // destination town
  /** How the goods are offered on arrival: at a fixed floor, at landed cost (+margin), or for whatever they fetch. */
  sell: 'fixed' | 'cost' | 'market';
  sellPrice: number; // floor (base ¤/unit) when sell === 'fixed'
  sellMargin: number; // when sell === 'cost': floor = landed cost × (1 + sellMargin)
  inTransit: number; // units on the road now
  waiting: number; // units arrived at `to` and not yet sold
  landed: number; // average landed cost per unit (purchase + freight) of the waiting units
  shippedToday: number;
  soldToday: number;
  shippedTotal: number; // lifetime units loaded
  soldTotal: number; // lifetime units sold at the destination
  freightPaid: number; // lifetime ¤ of freight
  revenue: number; // lifetime ¤ received from sales at the destination
}

export interface Policy {
  levies: Levy[];
  limits: Limit[];
  orders: PlayerOrder[];
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
      /** Goods BUY orders only: carry everything bought to another town and offer it there. */
      route?: { to: TownId; sell: OrderRoute['sell']; sellPrice?: number; sellMargin?: number };
      /** Default 'fixed'. With 'follow'/'any', `price` may be omitted (it is set daily from the market). Not for labour. */
      priceMode?: OrderPriceMode;
      band?: number;
    }
  | {
      type: 'updateOrder';
      id: number;
      patch: Partial<Pick<PlayerOrder, 'price' | 'qty' | 'enabled' | 'total' | 'until' | 'priceMode' | 'band'>> & {
        /** Supply routes only: change how goods are offered at the destination. */
        route?: { sell: OrderRoute['sell']; sellPrice?: number; sellMargin?: number };
      };
    }
  | { type: 'cancelOrder'; id: number }
  | {
      type: 'moveGoods';
      from: TownId;
      to: TownId;
      good: GoodId;
      qty: number;
      /** Optionally offer the goods at the destination once they arrive (a sell order capped at qty). */
      sell?: { mode: OrderRoute['sell']; price?: number; margin?: number };
    }
  | { type: 'addLevy'; levy: Omit<Levy, 'id' | 'created' | 'today' | 'month' | 'lastMonth' | 'total'> }
  | { type: 'updateLevy'; id: number; patch: Partial<Levy> }
  | { type: 'removeLevy'; id: number }
  | { type: 'addLimit'; limit: Omit<Limit, 'id' | 'created' | 'binding'> }
  | { type: 'updateLimit'; id: number; patch: Partial<Limit> }
  | { type: 'removeLimit'; id: number }
  | { type: 'setWindow'; reserveRate: number; lendRate: number }
  | { type: 'build'; kind: 'road'; from: TownId; to: TownId }
  | { type: 'build'; kind: 'house' | 'pier'; town: TownId; x?: number; y?: number }
  | { type: 'build'; kind: 'firm'; sector: Sector; town: TownId; x?: number; y?: number }
  | { type: 'build'; kind: 'expand'; firm: number }
  | { type: 'cancelProject'; id: number }
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
