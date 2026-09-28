// ============================================================================
// Every behavioural / calibration constant lives here, grouped by module.
// Rates are per YEAR unless the name ends in _DAY. Money in ¤. Time in days.
// Implementers: add constants to YOUR module's section (small, surgical edits).
// ============================================================================

export const SIM_VERSION = 1;

// ---- Calendar ---------------------------------------------------------------
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360
/** Days simulated silently before the player takes control. */
export const WARMUP_DAYS = 360;

// ---- World generation (world/*) ---------------------------------------------
export const MAP_W = 112;
export const MAP_H = 76;
export const TOWN_POP: Record<'capital' | 'farm' | 'mining' | 'harbor', number> = {
  capital: 250,
  farm: 130,
  mining: 140,
  harbor: 120,
};
/** Initial share of each town's people who own firms/houses. */
export const OWNER_SHARE = 0.12;
/** Target initial unemployment rate. */
export const INIT_UNEMPLOYMENT = 0.05;
/** Initial housing vacancy rate. */
export const INIT_HOUSING_VACANCY = 0.06;
/** Initial household cash, in days of income (median; lognormal spread). */
export const INIT_CASH_DAYS = 35;
export const INIT_CASH_SIGMA = 0.5;
/** Extra wealth of owners, in days of income. */
export const INIT_OWNER_CASH_DAYS = 400;
/** Firms start with this many days of costs in cash. */
export const INIT_FIRM_CASH_DAYS = 18;
/** Fraction of firms that start with a loan, and its size as a share of capital. */
export const INIT_LOAN_SHARE = 0.45;
export const INIT_LOAN_TO_CAPITAL = 0.35;
/** Bank's initial equity as a fraction of its loans (and a floor in ¤). */
export const INIT_BANK_EQUITY_RATIO = 0.14;
export const INIT_BANK_EQUITY_MIN = 8000;
export const INIT_PURSE = 12000;
export const INIT_TREASURY_GOLD = 150; // oz
export const INIT_GOLD_PRICE = 100; // ¤ per oz
export const INIT_RESERVE_RATE = 0.02;
export const INIT_LEND_RATE = 0.05;

// ---- Prices, wages (calibration anchors used by world/init & production) ----
export const BASE_WAGE = 10; // ¤ per worker-day at founding
/** Founding prices = markup × (materials + tool wear + w/(α·prod)). 1.0 = firms exactly at optimal size;
 *  profits then come from decreasing returns (1−α of value added). */
export const BASE_MARKUP = 1.0;
/** Rent per house slot per day at founding, as a share of BASE_WAGE. */
export const BASE_RENT_SHARE = 0.16;

// ---- Households: consumption (agents/demandModel.ts, households.ts) --------
export const FOOD_NEED = 1.0; // food units per person per day (subsistence)
export const FOOD_SIGMA = 3.0; // CES elasticity bread <-> fish
export const FOOD_W_BREAD = 0.68; // CES weight of bread
export const FOOD_W_FISH = 0.32;
export const FOOD_MAX = 1.35; // max food units eaten per day
export const HEAT_MEAN = 0.3; // coal per day, annual mean
export const HEAT_AMP = 0.85; // seasonal amplitude (fraction of mean)
/** Shares of supernumerary (above-subsistence) budget. Must sum to 1. */
export const SHARE_FOOD = 0.15;
export const SHARE_ALE = 0.33;
export const SHARE_FURNITURE = 0.45;
export const SHARE_COAL = 0.07;
/** Own-price elasticities used to shape bid ladders. */
export const ELASTICITY: Record<number, number> = { 1: 0.8, 3: 0.4, 8: 0.5, 9: 1.2, 10: 1.4 }; // fish, coal, bread, ale, furniture
/** Bid ladder rungs (multipliers of expected gross price), high to low. */
export const BID_RUNGS = [2.5, 1.6, 1.25, 1.1, 1.0, 0.9, 0.8, 0.65];
/** How much above its planned food spend a hungry household will bid. */
export const FOOD_FLEX = 2.0;
export const PANTRY_DAYS_BREAD = 2;
export const PANTRY_DAYS_FISH = 1;
export const PANTRY_DAYS_COAL = 12;
export const ALE_MAX_PER_DAY = 1.5;
export const FURNITURE_WEAR_DAY = 0.003;
/** Buffer-stock saving rule. */
export const BUF_BASE_DAYS = 30;
export const BUF_RATE_DAYS = 300; // × clamp(real deposit rate)
export const BUF_UNEMP_DAYS = 120; // × local unemployment rate
export const SPEND_DOWN_DAYS = 60;
export const INCOME_EMA = 0.05; // per day
export const INFL_EXP_EMA = 0.02; // per day
/** Portfolio (IOUs, gold) */
export const PORTFOLIO_SURPLUS_MULT = 2.0; // only savings above m* × this are invested
export const IOU_MARGIN = 0.005; // IOU yield must beat deposit rate by this
export const GOLD_HEDGE_TRIGGER = 0.03; // expected inflation − deposit rate above this → buy gold
export const PORTFOLIO_DAILY_FRACTION = 0.03;

