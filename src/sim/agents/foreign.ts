// ============================================================================
// The outside world: foreign ships at the port and the gold market.
// OWNER: finance-trade agent. See DESIGN §3.6.
//
// World prices are quoted in gold; E (¤ per oz, the gold market's reference price)
// turns them into coin. Foreign ships post, every day, in the port town's markets:
//   sell orders (imports) at E·w·(1 + IMPORT_MARKUP), buy orders (exports) at
//   E·w·(1 − EXPORT_DISCOUNT), each in a few tranches up to the ship capacity.
// So a small open economy faces a price band for every tradable good: domestic
// prices cannot rise far above the landed import price nor fall far below what
// foreign buyers pay — unless a quota, a port duty or a lack of ship capacity
// cuts the link.
//
// The foreign desk (ref FOREIGN) is a private deposit at the bank: it earns coin
// by selling imports (and gold) and spends coin on exports (and gold). Its dealers
// quote gold around
//   V' = dealerValue · (coin / target)^DESK_COIN_ELASTICITY
// A desk flush with coin (the realm imports more than it exports, or people hoard
// gold) values gold higher: the coin weakens, imports dearer, exports cheaper —
// the balance of payments corrects itself. The target coin rises with the domestic
// deposit rate (interest parity: foreigners hold more coin when it pays more), so
// higher rates firm up the coin. dealerValue itself drifts toward purchasing-power
// parity (domestic prices of tradables ÷ world prices) and toward the traded price.
// ============================================================================
import * as CFG from '../config';
import { isMonthStart } from '../calendar';
import { N_GOODS } from '../goods';
import { addAsk, addBid, bookFor, marketOf, type Books } from '../market/markets';
import { portDuty, portTown } from '../policy/levies';
import { noteBinding, quota } from '../policy/limits';
import { normal } from '../rng';
import { rt } from '../runtime';
import { FOREIGN, GOLD_GOOD } from '../types';
import type { Foreign, GoodId, SimState } from '../types';
import { clamp, ema, fin } from '../util';

const {
  IMPORT_MARKUP,
  EXPORT_DISCOUNT,
  SHIP_CAP_SHARE,
  PIER_CAP_BONUS,
  WORLD_DRIFT_SIGMA,
  DEALER_DEPTH,
  DEALER_PPP_PULL,
  DESK_WORKING_COIN,
  IMPORT_TRANCHES,
  EXPORT_TRANCHES,
  WORLD_REVERT_DAY,
  WORLD_SHOCK_PULL,
  WORLD_PRICE_MIN_MULT,
  WORLD_PRICE_MAX_MULT,
  DESK_COIN_ELASTICITY,
  DESK_COIN_DAYS,
  WORLD_RATE,
  DESK_RATE_SENS,
  DEALER_BANDS,
  DEALER_PRICE_PULL,
  DESK_EXPORT_COIN_SHARE,
  DESK_GOLD_COIN_SHARE,
  GOLD_EMA,
  PPP_EMA,
  SHIP_CAP_FLOOR,
  SHIP_CAP_SMOOTH,
  INIT_GOLD_PRICE,
  PRICE_MIN,
  BASE_WAGE,
} = CFG;

// ---------------------------------------------------------------------------
// Helpers & queries
// ---------------------------------------------------------------------------

function fixArray(a: number[] | undefined, fill = 0): number[] {
  const out = Array.isArray(a) ? a : [];
  for (let g = 0; g < N_GOODS; g++) if (!Number.isFinite(out[g])) out[g] = fill;
  return out;
}

/** Keep the foreign record well-formed (defensive against old or corrupted saves). */
function sanitize(fo: Foreign): void {
  fo.world = fixArray(fo.world);
  fo.world0 = fixArray(fo.world0);
  fo.shipCap = fixArray(fo.shipCap);
  fo.importsQty = fixArray(fo.importsQty);
  fo.exportsQty = fixArray(fo.exportsQty);
  if (!Array.isArray(fo.shocks)) fo.shocks = [];
  if (!(fo.goldPrice > 0) || !Number.isFinite(fo.goldPrice)) fo.goldPrice = INIT_GOLD_PRICE;
  if (!(fo.goldEma > 0) || !Number.isFinite(fo.goldEma)) fo.goldEma = fo.goldPrice;
  if (!(fo.dealerValue > 0) || !Number.isFinite(fo.dealerValue)) fo.dealerValue = fo.goldPrice;
  if (!(fo.ppp > 0) || !Number.isFinite(fo.ppp)) fo.ppp = fo.dealerValue;
  if (!Number.isFinite(fo.coin)) fo.coin = 0;
  if (!Number.isFinite(fo.piers) || fo.piers < 0) fo.piers = 0;
  if (!Number.isFinite(fo.importValue)) fo.importValue = 0;
  if (!Number.isFinite(fo.exportValue)) fo.exportValue = 0;
}

