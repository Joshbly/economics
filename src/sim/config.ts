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
/** Bank's initial equity as a fraction of its loans (and a floor in ¤). */
export const INIT_BANK_EQUITY_RATIO = 0.13;
export const INIT_BANK_EQUITY_MIN = 8000;
export const INIT_PURSE = 12000;
export const INIT_TREASURY_GOLD = 150; // oz
export const INIT_GOLD_PRICE = 100; // ¤ per oz
export const INIT_RESERVE_RATE = 0.02;
export const INIT_LEND_RATE = 0.05;
// -- added by world engineer --
// Note on INIT_CASH_DAYS / INIT_CASH_SIGMA / INIT_OWNER_CASH_DAYS: world/init sets every
// household's deposits at the stationary point of the household rules for its shopping phase
// (world/init.householdSteady: the balance at which spending over the year equals income — for
// workers ≈ INIT_CASH_DAYS of income, for owners more, because food and ale caps and lumpy
// purchases make them hold more than m*), with a lognormal spread of INIT_CASH_SIGMA / 2;
// owners' extra is capped at INIT_OWNER_CASH_DAYS × BASE_WAGE. Cash above the stationary level
// would be spent down within ~SPEND_DOWN_DAYS as a demand boom, cash below it as a slump.
/** Workers on each town's founding construction project (a house nearly finished). */
export const INIT_BUILDERS = 3;
/** Building capacity over the calibrated workforce (farms get more for the harvest peak). */
export const INIT_CAPACITY_HEADROOM = 1.3;
export const INIT_FARM_CAPACITY_HEADROOM = 1.6;
/** Largest building level used at founding. */
export const INIT_MAX_LEVEL = 5;
/** Trading houses' working capital at founding, in days of their merchandise purchases (goods bought, on the road, on sale). */
export const INIT_TRADER_WC_DAYS = 6;
/** Trading houses at founding: wagons and drivers per wagon in use. */
export const INIT_WAGON_SLACK = 1.6;
export const INIT_DRIVER_SLACK = 1.2;
/** Founding loans are long mortgages on the firms' buildings (days): in the founding steady state firms carry their
 *  debt, and a short schedule would retire deposits faster than any new lending replaces them (a monetary squeeze).
 *  (Over two decades they are still repaid faster than new lending replaces them: the money stock drifts down.) */
export const INIT_LOAN_TERM = 7200;
/** Founding loans have at least this share of INIT_LOAN_TERM left … */
export const INIT_LOAN_LEFT_MIN = 0.5;
/** Bank reserves at founding: at least this share of deposits (any gap is window debt). */
export const INIT_RESERVE_MIN_SHARE = 0.08;
/** Founding bank credit: firms' mortgages (above) and landlords' house mortgages at the level they carry in the
 *  steady state (HOUSE_DEBT_*). With no founding IOUs, reserves = deposits + equity − credit: credit ≈ 85 % of
 *  deposits leaves reserves ≈ 25 % of deposits (equity 13 % of credit), so interest on reserves is a moderate Purse cost. */
/** World prices vs harbor prices at founding: goods cheap abroad (imported), dear abroad (exported), neutral. */
export const INIT_WORLD_CHEAP: [number, number] = [0.72, 0.82];
export const INIT_WORLD_DEAR: [number, number] = [1.2, 1.32];
export const INIT_WORLD_NEUTRAL: [number, number] = [0.9, 1.1];
export const INIT_WORLD_N_CHEAP = 3;
export const INIT_WORLD_N_DEAR = 3;
/** Founding landed prices sit this share above the traders' break-even (their rule needs a strictly positive margin to ship). */
export const INIT_TRADE_EDGE = 0.01;
/** Foreign desk coin at founding, in days of port trade. */
export const INIT_FOREIGN_COIN_DAYS = 30;
/** Rent spread within a town at founding (centre dearer), ± this share. */
export const INIT_RENT_SPREAD = 0.1;
/** Skill dispersion at founding (lognormal sigma, clamped 0.7..1.4). Firms count skill in effective labour, and with
 *  α ≈ 0.8 a firm's optimal size reacts ~5× to its workers' efficiency, so the founding spread is kept small. */
export const INIT_SKILL_SIGMA = 0.06;
/** Scenario presets (world/scenarios.ts). */
export const SCEN_WINTER_DROUGHT_DAYS = 120;
export const SCEN_WINTER_GRAIN_FACTOR = 1.6;
export const SCEN_WINTER_SHOCK_DAYS = 240;
export const SCEN_CREDIT_RESERVE_RATE = 0.005;
export const SCEN_CREDIT_LEND_RATE = 0.015;
export const SCEN_CREDIT_LOAN_SHARE = 0.85;
export const SCEN_CREDIT_LOAN_TO_CAPITAL = 0.45;

// ---- Prices, wages (calibration anchors used by world/init & production) ----
export const BASE_WAGE = 10; // ¤ per worker-day at founding
/** Firms price at this multiple of marginal cost (founding prices = markup × (materials + tool wear + marginal labour cost)).
 *  1.0 = perfect competition: profits then come only from decreasing returns (1−α of value added, ≈ 4 % of the price for
 *  material-heavy workshops) and any dip, interest bill or idle day puts a whole trade in the red. */
export const BASE_MARKUP = 1.1;
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
export const BUF_RATE_DAYS = 200; // × clamp(real deposit rate)
/** The real deposit rate (deposit rate − expected inflation) counts only within these bounds. With expected
 *  deflation bounded (INFL_EXP_MIN) the upper bound only binds for a deposit rate set high by the window rates. */
export const BUF_REAL_RATE_MIN = -0.03;
export const BUF_REAL_RATE_MAX = 0.12;
export const BUF_UNEMP_DAYS = 30; // × local unemployment rate
export const SPEND_DOWN_DAYS = 60;
export const INCOME_EMA = 0.03; // per day
export const INFL_EXP_EMA = 0.01; // per day
/**
 * Bounds of the inflation households expect (annual). Expected deflation is bounded tightly: a
 * year of falling prices after a good harvest or a drought's reversal does not make households
 * expect money to keep gaining value (which, through the real deposit rate, would raise every
 * buffer target and deepen the slump); expected inflation can run high (flight from coin).
 */