// ---- Households: health & contentment ---------------------------------------
export const HEALTH_EMA = 0.03;
export const CONTENT_EMA = 0.02;
export const HUNGRY_BELOW = 0.7; // food satisfaction below this counts as hungry
export const STARVING_HEALTH = 0.2;

// ---- Labour (agents/labor.ts) ------------------------------------------------
export const JOB_SAMPLE = 6; // vacancies an unemployed person looks at per day
export const OTJ_SEARCH_PROB = 0.02; // employed people searching per day
export const OTJ_SWITCH_GAIN = 0.08; // switch if net wage gain ≥ 8 %
export const COMMUTE_COST_PER_TILE = 0.004; // fraction of wage lost per tile of commute
export const MAX_COMMUTE_TILES = 30;
export const RES_WAGE_START = 0.9; // reservation wage = this × last wage when newly unemployed
export const RES_WAGE_FLOOR = 0.55; // … decaying to this after RES_WAGE_DECAY_DAYS
export const RES_WAGE_DECAY_DAYS = 90;

// ---- Firms (agents/firms.ts, production.ts) ---------------------------------
export const HIRE_RATE = 0.1; // max share of capacity hired per day (at least 1)
export const FIRE_RATE = 0.05; // max share of workforce fired per day (at least 1)
export const TARGET_SMOOTH = 0.2; // target workforce EMA
export const WAGE_UP_DAY = 0.004;
export const WAGE_DOWN_DAY = 0.0015;
export const WAGE_VACANCY_DAYS = 3;
export const WAGE_INDEXATION = 0.5; // share of expected inflation passed into wages
export const INV_TARGET_DAYS = 7; // non-perishable output inventory target (days of sales)
export const INV_TARGET_DAYS_PERISHABLE = 1.5;
export const INV_MAX_DAYS = 40; // stop producing beyond this
export const INPUT_BUFFER_DAYS = 5;
/** Output share achievable with no tools at all (tools are complements to labour). */
export const TOOLLESS = 0.35;
/** Firms keep this many days of tool wear on hand beyond the tools in use. */
export const TOOLS_BUFFER_DAYS = 12;
export const TOOLS_GAP_CLOSE = 0.25; // share of tools gap bid for per day
export const TOOLS_IDLE_WEAR_DAY = 0.0005;
export const CASH_TARGET_DAYS = 15;
export const CASH_LOW_DAYS = 5;
export const DIVIDEND_SHARE = 0.5;
export const PRICE_EXP_EMA = 0.1;
export const SALES_EMA = 0.1;
export const PROFIT_EMA = 1 / 30;
export const DISTRESS_BANKRUPT_DAYS = 20;
export const ASK_RUNGS = [0.85, 0.95, 1.0, 1.08, 1.2]; // multipliers of pExp
export const ASK_WEIGHTS = [0.15, 0.2, 0.25, 0.2, 0.2];
export const ASK_COST_FLOOR = 0.6; // never ask below this × unit variable cost (unless distressed)
export const LIQUIDATION_DAYS = 5;

// ---- Entry / expansion (agents/entry.ts) --------------------------------------
export const ENTRY_HURDLE = 0.12; // required return above the loan rate (risk + scarcity of entrepreneurs)
export const ENTRY_MAX_PROB = 0.5;
export const ENTRY_OWNER_EQUITY = 0.25; // owner must fund this share of cost
export const HOUSE_HURDLE = 0.04;