/** E: the reference gold price (¤ per oz) foreign merchants price their goods with. */
export function goldRate(s: SimState): number {
  const e = fin(s.goldMarket.ema);
  if (e > PRICE_MIN) return e;
  const p = fin(s.foreign.goldPrice);
  return p > PRICE_MIN ? p : INIT_GOLD_PRICE;
}

/** Product of the factors of every active world shock on a good (good −1 = every good). */
export function shockMult(s: SimState, g: GoodId): number {
  let m = 1;
  for (const sh of s.foreign.shocks) {
    if (!sh || sh.until < s.day) continue;
    if (sh.good === g || sh.good < 0) m *= sh.factor > 0 && Number.isFinite(sh.factor) ? sh.factor : 1;
  }
  return m;
}

/** World price of a good in coin at today's gold price (0 = not tradable abroad). */
export function worldPriceCoin(s: SimState, g: GoodId): number {
  const w = fin(s.foreign.world[g]);
  return w > 0 ? w * goldRate(s) : 0;
}

/** Price foreign ships ask for a good (net of duties; the first tranche). 0 = not tradable. */
export function importPrice(s: SimState, g: GoodId): number {
  return worldPriceCoin(s, g) * (1 + IMPORT_MARKUP);
}

/** Price foreign ships bid for a good (gross, before port duties; the first tranche). 0 = not tradable. */
export function exportPrice(s: SimState, g: GoodId): number {
  return worldPriceCoin(s, g) * (1 - EXPORT_DISCOUNT);
}

/**
 * The desk's target coin: DESK_COIN_DAYS of potential port trade (ship capacity × world
 * price, one way), at least DESK_WORKING_COIN, scaled up when domestic deposits pay more
 * than the world rate (interest parity: foreigners want to hold more coin).
 */
export function deskTargetCoin(s: SimState): number {
  const fo = s.foreign;
  const E = goldRate(s);
  // Capacity net of piers: building a pier should not by itself move the exchange rate.
  const pierMult = 1 + Math.max(0, fin(fo.piers)) * PIER_CAP_BONUS;
  let pot = 0;
  for (let g = 0; g < N_GOODS; g++) {
    const w = fin(fo.world[g]);
    const c = fin(fo.shipCap[g]);
    if (w > 0 && c > 0) pot += (c / pierMult) * w * E;
  }
  const base = Math.max(DESK_WORKING_COIN, DESK_COIN_DAYS * pot);
  const gap = clamp(fin(s.bank.depositRate) - WORLD_RATE, -0.1, 0.2);
  return base * Math.exp(DESK_RATE_SENS * gap);
}

/** The desk's inventory premium on gold: (coin / target)^DESK_COIN_ELASTICITY (log-ratio clamped to ±2). */
export function deskPremium(s: SimState): number {
  const ratio = Math.max(1e-6, Math.max(0, fin(s.foreign.coin))) / Math.max(1e-6, deskTargetCoin(s));
  return Math.exp(DESK_COIN_ELASTICITY * clamp(Math.log(ratio), -2, 2));
}

/** Centre of the dealers' gold quotes today: dealerValue · (coin / target)^DESK_COIN_ELASTICITY. */
export function dealerCentre(s: SimState): number {
  const v = fin(s.foreign.dealerValue, INIT_GOLD_PRICE) * deskPremium(s);
  return Math.max(PRICE_MIN * 10, v);
}

// ---------------------------------------------------------------------------
// Market phase
// ---------------------------------------------------------------------------

/** Scratch for the export bids of the day (scaled to the desk's coin before posting). */
const _exp: number[] = [];