export const INFL_EXP_MIN = -0.03;
export const INFL_EXP_MAX = 0.3;
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
// -- added by households engineer --
/** Days ahead averaged for the coal-stocking heat forecast. */
export const HEAT_AHEAD_DAYS = 20;
/** Heat satisfaction below this counts as "cold". */
export const COLD_BELOW = 0.7;
/** Days of forecast heat kept in the coal store before burning extra coal for comfort. */
export const HEAT_RESERVE_DAYS = 6;
/** Ale enjoyment = 1 − exp(−ALE_JOY_SCALE · casks drunk); joy is its EMA. */
export const ALE_JOY_SCALE = 2.2;
export const JOY_EMA = 0.1;
/** Furniture stock at which comfort reaches 0.5 (comfort = F / (F + half)). */
export const COMFORT_HALF = 8;
/** Health target: food^HEALTH_FOOD_POW × heat term × housing term × age term. */
export const HEALTH_FOOD_POW = 1.5;
export const HEALTH_W_HEAT = 0.3; // max weight of cold (mid-winter)
export const HOMELESS_HEALTH = 0.85; // health target multiplier while homeless
export const OLD_AGE_START = 65; // health target declines after this age …
export const OLD_AGE_SPAN = 80; // … by (age − start)/span, capped at OLD_AGE_MAX_LOSS
export const OLD_AGE_MAX_LOSS = 0.25;
/** Contentment weights (sum 1). */
export const CONTENT_W_HEALTH = 0.2;
export const CONTENT_W_WORK = 0.15;
export const CONTENT_W_HOME = 0.15;
export const CONTENT_W_FOOD = 0.15;
export const CONTENT_W_COMFORT = 0.08;
export const CONTENT_W_JOY = 0.1;
export const CONTENT_W_INCOME = 0.17;
/** Inflation pain: expected inflation above START costs up to W at START+SPAN. */
export const INFL_PAIN_START = 0.03;
export const INFL_PAIN_SPAN = 0.2;
export const INFL_PAIN_W = 0.12;
/** Portfolio concentration caps (share of household wealth). */
export const PORTFOLIO_MAX_IOU_SHARE = 0.6;
export const PORTFOLIO_MAX_GOLD_SHARE = 0.4;
/** Smallest portfolio order worth placing (¤). */
export const PORTFOLIO_MIN_ORDER = 1;
/** Skip consumer bids whose planned spend is below this (¤) — avoids dust orders. */
export const MIN_BID_SPEND = 0.01;
/**
 * Order-load control. All households of a town bid at the same BID_RUNGS price levels,
 * so each household uses only this many rungs per good: a strided subset of BID_RUNGS
 * (e.g. 2 → {2.5,1.0} / {1.6,0.9} / {1.25,0.8} / {1.1,0.65}) rotating daily across
 * households. The town's aggregate demand curve keeps every level; auction load drops ~3×.
 * Set a good to BID_RUNGS.length for full individual ladders.
 */
export const HH_RUNGS: Record<number, number> = { 1: 3, 3: 2, 8: 3, 9: 2, 10: 2 }; // fish, coal, bread, ale, furniture
/** Furniture (durable) is bought every this many days, staggered, in proportionally larger lots. */
export const FURNITURE_SHOP_DAYS = 5;
/** While the coal store covers today plus this many days of forecast heat, coal is topped up only every COAL_SHOP_DAYS. */
export const COAL_COMFORT_DAYS = 6;
export const COAL_SHOP_DAYS = 4;

// ---- Labour (agents/labor.ts) ------------------------------------------------
export const JOB_SAMPLE = 6; // vacancies an unemployed person looks at per day
export const OTJ_SEARCH_PROB = 0.02; // employed people searching per day
export const OTJ_SWITCH_GAIN = 0.08; // switch if net wage gain ≥ 8 %
export const COMMUTE_COST_PER_TILE = 0.004; // fraction of wage lost per tile of commute
export const MAX_COMMUTE_TILES = 30;
export const RES_WAGE_START = 0.9; // reservation wage = this × last wage when newly unemployed
export const RES_WAGE_FLOOR = 0.55; // … decaying to this after RES_WAGE_DECAY_DAYS
export const RES_WAGE_DECAY_DAYS = 90;
// -- added by households engineer --
/** Share of job-search samples taken in the searcher's own town (rest: towns within commuting range). */
export const OWN_TOWN_SEARCH_SHARE = 0.75;
/** Reservation-wage multipliers when hungry / nearly broke (desperation). */
export const RES_WAGE_HUNGRY_MULT = 0.75;
export const RES_WAGE_BROKE_MULT = 0.85;
/** "Nearly broke" = cash below this many days of subsistence. */
export const BROKE_DAYS = 10;
/** Max vacancy-list entries per firm (sampling weight ∝ open slots, capped). */
export const VACANCY_SAMPLE_CAP = 12;

// ---- Firms (agents/firms.ts, production.ts) ---------------------------------
export const HIRE_RATE = 0.1; // max share of capacity hired per day (at least 1)
export const FIRE_RATE = 0.05; // max share of workforce fired per day (at least 1)
export const TARGET_SMOOTH = 0.05; // target workforce EMA
export const WAGE_UP_DAY = 0.002;
/**
 * A firm that cannot fill its vacancies raises pay faster the more a hand is worth to it: by
 * WAGE_UP_DAY × (1 + clamp(value / wage − WAGE_URGENCY_FROM, 0, WAGE_URGENCY_MAX)), where value
 * is the marginal worker's output at the expected price net of materials and tool wear. An oil
 * well whose oil sells at ten times its cost must not wait months to outbid the workshops for
 * hands (the whole realm's carting and fishing stop without oil).
 */
export const WAGE_URGENCY_FROM = 1.5;
export const WAGE_URGENCY_MAX = 4;
export const WAGE_DOWN_DAY = 0.0015;
export const WAGE_VACANCY_DAYS = 3;
export const WAGE_INDEXATION = 0.5; // share of expected inflation passed into wages
export const INV_TARGET_DAYS = 10; // non-perishable output inventory target (days of sales)
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
/** Share of the cash above the operating reserve (CASH_TARGET_DAYS of costs) paid to the owner each day. */
export const DIVIDEND_SHARE = 0.1;
export const PRICE_EXP_EMA = 0.2;
export const SALES_EMA = 0.05;
/** EMA speed of the de-seasonalised sales that output and workforce are planned on (Firm.salesLong). */
export const SALES_LONG_EMA = 1 / 60;
export const PROFIT_EMA = 1 / 30;
/**
 * EMA speed of the slow profit (Firm.profitLong) a firm in a seasonal trade (farms, coal
 * mines) judges its losses on: a winter of selling the carried harvest below the cost of the
 * lean season's output is part of a profitable year, not a reason to shed hands.
 */
export const PROFIT_LONG_EMA = 1 / 180;
export const DISTRESS_BANKRUPT_DAYS = 20;
export const ASK_RUNGS = [0.85, 0.95, 1.0, 1.08, 1.2]; // multipliers of pExp
export const ASK_WEIGHTS = [0.15, 0.2, 0.25, 0.2, 0.2];
export const ASK_COST_FLOOR = 0.6; // never ask below this × unit variable cost (unless distressed)
export const LIQUIDATION_DAYS = 5;
// -- added by firms engineer --
/** A lower workforce target is adopted only once the plan falls this share below it (hysteresis vs hire-fire churn). */
export const TARGET_HYSTERESIS = 0.04;
/** The workforce target moves at most this share (+ TARGET_MAX_STEP_ABS workers) per day: with α near 1 the optimal
 *  workforce reacts very strongly to margins, so firms feel their way toward it rather than jumping. */
export const TARGET_MAX_STEP = 0.01;
export const TARGET_MAX_STEP_ABS = 0.2;
/** Planned daily sales at ≤ pExp stay within these multiples of expected sales, however far stock is from target. */
export const ASK_QS_MIN = 0.5;
export const ASK_QS_MAX = 2.5;
/** Asks move at most this share a day toward the price at which the firm's optimal output meets demand (P = MC). */
export const ASK_COMPETE_STEP = 0.05;
/** Firms judge output at the price they can reach within this many days of ask steps (price setters pass costs on). */
export const PRICE_PLAN_DAYS = 5;
/** A firm with under CASH_LOW_DAYS of wages in cash plans no more workers than its expected takings plus its cash spread over this many days can pay. */
export const LIQUIDITY_DAYS = 5;
/** …and keeps this many days of that payroll in hand (wages are paid before the day's takings arrive). */
export const LIQUIDITY_RESERVE_DAYS = 1.5;
/** Owners top up a cash-starved firm (firms.ts ownerSupport) unless its profit EMA has been negative this many days. */
export const OWNER_SUPPORT_MAX_LOSS_DAYS = 60;
/** Output inventory gaps are closed over this many days (perishables: faster). */
export const INV_ADJUST_DAYS = 30;
export const INV_ADJUST_DAYS_PERISHABLE = 3;
/**
 * A seasonal trade (farms, coal mines) closes the gap to its seasonal stock path over this
 * many days: a drought or a mild winter moves the stock a long way off the path, and closing
 * that within a month would hire for a harvest that comes anyway and lay off after it.
 */