// ---- Construction (agents/construction.ts) -----------------------------------
export const BUILD_MARGIN = 1.12; // builders bill cost × this
export const BUILD_TARGET_DAYS = 60; // builders size workforce to clear queue in this many days
export const MAX_ACTIVE_PROJECTS = 3;
export const STALL_CANCEL_DAYS = 120;

// ---- Traders (agents/traders.ts) ---------------------------------------------
export const SPEED_OFFROAD = 6; // tiles per day
export const SPEED_DIRT = 20;
export const SPEED_PAVED = 45;
export const WAGON_CAPACITY = 40; // units per wagon
export const OIL_PER_TILE = 0.04; // oil per wagon per tile
export const TOOLS_PER_WAGON = 3; // a wagon is bought as this many tools
export const WAGON_WEAR_DAY = 0.01; // tools worn per wagon-day on the road
export const TRADE_MIN_MARGIN_PCT = 0.05;
export const TRADE_MIN_MARGIN_ABS = 0.05;
export const TRADE_DEST_ABSORB = 0.35; // don't ship more than this × destination daily volume (+shortage)
export const STOCK_AGE_DISCOUNT_DAYS = 10;

// ---- Bank (agents/bank.ts) ----------------------------------------------------
export const BANK_BASE_SPREAD = 0.025;
export const BANK_RISK_PREMIUM = 0.06; // × leverage²
export const BANK_DEPOSIT_SPREAD = 0.01;
export const BANK_MIN_CAPITAL = 0.08;
export const BANK_DSCR = 1.25;
export const BANK_MAX_LEVERAGE = 0.75;
export const BANK_IOU_MARGIN = 0.004;
export const BANK_DIVIDEND_SHARE = 0.5;
export const BANK_FAIL_GRACE_DAYS = 30;
export const LOAN_DEFAULT_OVERDUE_DAYS = 60;
export const WORKING_LOAN_TERM = 180;
export const INVEST_LOAN_TERM = 720;
export const STARTUP_LOAN_TERM = 1440;
export const HOUSE_LOAN_TERM = 3600;

// ---- IOUs ---------------------------------------------------------------------
export const IOU_COUPON = 5; // ¤ per IOU per year
export const IOU_PAR = 100;

// ---- Foreign (agents/foreign.ts) ---------------------------------------------
export const IMPORT_MARKUP = 0.18;
export const EXPORT_DISCOUNT = 0.14;
export const SHIP_CAP_SHARE = 0.04; // ship capacity per good ≈ this × national daily use
export const PIER_CAP_BONUS = 0.5; // each pier adds this × base capacity
export const WORLD_DRIFT_SIGMA = 0.004; // daily log-random-walk of world prices
export const DEALER_DEPTH = 6; // oz per 1 % deviation from dealer value
export const DEALER_PPP_PULL = 0.01; // per day
export const DESK_WORKING_COIN = 500;

// ---- Demography (agents/demography.ts) --------------------------------------
export const BIRTH_RATE = 0.012; // per person per year (healthy, housed)
export const DEATH_RATE = 0.01; // base per year
export const HUNGER_DEATH_DAY = 0.003;
export const EMIGRATE_PROB_DAY = 0.003;
export const EMIGRATE_UNEMP_DAYS = 60;
export const IMMIGRATION_MAX_SHARE = 0.03; // per month, of town population
export const MIGRATE_PROB_DAY = 0.02; // long-unemployed consider moving towns

// ---- Housing (agents/housing.ts) ---------------------------------------------
export const RENT_UP = 0.03; // monthly adjustment when full with waiting list
export const RENT_DOWN = 0.03; // monthly adjustment when vacant ≥ 30 days
export const EVICT_ARREARS_DAYS = 10;
export const MOVE_CLOSER_PROB_DAY = 0.01;
export const MOVE_COMMUTE_TILES = 15;
export const MAX_RENT_SHARE = 0.45; // won't rent a slot costing more than this × income

// ---- Unrest / events ------------------------------------------------------------
export const UNREST_CONTENT = 0.3;
export const UNREST_DAYS = 10;
export const STRIKE_DAYS = 5;
export const STRIKE_FACTOR = 0.4;

// ---- Stats / history ---------------------------------------------------------
export const STATS_DAILY_CAP = 1440;
export const MARKET_HIST_DAYS = 360;
export const NEWS_CAP = 300;