/**
 * Port (the harbor town's books), for each tradable good with foreign.world[g] > 0:
 *   foreign sell (imports):  ask at limit E·w·(1+IMPORT_MARKUP), qty = shipCap (× import quota),
 *                            import levies as per-order xPct/xUnit (payer: buyer side)
 *   foreign buy  (exports):  bid at limit E·w·(1−EXPORT_DISCOUNT), qty = shipCap (× export quota),
 *                            limited by foreign.coin; export levies as per-order extras
 * where E = s.goldMarket.ema (¤ per oz). Ref = FOREIGN.
 * Each side is posted in tranches (IMPORT_TRANCHES / EXPORT_TRANCHES) so foreign supply and
 * demand slope gently near capacity; export bids commit at most DESK_EXPORT_COIN_SHARE of coin.
 * Gold market (books.gold), ref FOREIGN: dealers quote around
 *   V' = dealerValue · (1 + k·(coin − target)/target)   (target = desk working coin,
 *   raised when the deposit rate is high — interest parity)
 *   (implemented as dealerValue · (coin/target)^DESK_COIN_ELASTICITY, see dealerCentre)
 * selling DEALER_DEPTH oz per 1 % above V' and buying the same per 1 % below V'
 * (buying limited by foreign.coin), over ±10 %.
 */
export function foreignOrders(s: SimState, books: Books): void {
  const fo = s.foreign;
  sanitize(fo);
  const E = goldRate(s);
  const port = portTown(s);
  const hasLimits = s.policy.limits.length > 0;

  if (port >= 0) {
    // ---- exports: size first, then scale to the coin the desk can commit ----
    let expCost = 0;
    _exp.length = 0;
    for (let g = 0; g < N_GOODS; g++) {
      const w = fo.world[g];
      const cap = Math.max(0, fo.shipCap[g]);
      if (!(w > 0) || !(cap > 0)) continue;
      const wp = w * E;
      // imports
      let qi = cap;
      if (hasLimits) {
        const lim = quota(s, 'importMax', g, port, -1);
        if (lim >= 0) qi = Math.min(qi, lim);
      }
      if (qi > 1e-6) {
        const d = portDuty(s, 'import', g);
        const opts = d.pct || d.unit ? { xPct: d.pct, xUnit: d.unit } : undefined;
        const book = bookFor(books, port, g);
        for (const [m, share] of IMPORT_TRANCHES) addAsk(book, FOREIGN, wp * (1 + IMPORT_MARKUP) * m, qi * share, opts);
      }
      // exports (collected; posted below)
      let qe = cap;
      if (hasLimits) {
        const lim = quota(s, 'exportMax', g, port, -1);
        if (lim >= 0) qe = Math.min(qe, lim);
      }
      if (qe > 1e-6) {
        const lim0 = wp * (1 - EXPORT_DISCOUNT);
        for (const [m, share] of EXPORT_TRANCHES) expCost += lim0 * m * qe * share;
        _exp.push(g, qe);
      }
    }
    const budget = Math.max(0, fo.coin) * DESK_EXPORT_COIN_SHARE;
    const k = expCost > 0 ? Math.min(1, budget / expCost) : 0;
    if (k > 0) {
      for (let i = 0; i < _exp.length; i += 2) {
        const g = _exp[i];
        const qe = _exp[i + 1] * k;
        const lim0 = fo.world[g] * E * (1 - EXPORT_DISCOUNT);
        const d = portDuty(s, 'export', g);
        const opts = d.pct || d.unit ? { xPct: d.pct, xUnit: d.unit } : undefined;
        const book = bookFor(books, port, g);
        for (const [m, share] of EXPORT_TRANCHES) addBid(book, FOREIGN, lim0 * m, qe * share, opts);
      }
    }
  }

  // ---- gold dealers ----
  const gb = books.gold ?? bookFor(books, -1, GOLD_GOOD);
  if (!gb) return;
  const V = dealerCentre(s);
  for (let i = 1; i <= DEALER_BANDS; i++) addAsk(gb, FOREIGN, V * (1 + i / 100), DEALER_DEPTH);
  let budget = Math.max(0, fo.coin) * DESK_GOLD_COIN_SHARE;
  let posted = false;
  for (let i = 1; i <= DEALER_BANDS && budget > 1e-6; i++) {
    const p = V * (1 - i / 100);
    const q = Math.min(DEALER_DEPTH, budget / p);
    if (q > 1e-6) {
      addBid(gb, FOREIGN, p, q);
      budget -= q * p;
      posted = true;
    }
  }
  // With no coin at all the desk still shows a (token) bid, so the market keeps an indicative price.
  if (!posted) addBid(gb, FOREIGN, V * 0.99, 1e-3);
}