export const INV_ADJUST_DAYS_SEASONAL = 90;
/** Planned output never deviates from expected sales by more than this share for the sake of the stock target. */
export const INV_CORR_MAX = 0.15;
/** A firm whose profit EMA has been negative this many days sheds workers (at most this share of them per plan, step-capped). */
export const LOSS_SHRINK_DAYS = 10;
export const LOSS_SHRINK_SHARE = 0.1;
/** Short-run supply response of planned output to (price / marginal cost): elasticity and bound (± share). */
export const SUPPLY_ELASTICITY = 1.0;
export const SUPPLY_RESP_MAX = 0.1;
export const SUPPLY_RESP_DOWN = 0.05;
/**
 * Scarcity: once the price exceeds the marginal cost of serving normal sales by more than this
 * factor, the upward bound on the supply response widens by ln(price / (cost × factor)) — a
 * price several times cost (a town whose brewers all stopped when grain spiked) says buyers
 * want far more than is being made, and the makers expand as fast as they can hire instead of
 * 10 % a season at a time. Small margins keep the narrow, stable response.
 */
export const SUPPLY_SCARCITY_FROM = 1.5;
/** Share of all coal burnt for heating (the rest fires ovens and forges): coal demand's seasonal swing. */
export const COAL_HEAT_SHARE = 0.5;
/**
 * A producer of a seasonal-demand good (coal) learns the season from its own last twelve
 * months of sales (Firm.salesMonths) once the record is complete and plausible: every month
 * sold something and the busiest month sold at most this many times the slackest.
 */
export const SEASON_OBS_MAX_RATIO = 6;
/** Firms plan to produce a little more than they expect to sell, so that unmet demand can reveal itself. */
export const DEMAND_SLACK = 0.05;
/** Share of the town market's unmet demand (shortage) a firm adds to its sales expectation, pro rata to its market share. */
export const SHORTAGE_WEIGHT = 0.5;
/** Firms younger than this (days) with little sales history plan with a capacity heuristic: NEW_FIRM_SCALE × typical size. */
export const NEW_FIRM_DAYS = 45;
export const NEW_FIRM_SCALE = 0.6;
/**
 * For its first NEW_FIRM_RAMP_DAYS an entrant plans at least its share of the town's sales of
 * its good (the town's sales divided among its makers — the premise it entered on) and prices
 * at its own cost to win it. Planning only on its own sales, a one-hand workshop that sells
 * what one hand makes would never learn whether it could sell more, and would bleed its
 * start-up loan dry at a tenth of the size it was built for.
 */
export const NEW_FIRM_RAMP_DAYS = 180;
/** Output multiplier on farms while a drought is on (town.droughtDays > 0). */
export const DROUGHT_FACTOR = 0.5;
/**
 * Posted wages drift down only while local unemployment is above WAGE_CUT_UNEMP and the firm has
 * no vacancy: a firm losing money (or in distress) cuts at WAGE_DOWN_DAY, any other at a rate that
 * rises from 0 to WAGE_DOWN_DAY as unemployment climbs WAGE_CUT_SPAN above the threshold — with
 * people queueing for jobs whose reservation wages are falling, even a profitable firm needs
 * to pay less to hire and keep its hands (the downward side of the Phillips curve).
 */
export const WAGE_CUT_UNEMP = 0.06;
export const WAGE_CUT_SPAN = 0.1;
/** Absolute floor on any posted wage (¤/day), a numerical guard. */
export const WAGE_MIN_ABS = 0.5;
/** Cash held back from market purchases, in days of the firm's wage bill (tomorrow's payroll comes first). */
export const WAGE_RESERVE_DAYS = 1;
/** Ask ladder: the quantity offered at ≤ pExp equals planned sales; stock beyond the ladder waits at this multiple (durables hold out). */
export const ASK_TOP_RUNG = 1.5;
/** Asks shift by (stock / target)^(−this), clamped to [ASK_SHIFT_MIN, ASK_SHIFT_MAX]. */
export const ASK_INV_ELASTICITY = 0.12;
export const ASK_SHIFT_MIN = 0.75;
export const ASK_SHIFT_MAX = 1.3;
/** The asks' cost anchor stays within this share of the firm's price expectation. */
export const ASK_ANCHOR_BAND = 0.25;
/** Perishable overstock (above INV_TARGET_DAYS_PERISHABLE of sales) is cleared at pExp × (1 − K·excess days·spoil/5 %), ≥ MIN. */
export const PERISH_CLEAR_K = 0.1;
export const PERISH_CLEAR_MIN = 0.5;
/** Distressed firms (unpaid wages, overdue loans) cut their asks by this factor to raise cash. */
export const DISTRESS_ASK_SHIFT = 0.93;
/** Liquidating firms dump all stock at this multiple of the market's net price. */
export const FIRE_SALE = 0.5;
/** Input bid ladder: price multipliers of the expected gross price (steeper when stocks run low) and quantity shares. */
export const INPUT_BID_RUNGS = [1.3, 1.12, 1.03, 0.96, 0.9];
export const INPUT_BID_WEIGHTS = [0.1, 0.2, 0.3, 0.2, 0.2];
/** Cash goes first to inputs for this many days of production, then tools (at most TOOLS_CASH_SHARE of what is left), then the rest of the input buffer. */
export const INPUT_ESSENTIAL_DAYS = 2;
export const TOOLS_CASH_SHARE = 0.5;
/** Firms badly short of tools bid up to this multiple of the expected tools price (tools are essential complements),
 *  but never above this multiple of what tools cost to make (firms.fairPrice). */