// ---------------------------------------------------------------------------
// Evening
// ---------------------------------------------------------------------------

/** Purchasing-power parity: geometric mean over tradables of (domestic price ÷ world price in gold). */
function tradablesPPP(s: SimState): number {
  const fo = s.foreign;
  const nT = s.towns.length;
  let sum = 0;
  let n = 0;
  for (let g = 0; g < N_GOODS; g++) {
    const w = fo.world[g];
    if (!(w > 0)) continue;
    let pd = 0;
    let k = 0;
    for (let t = 0; t < nT; t++) {
      const e = fin(marketOf(s, t, g).ema);
      if (e > 0) {
        pd += e;
        k++;
      }
    }
    if (!k) continue;
    const r = pd / k / w;
    if (r > 0 && Number.isFinite(r)) {
      sum += Math.log(r);
      n++;
    }
  }
  return n ? Math.exp(sum / n) : 0;
}

/**
 * Wage-based parity: the founding gold price scaled by the domestic wage level (prices are
 * ultimately labour costs) and deflated by the world price index. Slow-moving, so the
 * exchange rate's own pass-through into import prices does not feed back into it. 0 if no wage data.
 */
function wagePPP(s: SimState): number {
  const fo = s.foreign;
  let wSum = 0;
  let wN = 0;
  for (const t of s.towns) {
    const w = fin(t.avgWage);
    const n = Math.max(0, fin(t.employed));
    if (w > 0 && n > 0) {
      wSum += w * n;
      wN += n;
    }
  }
  if (!(wN > 0)) return 0;
  let lx = 0;
  let k = 0;
  for (let g = 0; g < N_GOODS; g++) {
    if (fo.world0[g] > 0 && fo.world[g] > 0) {
      lx += Math.log(fo.world[g] / fo.world0[g]);
      k++;
    }
  }
  const worldIndex = k ? Math.exp(lx / k) : 1;
  return (INIT_GOLD_PRICE * (wSum / wN / BASE_WAGE)) / Math.max(1e-6, worldIndex);
}

/** Monthly ship capacity from national use; piers take effect at once. */
function updateShipCap(s: SimState): void {
  const fo = s.foreign;
  const bag = rt(s).bag;
  const mult = 1 + fo.piers * PIER_CAP_BONUS;
  const last = bag.foreignPiers as number | undefined;
  if (last !== undefined && last !== fo.piers) {
    const k = mult / Math.max(1e-6, 1 + last * PIER_CAP_BONUS);
    for (let g = 0; g < N_GOODS; g++) fo.shipCap[g] *= k;
  }
  bag.foreignPiers = fo.piers;
  if (!isMonthStart(s.day)) return;
  const nT = s.towns.length;
  for (let g = 0; g < N_GOODS; g++) {
    if (!(fo.world[g] > 0)) continue;
    let use = 0;
    for (let t = 0; t < nT; t++) use += Math.max(0, fin(marketOf(s, t, g).volEma));
    const target = Math.max(SHIP_CAP_FLOOR, use * SHIP_CAP_SHARE) * mult;
    const old = fo.shipCap[g];
    fo.shipCap[g] = old > 0 ? old + SHIP_CAP_SMOOTH * (target - old) : target;
  }
}

/** Credit import/export quotas that actually bound today. */
function noteQuotas(s: SimState, port: number): void {
  if (s.policy.limits.length === 0 || port < 0) return;
  const fo = s.foreign;
  for (let g = 0; g < N_GOODS; g++) {
    if (!(fo.world[g] > 0)) continue;
    const qi = quota(s, 'importMax', g, port, -1);
    if (qi >= 0 && qi < fo.shipCap[g]) {
      const m = marketOf(s, port, g);
      const bound = qi > 0 ? fo.importsQty[g] >= qi * 0.999 : m.price > importPrice(s, g);
      if (bound) noteBinding(s, 'importMax', g, port);
    }
    const qe = quota(s, 'exportMax', g, port, -1);
    if (qe >= 0 && qe < fo.shipCap[g]) {
      const m = marketOf(s, port, g);
      const bound = qe > 0 ? fo.exportsQty[g] >= qe * 0.999 : m.price < exportPrice(s, g);
      if (bound) noteBinding(s, 'exportMax', g, port);
    }
  }
}