export const TOOLS_MAX_BID_MULT = 2.5;
/** Distress counter falls by this per day without distress (so intermittent trouble still accumulates). */
export const DISTRESS_RECOVER = 2;
/** Working-capital loans: retry at most every this many days (daily while wages go unpaid); total working debt ≤ MAX days of costs. */
export const WORKING_LOAN_RETRY_DAYS = 5;
export const WORKING_DEBT_MAX_DAYS = 60;
/** Firms holding more than this many days of costs in cash repay working loans early (month end). */
export const PREPAY_CASH_DAYS = 30;
/** Working capital a new firm starts with, in days of typical costs (financed with the building). */
export const NEW_FIRM_WC_DAYS = 20;
export const ENTRY_HURDLE = 0.12; // required return above the loan rate (risk + scarcity of entrepreneurs)
export const ENTRY_MAX_PROB = 0.5;
export const ENTRY_OWNER_EQUITY = 0.25; // owner must fund this share of cost
export const HOUSE_HURDLE = 0.04;
// -- added by firms engineer --
/** Entry decisions are taken on this day of the month. */
export const ENTRY_DAY = 15;
/** At most this many new private projects per town per month; none while the builder already has this many private jobs queued. */
export const ENTRY_MAX_PER_TOWN = 2;
export const BUILDER_MAX_PRIVATE_QUEUE = 3;
/** Entry probability = ENTRY_PROB_SLOPE × (expected return − required)/required, capped at ENTRY_MAX_PROB. */
export const ENTRY_PROB_SLOPE = 1.0;
/** A firm's profits count in its sector's return signal once it is this old (days). */
export const ENTRY_MIN_AGE = 60;
/** Return estimates for sectors with no local firm yet are discounted by this (uncertainty). */
export const ENTRY_NEW_SECTOR_DISCOUNT = 0.8;
/** Extra return credited per unit of (market shortage / volume). */
export const ENTRY_SHORTAGE_BONUS = 0.1;
/** Spread over the bank's base rate assumed when screening sectors (before a borrower is chosen). */
export const ENTRY_SCREEN_SPREAD = 0.02;
/** An entrepreneur keeps at least this many days of income after putting up the equity. */
export const ENTRY_OWNER_RESERVE_DAYS = 60;
/** Most firms one person will own. */
export const ENTRY_MAX_OWNED = 4;
/** Vacant buildings are reopened for this share of a new building's cost. */
export const REOPEN_COST_SHARE = 0.35;
/** Most levels a building can be expanded to. */
export const MAX_BUILDING_LEVEL = 4;
/** Developers build when the town's housing vacancy is below this (or homeless outnumber empty slots). */
export const HOUSE_VACANCY_TRIGGER = 0.03;
/** A project waiting for its loan is dropped if no loan arrives within this many days. */
export const FINANCING_WAIT_DAYS = 3;
/** Voluntary exit: a firm older than EXIT_MIN_AGE days whose profit EMA has been negative for EXIT_LOSS_DAYS closes. */
export const EXIT_LOSS_DAYS = 90;
export const EXIT_MIN_AGE = 180;
/** Monthly probability that an eligible loss-maker actually closes; owners holding this many days of costs in cash wait longer. */
export const EXIT_PROB = 0.3;
export const EXIT_PATIENT_CASH_DAYS = 60;
/** At most this many voluntary exits per trade and town a month (the worst loss-makers first). */
export const EXIT_MAX_PER_TRADE = 1;
export const BUILD_MARGIN = 1.12; // builders bill cost × this
export const BUILD_TARGET_DAYS = 60; // builders size workforce to clear queue in this many days
export const MAX_ACTIVE_PROJECTS = 3;
/** Treasury crews work on every Treasury project in their town at once (not only on the builders'
 *  MAX_ACTIVE_PROJECTS): up to this many projects a builder in all. */
export const STATE_PARALLEL_MAX = 8;
export const STALL_CANCEL_DAYS = 120;
// -- added by firms engineer --
/** Labour on a project may run at most this share ahead of its least-supplied material. */
export const LABOR_AHEAD_MAX = 0.1;
/** Builders keep in stock up to this share of each active project's material needs (or all that remains). */
export const BUILDER_STOCK_SHARE = 0.25;
/** Share of the material gap bid for per day, and the bid ladder (multiples of expected gross price) with quantity shares. */
export const BUILDER_BID_CLOSE = 0.5;
export const BUILDER_BID_RUNGS = [1.25, 1.1, 1.0];
export const BUILDER_BID_WEIGHTS = [0.3, 0.3, 0.4];
/** Builders never bid above this multiple of what a material costs to make (firms.fairPrice). */
export const BUILDER_MAX_BID_MULT = 1.6;
/** Remaining labour of a project waiting for materials counts only this share when sizing the builder's workforce. */
export const BUILDER_BLOCKED_SHARE = 0.3;
/** Effective labour of a Treasury worker on construction (no tools of their own). */
export const STATEWORKS_BUILD_EFF = 0.8;
/** Labour orders that staff Treasury projects: size the crew to do a project's remaining labour in about this many days. */
export const AUTO_CREW_DAYS = 30;
/** …and employ at most this many people in a town unless the order says otherwise. */
export const AUTO_CREW_MAX = 60;
/** Builders hire at most this many workers beyond those their tools can equip (construction.ts constructionPlan). */
export const BUILDER_TOOLLESS_HANDS = 2;
/** Routes are recomputed after this many newly paved tiles (and on completion). */
export const ROAD_INVALIDATE_TILES = 5;
/**
 * Clearing new ground for a track, × TRACK_TILE_COST, by terrain (DeepWater, Water, Sand,
 * Grass, Forest, Hills, Mountain, Marsh): felling forest, cutting into hills and mountain
 * sides, draining marsh.
 */
export const TRACK_CLEAR_FACTOR: readonly number[] = [0, 0, 1.2, 1, 2.2, 1.8, 4, 2.6];
/** Finished/cancelled projects kept in s.projects for the UI (most recent). */
export const PROJECT_KEEP_DONE = 24;

// ---- Traders (agents/traders.ts) ---------------------------------------------
export const SPEED_OFFROAD = 8; // tiles per day
export const SPEED_DIRT = 30;
export const SPEED_PAVED = 70;
export const WAGON_CAPACITY = 120; // units per wagon
export const OIL_PER_TILE = 0.04; // oil per wagon per tile
export const TOOLS_PER_WAGON = 3; // a wagon is bought as this many tools
export const WAGON_WEAR_DAY = 0.01; // tools worn per wagon-day on the road
export const TRADE_MIN_MARGIN_PCT = 0.05;
export const TRADE_MIN_MARGIN_ABS = 0.05;
export const TRADE_DEST_ABSORB = 0.35; // don't ship more than this × destination daily volume (+shortage)
export const STOCK_AGE_DISCOUNT_DAYS = 10;
// -- added by finance-trade engineer --
/** Stop shipping a good to a town once traders' stock there + in transit exceeds the daily allowance × (travel days + this). */
export const TRADE_PENDING_DAYS = 2;
export const TRADE_PENDING_DAYS_DURABLE = 6;
/** Smallest daily allowance (units) a destination with no recorded volume still offers (lets a route start). */
export const TRADE_MIN_ABSORB = 2;
/** Traders read the destination's demand curve: they aim to supply this share of the demand left unmet
 *  (by other sellers) at the price that just covers their landed cost. */
export const TRADE_CURVE_SHARE = 1.0;
/** Traders judge a good's home price at no more than this multiple of its cost of making there (firms.fairPrice). */
export const TRADE_FAIR_MULT = 1.5;
/** Without an order-book snapshot, traders assume the home market can supply this multiple of its traded volume. */
export const TRADE_SUPPLY_VOL_MULT = 1.5;
/** Stock waiting longer than a day (average age ≈ days of inventory) is offered this much cheaper per extra day, up to the max. */
export const TRADE_AGE_CUT_DAY = 0.03;
export const TRADE_AGE_MAX_CUT = 0.25;
/** Durable goods bought for a trip wait at home up to this many days for a fuller wagon. */
export const TRADE_HOLD_DAYS = 3;
/** A wagon leaves at once when loaded to at least this share of WAGON_CAPACITY (else it may wait, see TRADE_HOLD_DAYS). */
export const TRADE_MIN_LOAD = 0.5;
/** Merchandise stuck at home (no route pays, or no wagon/fuel to move it) is sold back locally after this many days. */
export const TRADE_HOME_SELL_DAYS = 6;
/** Routes slower than this (one way, days) are not served. */
export const TRADE_MAX_ROUTE_DAYS = 20;
/** Remote stock ask ladder (multipliers of the expected net price) and quantity shares. */
export const TRADE_ASK_RUNGS = [1.06, 1.0, 0.95];
export const TRADE_ASK_WEIGHTS = [0.3, 0.4, 0.3];
/** Unsold stock may be offered this far below its landed cost after STOCK_AGE_DISCOUNT_DAYS. */
export const TRADE_AGE_MAX_DISCOUNT = 0.4;
/** Traders keep fuel for TRADER_FUEL_DAYS of expected use, and never less than TRADER_OIL_TRIPS trips. */
export const TRADER_FUEL_DAYS = 6;
export const TRADER_OIL_TRIPS = 3;
/** Traders pay up to this multiple of oil's value at home for fuel, plus up to EXTRA more as their fuel runs out
 *  (never more than the oil price at which their best trip still breaks even). */