/**
 * Evening: world prices drift (log random walk WORLD_DRIFT_SIGMA, mean-reverting to
 * world0, times active shocks); expire shocks; ppp = INIT_GOLD_PRICE × (CPI/100) /
 * (world index); dealerValue += DEALER_PPP_PULL·(ppp − dealerValue) + 0.2·(last gold
 * price − dealerValue)·0.1; goldEma; shipCap from national use × SHIP_CAP_SHARE ×
 * (1 + piers·PIER_CAP_BONUS). stats.acc: imports/exports value.
 * Implementation notes: the price pull uses the traded price divided by the desk's current
 * inventory premium (deskPremium), so only trading away from the dealers' quotes moves their
 * valuation. ppp is the geometric mean of two estimates, smoothed by PPP_EMA: tradables
 * parity (geometric mean over tradable goods of domestic price ÷ world gold price — the gold
 * price at which the realm's tradables cost what they cost abroad) and wage parity
 * (INIT_GOLD_PRICE × average wage / BASE_WAGE ÷ world price index), which moves slowly and
 * keeps the exchange rate's own pass-through into import prices from feeding back on itself.
 * shipCap is recomputed at month start (smoothed), piers apply immediately.
 * stats.acc: imports, exports (¤ at base prices, = foreign.importValue/exportValue),
 * desk_coin, desk_target.
 */
export function foreignEndDay(s: SimState): void {
  const fo = s.foreign;
  sanitize(fo);
  // ---- world prices ----
  for (let g = 0; g < N_GOODS; g++) {
    const w0 = fo.world0[g];
    if (!(w0 > 0)) {
      if (!(fo.world[g] > 0)) fo.world[g] = 0;
      continue;
    }
    const w = fo.world[g] > 0 ? fo.world[g] : w0;
    const m = shockMult(s, g);
    const k = m !== 1 ? WORLD_SHOCK_PULL : WORLD_REVERT_DAY;
    const lw = Math.log(w) + k * (Math.log(w0 * m) - Math.log(w)) + WORLD_DRIFT_SIGMA * normal(s);
    fo.world[g] = clamp(Math.exp(lw), w0 * WORLD_PRICE_MIN_MULT, w0 * WORLD_PRICE_MAX_MULT);
  }
  if (fo.shocks.length) {
    let k = 0;
    for (const sh of fo.shocks) if (sh && sh.until >= s.day) fo.shocks[k++] = sh;
    fo.shocks.length = k;
  }
  // ---- gold, parity, dealers ----
  const price = fin(s.goldMarket.price) > PRICE_MIN ? s.goldMarket.price : goldRate(s);
  fo.goldPrice = price;
  fo.goldEma = ema(fo.goldEma, price, GOLD_EMA);
  const pt = tradablesPPP(s);
  const pw = wagePPP(s);
  const raw = pt > 0 && pw > 0 ? Math.sqrt(pt * pw) : pt > 0 ? pt : pw;
  if (raw > 0) fo.ppp = ema(fo.ppp, raw, PPP_EMA);
  // Dealers learn about fundamentals from where gold trades, net of their own inventory premium
  // (otherwise a lasting coin surplus would compound into an ever-rising "fair value").
  const dv = fo.dealerValue;
  const fundamental = price / Math.max(1e-6, deskPremium(s));
  fo.dealerValue = Math.max(PRICE_MIN * 10, dv + DEALER_PPP_PULL * (fo.ppp - dv) + DEALER_PRICE_PULL * (fundamental - dv));
  // ---- capacity, quotas ----
  updateShipCap(s);
  noteQuotas(s, portTown(s));
  // ---- stats ----
  const acc = s.stats.acc;
  acc.imports = fo.importValue;
  acc.exports = fo.exportValue;
  acc.desk_coin = fo.coin;
  acc.desk_target = deskTargetCoin(s);
}