export const TRADER_OIL_BID_MULT = 1.1;
export const TRADER_OIL_BID_EXTRA = 3;
/** EMA speed of the wagons a trader wanted on the road (drives drivers and wagon investment). */
export const TRADER_USE_EMA = 0.15;
/** Drivers hired = wagons wanted × this; wagons wanted in the fleet = wagons wanted × TRADER_WAGON_SLACK. */
export const TRADER_DRIVER_SLACK = 1.1;
export const TRADER_WAGON_SLACK = 1.5;
/** Spare tools (fraction of one wagon) kept so wear does not immediately cost a wagon. */
export const TRADER_WEAR_BUFFER = 0.5;
/** Most wagons bought per day, and the premium over the expected tools price a trader pays for them. */
export const TRADER_INVEST_WAGONS_DAY = 1;
export const TRADER_TOOLS_BID_MULT = 1.03;
/** Cash kept back from merchandise bids, in days of the trader's wage bill. */
export const TRADER_CASH_RESERVE_DAYS = 4;
/** EMA speed of the freight-per-unit-per-tile index. */
export const FREIGHT_EMA = 0.1;
/** Extra charged to the Treasury when it has its own goods carried (on top of the full-wagon trip cost). */
export const TREASURY_FREIGHT_PREMIUM = 0.1;

// ---- Treasury freight lines (policy/lines.ts) ----------------------------------
/** Most wagons one line may keep. */
export const LINE_MAX_WAGONS = 60;
/** Highest fixed fare a line may charge (¤ per unit). */
export const LINE_MAX_FARE = 1000;
/** A freight line's 'cost' fare markup: from −90 % (the Purse pays most of the running cost) to +500 %. */
export const LINE_MARGIN_MIN = -0.9;
export const LINE_MARGIN_MAX = 5;
/** An 'under' fare: how far below the trading houses' own freight (default 10 %, at most 90 %). */
export const LINE_UNDER_DEFAULT = 0.1;
export const LINE_UNDER_MAX = 0.9;
/** Drivers hired = wagons wanted on the road (EMA) × this (never more than the wagons, never fewer than those on the road). */
export const LINE_DRIVER_SLACK = 1.15;
/** EMA speed of the wagons a line is asked for (busy + loads asked for today). */
export const LINE_USE_EMA = 0.15;
/** EMA speed of a line's daily running cost and units carried (the 'at cost' fare is their ratio). */
export const LINE_COST_EMA = 1 / 30;
/** Below this many units a day (EMA) the 'at cost' fare is a full wagon's trip cost per unit instead. */
export const LINE_COST_MIN_UNITS = 20;
/** The 'at cost' fare stays within these multiples of a full wagon's trip cost per unit. */
export const LINE_COST_FLOOR_MULT = 0.5;
export const LINE_COST_CAP_MULT = 3;
/** Spare tools a line keeps beyond its fleet (in wagons), so wear does not idle a wagon. */
export const LINE_WEAR_BUFFER = 0.5;
/** Most wagons' worth of tools a line buys a day. */
export const LINE_TOOLS_DAY = 2;
/** A line bids for its tools and oil at the going price + this share. */
export const LINE_BUY_BAND = 0.15;
/** A line keeps fuel for this many days of expected use, and at least LINE_FUEL_MIN_LEGS loaded legs per wagon. */
export const LINE_FUEL_DAYS = 4;
export const LINE_FUEL_MIN_LEGS = 1;
/** Drivers are offered the going carters' wage in the depot town plus this share. */
export const LINE_WAGE_PREMIUM = 0.05;

// ---- Bank (agents/bank.ts) ----------------------------------------------------
export const BANK_BASE_SPREAD = 0.025;
export const BANK_RISK_PREMIUM = 0.06; // × leverage²
export const BANK_DEPOSIT_SPREAD = 0.01;
/** The realm's standing rule: the bank keeps its own capital at no less than this share of its loans. A Limit on bank
 *  capital (limits.capitalMin) replaces the rule, higher or lower (bank.minCapital). */
export const BANK_MIN_CAPITAL = 0.08;
/** …but whatever a Limit allows, the bank's own prudence never lets its capital fall below this share of its loans. */
export const BANK_OWN_MIN_CAPITAL = 0.02;
export const BANK_DSCR = 1.25;
export const BANK_MAX_LEVERAGE = 0.75;
export const BANK_IOU_MARGIN = 0.004;
export const BANK_DIVIDEND_SHARE = 0.5;
export const BANK_FAIL_GRACE_DAYS = 30;
export const LOAN_DEFAULT_OVERDUE_DAYS = 60;
export const WORKING_LOAN_TERM = 360;
/** Loan purposes whose rate floats daily with the base rate (credit lines); every other purpose is fixed when made. */
export const LOAN_FLOATING_PURPOSES: readonly string[] = ['working'];
/** A fixed-rate borrower in good standing refinances when the day's rate for its loan is at least this much lower (annual). */
export const LOAN_REFI_GAP = 0.01;
export const INVEST_LOAN_TERM = 1440;
export const STARTUP_LOAN_TERM = 2880;
export const HOUSE_LOAN_TERM = 7200;
/** Reserves count as earning the reserve rate only while the Purse holds this many days of that interest (auto-mint off):
 *  the bank prices deposits and loans on the reserve interest it actually receives. */
export const BANK_RESERVE_PAY_DAYS = 30;
/** Pecking order: when the bank's base rate is above this, firms put a share of their spare cash ((base − ref)/ref,
 *  at most LOAN_PREPAY_MAX_SHARE) into paying down loans before paying their owners. */
export const LOAN_PREPAY_RATE_REF = 0.06;
export const LOAN_PREPAY_MAX_SHARE = 0.5;
/** Borrowers' appetite for long debt against capital already in place (bank.creditAppetite): a multiple of their normal
 *  leverage that is 1 at a loan rate of CREDIT_RATE_REF, falls by 1 for every CREDIT_RATE_SCALE of rate above it (none
 *  at REF + SCALE) and rises as money gets cheaper, up to CREDIT_MAX_MULT. */
export const CREDIT_RATE_REF = 0.05;
export const CREDIT_RATE_SCALE = 0.2;
export const CREDIT_MAX_MULT = 1.5;
/** Landlords' mortgages (agents/housing.landlordFinance): HOUSE_DEBT_LTV of their houses' book value × the appetite, none
 *  once the rate reaches the houses' rent yield. Each reviews it once a month: below HOUSE_DEBT_TOPUP × the desired debt
 *  they borrow the rest against their houses (mortgages roll over as they amortise); above HOUSE_DEBT_PAYDOWN × they pay
 *  it down with cash beyond HOUSE_DEBT_KEEP_DAYS of income. */
export const HOUSE_DEBT_LTV = 0.08;
export const HOUSE_DEBT_TOPUP = 0.85;
export const HOUSE_DEBT_PAYDOWN = 1.2;
export const HOUSE_DEBT_KEEP_DAYS = 60;
/** … paying down at most this share of the debt at each monthly review. */
export const HOUSE_DEBT_PAYDOWN_MONTH = 0.05;
/** … and interest + amortisation stay within this share of the rent the houses bring in. */
export const HOUSE_DEBT_MAX_SERVICE = 0.45;
/** Firms' long debt (agents/firms.desiredFirmDebt): FIRM_DEBT_LEV of their capital (building + tools) × the appetite,
 *  its interest + amortisation within FIRM_DEBT_MAX_SERVICE of profit. Every founding producer starts at that level; each
 *  month a sound producer below FIRM_DEBT_TOPUP × the desired debt borrows the rest over FIRM_DEBT_TERM days (the
 *  workshop's mortgage rolls over as it amortises). Dear money: the pecking order (LOAN_PREPAY_RATE_REF) pays it down. */
export const FIRM_DEBT_LEV = 0.145;
export const FIRM_DEBT_MAX_SERVICE = 0.6;
export const FIRM_DEBT_TOPUP = 0.8;
export const FIRM_DEBT_TERM = 3600;
// -- added by finance-trade engineer --
/** Operating reserves the bank keeps above any legal requirement (share of deposits). */
export const BANK_RESERVE_BUFFER = 0.01;
/** Window debt is repaid only once reserves exceed the target by this share of deposits (avoids daily churn). */
export const BANK_REPAY_HYST = 0.005;
/** Window debt (+ reserve shortfall) of this share of deposits makes the window rate the full marginal funding cost. */
export const BANK_TIGHT_SCALE = 0.02;
/** Lending stance: resting level, sensitivity to the annualised loss rate and to thin capital, daily speeds. */
export const BANK_STANCE_BASE = 0.2;
export const BANK_STANCE_LOSS_SENS = 25;
export const BANK_STANCE_CAP_SENS = 6;
export const BANK_STANCE_UP = 0.03; // per day, when tightening
export const BANK_STANCE_DOWN = 0.003; // per day, when loosening
/** Extra annual spread charged on new loans at stance 1. */
export const BANK_STANCE_SPREAD = 0.02;
/** Tighter stance raises the DSCR requirement by up to this share and cuts the leverage limit by up to this share. */
export const BANK_STANCE_DSCR = 0.6;
export const BANK_STANCE_LEVERAGE = 0.3;
/** Capital headroom above the minimum demanded at stance 1. */
export const BANK_STANCE_CAPITAL = 0.03;
/** EMA speed of the daily default-loss rate. */
export const BANK_DEFAULT_EMA = 1 / 90;
/** Extra spreads by borrower type (annual). */
export const BANK_STARTUP_PREMIUM = 0.01;
export const BANK_PERSON_PREMIUM = 0.005;
/** Share of a household's income the bank counts as available for debt service. */
export const BANK_INCOME_DEBT_SHARE = 0.35;
/** Annual cash yield the bank assumes on newly financed capital (firm investment / start-ups). */
export const BANK_PROJECT_YIELD = 0.15;
/** Annual cash yield the bank assumes on working capital it lends (stock and payroll turned over into sales). */
export const BANK_WORKING_YIELD = 0.1;
/** Firms younger than this are judged on their assets' assumed yield, not on a profit history. */
export const BANK_YOUNG_FIRM_DAYS = 90;
/** Smallest loan written (¤); working-capital requests may be cut down to this share of the request. */
export const BANK_MIN_LOAN = 5;
export const BANK_PARTIAL_MIN = 0.4;
/** A payment counts as made if at least this share of what was due was paid. */
export const BANK_PAY_TOLERANCE = 0.98;
/** On default the bank seizes the borrower's deposit, but a household keeps this many days of its income. */
export const BANK_DEFAULT_KEEP_DAYS = 5;
/** Dividends only while the capital ratio exceeds this. */
export const BANK_DIVIDEND_CAPITAL = 0.12;
/**
 * … measured on at least this share of deposits as a loan book: a bank whose old loans are
 * being repaid keeps the capital to lend again (paying out everything above 12 % of a
 * shrinking book would leave it unable to finance a single house when borrowers return).
 */
export const BANK_DIVIDEND_BOOK_SHARE = 0.4;
/** Bail-in restores the capital ratio to the legal/own minimum + BANK_STANCE_CAPITAL + this margin (so the bank can lend again). */
export const BANK_BAILIN_TARGET = 0.02;
/** Loans that finance new capital (invest, start-up, house, project) must leave this much capital headroom
 *  above what working-capital credit needs: existing customers' working capital comes first. */
export const BANK_TERM_CAPITAL_EXTRA = 0.02;
/** IOUs must yield more than the reserve rate + BANK_IOU_MARGIN + this term premium (they are perpetual). */
export const BANK_IOU_TERM_PREMIUM = 0.01;
/** IOU book capped at this share of deposits; this share of excess reserves bid per day. */
export const BANK_IOU_MAX_SHARE = 0.3;
export const BANK_IOU_BUY_FRACTION = 0.2;
/** Days of news silence between repeated warnings of the same kind. */
export const BANK_NEWS_GAP_DAYS = 30;
/** A borrower more than this many days behind on any loan is refused new credit. */
export const BANK_LATE_REFUSE_DAYS = 5;
/** Longest loan term written (days). */
export const BANK_MAX_TERM = 7200;

// ---- IOUs ---------------------------------------------------------------------
export const IOU_COUPON = 5; // ¤ per IOU per year
export const IOU_PAR = 100;

// ---- Markets & the player's primitives (market/*, policy/*) -------------------
// -- added by market-policy engineer --
/** Market reference price EMA: speed when the market traded today / when only an indicative price exists. */
/**
 * Market sessions a day: every market clears at the opening, at midday and at the close. The
 * orders placed for the day are released a share at a time (SESSION_RELEASE of what is still to
 * trade), so a day left alone clears at one price three times; what the sessions add is what
 * happens between them (Treasury orders aimed at one session, cargo landing, Treasury wagons
 * leaving). SESSION_TIMES: when each session is held (fraction of the day).
 */
export const MARKET_SESSIONS = 3;
export const SESSION_TIMES = [0.3, 0.5, 0.7];
export const SESSION_RELEASE = [1 / 3, 1 / 2, 1];

export const MARKET_EMA_TRADED = 0.15;
export const MARKET_EMA_INDICATIVE = 0.03;
/** A one-sided book (bids but no asks, or asks but no bids) quotes an indicative price at most this share above/below the reference. */
export const INDICATIVE_STEP = 0.25;
/** Smoothing of the daily traded volume (MarketState.volEma). */
export const MARKET_VOL_EMA = 0.1;
/** Max points per side kept in the order-book curve snapshot for the UI. */
export const CURVE_POINTS = 40;
/** Lowest / highest base price the auction will ever quote (keeps logs and divisions finite). */
export const PRICE_MIN = 1e-4;
export const PRICE_MAX = 1e8;
/** The combined percentage part of a sale wedge is clamped to these (per side) so every
 *  order still converts to a finite base price. Buyers: gross = base·(1+bPct), sellers: net = base·(1−sPct). */
export const WEDGE_BPCT_MIN = -0.95; // the Treasury may pay at most 95 % of the base on the buyer's behalf
export const WEDGE_BPCT_MAX = 20;
export const WEDGE_SPCT_MIN = -20;
export const WEDGE_SPCT_MAX = 0.95; // a seller always keeps at least 5 % of the base
/** Player input ranges (validation in policy/player.ts). */
export const PLAYER_MAX_MONEY = 1e10; // largest single mint / burn / transfer (¤)
export const PLAYER_MAX_QTY = 1e7; // largest order quantity per day (units)
export const PLAYER_MAX_PRICE = 1e7; // highest order price (¤ per unit)
export const PLAYER_MAX_PCT = 10; // highest percentage levy rate (10 = 1000 %)
export const PLAYER_MAX_UNIT_RATE = 1e6; // highest ¤ levy rate
export const PLAYER_MAX_RATE = 1; // highest annual rate at the window / in a loan-rate limit (100 %)
export const PLAYER_MIN_RATE = -0.1; // lowest annual rate at the window (−10 %)
export const PLAYER_MAX_RULES = 300; // levies + limits + orders
export const PLAYER_MAX_WORKERS = 5000; // largest Treasury labour order (workers)
/** Largest daily move a 'priceMove' Limit may allow (1 = 100 % a day); 0 holds the price where it stands. */
export const LIMIT_MOVE_MAX = 1;

// ---- Foreign (agents/foreign.ts) ---------------------------------------------
export const IMPORT_MARKUP = 0.18;
export const EXPORT_DISCOUNT = 0.14;
export const SHIP_CAP_SHARE = 0.04; // ship capacity per good ≈ this × national daily use
export const PIER_CAP_BONUS = 0.5; // each pier adds this × base capacity
export const WORLD_DRIFT_SIGMA = 0.004; // daily log-random-walk of world prices
export const DEALER_DEPTH = 6; // oz per 1 % deviation from dealer value
export const DEALER_PPP_PULL = 0.01; // per day
export const DESK_WORKING_COIN = 500;
// -- added by finance-trade engineer --
/** Foreign order tranches: [price multiplier, share of capacity]. Imports: dearer tranches; exports: cheaper. */
export const IMPORT_TRANCHES: [number, number][] = [[1.0, 0.5], [1.04, 0.3], [1.1, 0.2]];
export const EXPORT_TRANCHES: [number, number][] = [[1.0, 0.5], [0.96, 0.3], [0.9, 0.2]];
/** World prices mean-revert to their baseline (× any active shock) at this daily speed; faster while a shock is on. */
export const WORLD_REVERT_DAY = 0.004;
export const WORLD_SHOCK_PULL = 0.08;
/** World prices stay within these multiples of their baseline. */
export const WORLD_PRICE_MIN_MULT = 0.25;
export const WORLD_PRICE_MAX_MULT = 4;
/** Dealer quote centre: V' = dealerValue · (coin/target)^DESK_COIN_ELASTICITY (log-ratio clamped to ±2). */
export const DESK_COIN_ELASTICITY = 0.15;
/**
 * Desk target coin = this many days of its two-way port trade (EMA of min(imports, exports), speed
 * DESK_TRADE_EMA), ≥ DESK_WORKING_COIN. The desk keeps working coin for the trade that turns over
 * both ways: coin earned on a one-sided import surplus is a surplus it wants to shed, so it weakens
 * the coin instead of raising the desk's appetite for it (a target that grew with imports would let
 * the realm's money drain abroad without the exchange rate ever turning).
 */
export const DESK_COIN_DAYS = 30;
export const DESK_TRADE_EMA = 0.02;
/** Interest parity: the desk's target coin × exp(DESK_RATE_SENS · (deposit rate − WORLD_RATE)). WORLD_RATE = founding deposit rate. */
export const WORLD_RATE = 0.01;
export const DESK_RATE_SENS = 8;
/** Dealer quotes extend ±DEALER_BANDS % around V' (DEALER_DEPTH oz per 1 % band). */
export const DEALER_BANDS = 10;
/** Dealer value follows the traded gold price (net of the desk's own inventory premium) at this daily speed. */
export const DEALER_PRICE_PULL = 0.02;
/** Share of the desk's coin it may commit per day to buying exports / buying gold. */
export const DESK_EXPORT_COIN_SHARE = 0.5;
export const DESK_GOLD_COIN_SHARE = 0.4;
/** EMA speeds of foreign.goldEma and of the purchasing-power-parity estimate. */
export const GOLD_EMA = 0.05;
export const PPP_EMA = 0.02;
/** Ship capacity floor per good (units/day) and monthly smoothing toward the use-based level. */
export const SHIP_CAP_FLOOR = 3;
export const SHIP_CAP_SMOOTH = 0.4;

// ---- Demography (agents/demography.ts) --------------------------------------
export const BIRTH_RATE = 0.012; // per person per year (healthy, housed)
export const DEATH_RATE = 0.01; // base per year
export const HUNGER_DEATH_DAY = 0.003;
export const EMIGRATE_PROB_DAY = 0.003;
export const EMIGRATE_UNEMP_DAYS = 60;
export const IMMIGRATION_MAX_SHARE = 0.03; // per month, of town population
/**
 * Newcomers come for work while a town is hiring (it has vacancies) and its queue of job seekers
 * is shorter than this share of its people: they accept the chance of a spell without work, as
 * migrants to a boom town do (Harris–Todaro), so a growing town keeps a normal pool of job
 * seekers instead of every vacancy being filled from abroad the moment it opens.
 */
export const IMMIGRATION_QUEUE_SHARE = 0.04;
/**
 * … and only while the town's real wage (average wage / town CPI) is at least this share of
 * the realm's base real wage (the wage newcomers could earn elsewhere): arrivals taper off
 * between this share and the base. With a fixed stock of workshops and land, each hand adds less
 * than the last (α < 1): without the brake a hiring realm would draw people until wages fell
 * to subsistence and the homeless outnumbered the housed.
 */
export const IMMIGRATION_WAGE_FLOOR = 0.85;
export const MIGRATE_PROB_DAY = 0.02; // long-unemployed consider moving towns
// -- added by households engineer --
/** Mortality multiplier by age: DEATH_AGE_BASE + (1 − BASE)·exp((age − PIVOT)/SCALE). ≈1 on average for ages 18–80. */
export const DEATH_AGE_BASE = 0.3;
export const DEATH_AGE_PIVOT = 60;
export const DEATH_AGE_SCALE = 11;
/** Extra mortality for poor health: × (1 + POOR_HEALTH_MORT · max(0, 0.6 − health)). */
export const POOR_HEALTH_MORT = 4;
/** Births: a grown child forms a new household (age ADULT_AGE). Parent must be healthier than this. */
export const BIRTH_MIN_HEALTH = 0.6;
export const ADULT_AGE = 18;
/** Share of the parent's cash given to the new household (capped at BIRTH_GIFT_MAX_DAYS of parent income). */
export const BIRTH_GIFT_SHARE = 0.1;
export const BIRTH_GIFT_MAX_DAYS = 30;
/** Internal migration: unemployed this long consider other towns. */
export const MIGRATE_UNEMP_DAYS = 30;
/** Required advantage in (vacancies − unemployed)/pop before moving towns. */
export const MIGRATE_MIN_GAIN = 0.02;
/** Immigration runs on this day of the month. Immigrants bring ~this many days of local wages (lognormal). */
export const IMMIGRATION_DAY = 5;
export const IMMIGRANT_CASH_DAYS = 25;
/** Immigrants take at most this share of the foreign desk's coin each. */
export const IMMIGRANT_COIN_SHARE = 0.05;
/** Emigration push from misery is scaled down for owners (they have roots). */
export const OWNER_EMIGRATE_MULT = 0.3;

// ---- Housing (agents/housing.ts) ---------------------------------------------
export const RENT_UP = 0.03; // monthly adjustment when full with waiting list
export const RENT_DOWN = 0.03; // monthly adjustment when vacant ≥ 30 days
export const EVICT_ARREARS_DAYS = 10;
export const MOVE_CLOSER_PROB_DAY = 0.01;
export const MOVE_COMMUTE_TILES = 15;
export const MAX_RENT_SHARE = 0.45; // won't rent a slot costing more than this × income
// -- added by households engineer --
/** Someone with little income may still rent if cash covers this many days of rent. */
export const RENT_CASH_COVER_DAYS = 30;
/** Moving in requires cash for this many days of rent up front (so the just-evicted cannot re-rent at once). */
export const RENT_DEPOSIT_DAYS = 3;
/** Town vacancy rate below which full houses raise rent by RENT_UP/2 even without homeless. */
export const VACANCY_TIGHT = 0.03;
/** Days a slot must stay vacant before the landlord cuts rent. */
export const RENT_CUT_VACANT_DAYS = 30;
/** Floor on any rent (¤/slot/day). */
export const MIN_RENT = 0.05;
/** A long commuter moves only if (rent + commute cost) falls by at least this share. */
export const MOVE_MIN_SAVING = 0.05;

// ---- Unrest / events ------------------------------------------------------------
export const UNREST_CONTENT = 0.3;
export const UNREST_DAYS = 10;
export const STRIKE_DAYS = 5;
export const STRIKE_FACTOR = 0.4;
// -- added by stats engineer --
/** No random events before this many days have passed since the player took control (and never during warm-up). */
export const EVENT_GRACE_DAYS = 30;
/** Expected number of each random event per year (0 disables it). */
export const EVENT_DROUGHT_PER_YEAR = 0.5;
export const EVENT_BUMPER_PER_YEAR = 0.5;
export const EVENT_STORM_PER_YEAR = 0.5;
export const EVENT_MINE_PER_YEAR = 0.7;
export const EVENT_WORLD_SHOCK_PER_YEAR = 1.0;
/** Droughts strike in the growing season (day-of-year window) and last this long (farms produce ×0.5, see firms.ts). */
export const EVENT_DROUGHT_FROM_DOY = 30;
export const EVENT_DROUGHT_TO_DOY = 210;
export const EVENT_DROUGHT_DAYS = 60;
/** Bumper harvests come in the harvest window and add this many days of each farm's usual output. */
export const EVENT_BUMPER_FROM_DOY = 150;
export const EVENT_BUMPER_TO_DOY = 270;
export const EVENT_BUMPER_DAYS = 8;
/** A storm wrecks this share of every fishery's boats and nets (tools) in the stricken town. */
export const EVENT_STORM_TOOL_LOSS = 0.5;
/** A mine collapse buries this share of the mine's tools and costs each of its workers this much health. */
export const EVENT_MINE_TOOL_LOSS = 0.8;
export const EVENT_MINE_INJURY = 0.25;
/** World price shocks: factor ranges (up / down), probability of an upward shock (oil: higher), duration range (days). */
export const EVENT_SHOCK_UP_MIN = 1.35;
export const EVENT_SHOCK_UP_MAX = 1.9;
export const EVENT_SHOCK_DOWN_MIN = 0.6;
export const EVENT_SHOCK_DOWN_MAX = 0.8;
export const EVENT_SHOCK_UP_PROB = 0.55;
export const EVENT_SHOCK_UP_PROB_OIL = 0.75;
export const EVENT_SHOCK_MIN_DAYS = 90;
export const EVENT_SHOCK_MAX_DAYS = 180;
/** Market news: a monthly price move beyond this share is reported (at most EVENT_SWING_MAX items a month). */
export const EVENT_SWING = 0.25;
export const EVENT_SWING_MAX = 3;
/** Markets with a smoothed volume below this (units/day) are too thin to report on. */
export const EVENT_MIN_VOLUME = 0.5;
/** Shortage news: rationed share of demand at or above this for EVENT_SHORTAGE_DAYS days in a row. */
export const EVENT_SHORTAGE_SHARE = 0.25;
export const EVENT_SHORTAGE_DAYS = 5;
/** Minimum days between two news items of the same kind (per town / market where applicable). */
export const EVENT_NEWS_COOLDOWN = 60;
/** Alarm thresholds for the monthly realm-wide news. */
export const EVENT_ALARM_INFLATION = 0.1;
export const EVENT_ALARM_DEFLATION = -0.05;
export const EVENT_ALARM_UNEMP = 0.12;
export const EVENT_ALARM_HUNGER = 0.08;
export const EVENT_ALARM_HOMELESS = 0.08;
/** Population milestones are announced every this many households. */
export const EVENT_POP_STEP = 100;

// ---- Stats / history ---------------------------------------------------------
export const STATS_DAILY_CAP = 1440;
export const MARKET_HIST_DAYS = 360;
/** Shortage and surplus are also kept for this many days, for a steadier view than one day's (markets.recentBalance). */
export const MARKET_BALANCE_DAYS = 14;
export const NEWS_CAP = 300;
// -- added by stats engineer --
/** Inflation is measured between trailing means of this many daily CPI values (damps auction noise). */
export const STATS_INFL_WINDOW = 7;
/** With less history than the full lag, inflation blends the partial-window rate with the carried rate; below this span (days) only the carried rate is used. */
export const STATS_INFL_MIN_SPAN = 10;
/** Daily/monthly series values are rounded to this many significant digits (compact saves). */
export const STATS_SIG_DIGITS = 6;
/** Wealth share reported as `top10` (the richest this share of households). */
export const STATS_TOP_SHARE = 0.1;

// ---- Player order sanity (policy/player.ts) ---------------------------------
/** A new-IOU floor must be at least this share of today's IOU price. */
export const IOU_SELL_FLOOR_MIN_SHARE = 0.1;
/** Warn when a sell floor is below this share of today's price. */
export const SELL_FLOOR_WARN_SHARE = 0.5;

// ---- Treasury carry rules and 'any price' sales (policy/carry.ts, policy/player.ts) ----
/** A sell order at 'any price' (or a following sell at its lowest) asks no less than this share of the
 *  market's going price: a token floor, so the auction sets the price. */
export const ORDER_ANY_FLOOR_SHARE = 0.05;
/** A carry rule that sends full wagons (CarryRule.wagons 'full'): a wagon leaves once it is this
 *  full — the Purse pays a whole wagon's trip however little it carries — … */
export const CARRY_FULL_SHARE = 0.9;
/** … or once the goods waiting for it would lose this share to spoilage by waiting longer (bread: 2
 *  days), and never after more than CARRY_MAX_HOLD_DAYS (goods that keep). */
export const CARRY_SPOIL_BUDGET = 0.1;
export const CARRY_MAX_HOLD_DAYS = 7;
/** Bands offered for orders that follow the market (fractions of the going price). */
export const ORDER_BANDS = [0.05, 0.1, 0.2, 0.3];
export const ORDER_BAND_MAX = 1; // at most 100 % above/below the going price
/** 'Patient' orders that follow the market: a step = this share of the band (at least ORDER_PATIENT_STEP_MIN).
 *  Within the day a session left short raises the limit by at least a step (the close bids the band's
 *  edge); each day opens a step below the lowest step at which a session filled in full. */
export const ORDER_PATIENT_STEP_SHARE = 0.25;
export const ORDER_PATIENT_STEP_MIN = 0.005;
/** 'Any price' buys bid up to this multiple of the going price (effectively unlimited)... */
export const ORDER_ANY_MULT = 25;
/** ...and the Purse is budgeted as if they fill at this multiple (settlement scales fills that cannot be paid). */
export const ORDER_ANY_BUDGET_MULT = 1.5;

// Aimed levy rates (Levy.aim): a sale rule whose rate re-sets each morning, town by town,
// to move what the payer pays (or receives) toward a price.
export const AIM_SMOOTH = 0.35; // share of the gap to the rate that would hit the aim (at yesterday's auction price) closed each morning
export const AIM_MAX_DEFAULT = 0.5; // default ceiling on an aimed rate
export const AIM_MAX_CAP = 0.9; // highest ceiling a player may set
