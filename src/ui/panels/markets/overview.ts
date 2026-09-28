// ============================================================================
// Markets panel — the overview matrix: goods (rows) × towns (columns) + a
// volume-weighted "Realm" column, then the two national instrument markets
// (IOUs, gold) as full-width rows.
//
// Each cell: price (base, or what buyers pay) · a tiny 90-day sparkline ·
// 30-day change (arrow + sign, gold ▲ / blue ▼ — direction, not judgement) ·
// volume today · a corner badge when demand or supply was rationed away.
// Hover a cell for the full read-out; click it to open that market.
// Values refresh only when a day has passed (or the view mode changes).
// ============================================================================
import { GOODS, N_GOODS } from '../../../sim/goods';
import type { SimState } from '../../../sim/types';
import { h, replace, setText, setTone, toggleClass } from '../../dom';
import { DASH, fmtNum, fmtPct, fmtPrice, fmtQty, pluralize } from '../../format';
import { drawSparkline, goodColor, segmented, T, tipKV, tipNote, tipTitle } from '../../widgets';
import { attachSideTip } from './sidetip';
import {
  badgeOf,
  fin,
  GOLD_GOOD,
  iouYield,
  IOU_GOOD,
  marketAt,
  nationalGood,
  relChange,
  townKindLabel,
  type Badge,
} from './data';

export type PriceMode = 'base' | 'gross';

export interface Overview {
  el: HTMLElement;
  update(s: SimState, force: boolean): void;
  /** Market to outline as the current focus. */
  setFocus(town: number, good: number): void;
}

const SPARK_DAYS = 90;
const CHANGE_DAYS = 30;

interface Cell {
  el: HTMLButtonElement;
  l3: HTMLElement;
  price: HTMLElement;
  change: HTMLElement;
  arrow: HTMLElement;
  chVal: HTMLElement;
  vol: HTMLElement;
  badge: HTMLElement;
  canvas: HTMLCanvasElement;
  town: number; // -1 = realm
  good: number;
  spark: number[];
  sparkSig: string;
  color: string;
}

interface WideRow {
  el: HTMLButtonElement;
  price: HTMLElement;
  sub: HTMLElement;
  arrow: HTMLElement;
  chVal: HTMLElement;
  change: HTMLElement;
  vol: HTMLElement;
  extra: HTMLElement;
  canvas: HTMLCanvasElement;
  good: number;
  spark: number[];
  sparkSig: string;
  color: string;
}

/** "▲ 3.1%" pieces for a relative change. */
export function changeParts(rel: number, compact = false): { arrow: string; text: string; tone: 'mk-up' | 'mk-dn' | null } {
  if (!Number.isFinite(rel)) return { arrow: '', text: DASH, tone: null };
  const a = Math.abs(rel);
  if (a < 0.0005) return { arrow: '→', text: compact ? '0%' : '0.0%', tone: null };
  const text = compact ? (a >= 0.0095 ? Math.round(a * 100) + '%' : (a * 100).toFixed(1) + '%') : fmtPct(a);
  return { arrow: rel > 0 ? '▲' : '▼', text, tone: rel > 0 ? 'mk-up' : 'mk-dn' };
}

/** Compact cell price: "¤3.47", "¤28.4", "¤166", "¤1.2k". */
export function fmtCellPrice(v: number): string {
  if (!(Number.isFinite(v) && v > 0)) return DASH;
  if (v < 0.1) return '¤' + Number(v.toPrecision(2));
  if (v < 10) return '¤' + v.toFixed(2);
  if (v < 100) return '¤' + v.toFixed(1);
  if (v < 1000) return '¤' + Math.round(v);
  if (v < 1e5) return '¤' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return fmtPrice(v);
}

/** Compact daily volume: "8.7", "178", "1.2k". */
export function fmtVol(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a < 0.05) return '0';
  if (a < 10) return a.toFixed(1);
  if (a < 1000) return String(Math.round(a));
  if (a < 1e5) return (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(a / 1000) + 'k';
}

export function createOverview(onPick: (town: number, good: number) => void): Overview {
  let mode: PriceMode = 'base';
  let lastSig = '';
  let lastS: SimState | null = null;
  let townSig = '';
  let focus = { town: -2, good: -2 };
  let cells: Cell[] = [];
  let wide: WideRow[] = [];
  let state: SimState | null = null;

  const modeCtl = segmented<PriceMode>({
    options: [
      { value: 'base', label: 'Base price', title: 'The price the auction cleared at, before any levy' },
      { value: 'gross', label: 'Buyers pay', title: 'What buyers paid per unit, levies included' },
    ],
    value: mode,
    size: 'sm',
    onChange: (v) => {
      mode = v;
      lastSig = '';
      if (state) update(state, true);
    },
  });
  const grid = h('div', { class: 'mk-grid', role: 'grid', 'aria-label': 'Prices in every market' });
  const legend = h(
    'div',
    { class: 'mk-legend' },
    h('span', { class: 'mk-lg' }, h('span', { class: 'mk-up' }, '▲'), h('span', { class: 'mk-dn' }, '▼'), ' 30-day change'),
    h('span', { class: 'mk-lg' }, h('span', { class: 'mk-lg-vol' }, '178'), ' traded today'),
    h('span', { class: 'mk-lg' }, h('span', { class: 'mk-lg-cell' }, h('span', { class: 'mk-badge mk-badge-shortage' })), ' buyers went short'),
    h('span', { class: 'mk-lg' }, h('span', { class: 'mk-lg-cell' }, h('span', { class: 'mk-badge mk-badge-surplus' })), ' left unsold'),
    h('span', { class: 'mk-lg mk-lg-dim' }, h('span', { class: 'mk-lg-idle' }, '¤4.20'), ' no trade today'),
  );
  const el = h(
    'div',
    { class: 'mk-ov' },
    h('div', { class: 'mk-toolbar' }, modeCtl.el, h('div', { class: 'mk-toolbar-note' }, 'Click any cell to open that market')),
    grid,
    legend,
  );

  const ro = new ResizeObserver(() => drawAllSparks(true));
  ro.observe(grid);

  // ---- build ------------------------------------------------------------------
  function build(s: SimState): void {
    const nT = s.towns.length;
    grid.style.setProperty('--mk-cols', String(nT + 1));
    cells = [];
    wide = [];
    const head = h(
      'div',
      { class: 'mk-row mk-hrow', role: 'row' },
      h('div', { class: 'mk-corner' }, h('span', { class: 'mk-corner-lab' }, 'Good'), h('span', { class: 'mk-corner-sub' }, 'town')),
      s.towns.map((t) =>
        h(
          'div',
          { class: 'mk-colhead', title: `${t.name} — ${t.kind === 'harbor' ? 'harbour town with the port' : t.kind === 'capital' ? 'the capital' : t.kind + ' town'}`, role: 'columnheader' },
          h('span', { class: 'mk-colhead-name' }, t.name),
          h('span', { class: 'mk-colhead-kind' }, townKindLabel(t.kind, t.hasPort)),
        ),
      ),
      h('div', { class: 'mk-colhead mk-colhead-realm', title: 'Realm: prices weighted by how much each town trades; quantities summed', role: 'columnheader' }, h('span', { class: 'mk-colhead-name' }, 'Realm'), h('span', { class: 'mk-colhead-kind' }, 'avg')),
    );
    const rows: HTMLElement[] = [head];
    for (let g = 0; g < N_GOODS; g++) {
      const def = GOODS[g];
      const color = goodColor(g);
      const lab = h(
        'div',
        { class: 'mk-lab', role: 'rowheader' },
        h('span', { class: 'mk-bar', style: { background: color } }),
        h('span', { class: 'mk-lab-text' }, h('span', { class: 'mk-lab-name' }, def.name), h('span', { class: 'mk-lab-unit' }, 'per ' + def.unit)),
      );
      const rowCells: HTMLElement[] = [];
      // towns first, the realm column last
      for (let t = 0; t <= nT; t++) {
        const town = t < nT ? t : -1;
        const c = makeCell(town, g, color);
        cells.push(c);
        rowCells.push(c.el);
      }
      rows.push(h('div', { class: 'mk-row', role: 'row' }, lab, rowCells));
    }
    rows.push(h('div', { class: 'mk-sep' }, h('span', null, 'National markets'), h('span', { class: 'mk-sep-note' }, 'one auction for the whole realm')));
    for (const g of [IOU_GOOD, GOLD_GOOD]) {
      const w = makeWide(g);
      wide.push(w);
      const color = g === IOU_GOOD ? '#b9c4d0' : T.goldHi;
      rows.push(
        h(
          'div',
          { class: 'mk-row mk-row-wide', role: 'row' },
          h(
            'div',
            { class: 'mk-lab', role: 'rowheader' },
            h('span', { class: 'mk-bar', style: { background: color } }),
            h('span', { class: 'mk-lab-text' }, h('span', { class: 'mk-lab-name' }, g === IOU_GOOD ? 'IOUs' : 'Gold'), h('span', { class: 'mk-lab-unit' }, g === IOU_GOOD ? 'per IOU' : 'per ounce')),
          ),
          w.el,
        ),
      );
    }
    replace(grid, rows);
  }

  function makeCell(town: number, good: number, color: string): Cell {
    const price = h('span', { class: 'mk-price' });
    const arrow = h('span', { class: 'mk-arrow' });
    const chVal = h('span', { class: 'mk-chval' });
    const change = h('span', { class: 'mk-change' }, arrow, chVal);
    const vol = h('span', { class: 'mk-vol' });
    const badge = h('span', { class: 'mk-badge' });
    const canvas = h('canvas', { class: 'mk-spark', 'aria-hidden': 'true' });
    const l3 = h('span', { class: 'mk-l3' }, change, vol);
    const el = h(
      'button',
      {
        class: 'mk-cell' + (town < 0 ? ' mk-cell-realm' : ''),
        type: 'button',
        role: 'gridcell',
        onClick: () => onPick(town, good),
      },
      h('span', { class: 'mk-l1' }, price),
      canvas,
      l3,
      badge,
    );
    const c: Cell = { el, l3, price, change, arrow, chVal, vol, badge, canvas, town, good, spark: [], sparkSig: '', color };
    attachSideTip(el, () => cellTip(c));
    return c;
  }

  function makeWide(good: number): WideRow {
    const price = h('span', { class: 'mk-wide-price' });
    const sub = h('span', { class: 'mk-wide-sub' });
    const arrow = h('span', { class: 'mk-arrow' });
    const chVal = h('span', { class: 'mk-chval' });
    const change = h('span', { class: 'mk-change' }, arrow, chVal);
    const vol = h('span', { class: 'mk-vol' });
    const extra = h('span', { class: 'mk-wide-extra' });
    const canvas = h('canvas', { class: 'mk-spark mk-spark-wide', 'aria-hidden': 'true' });
    const el = h(
      'button',
      { class: 'mk-wide', type: 'button', role: 'gridcell', onClick: () => onPick(-1, good) },
      h('span', { class: 'mk-wide-main' }, h('span', { class: 'mk-wide-top' }, price, sub), extra),
      canvas,
      h('span', { class: 'mk-wide-side' }, change, vol),
    );
    const w: WideRow = { el, price, sub, arrow, chVal, change, vol, extra, canvas, good, spark: [], sparkSig: '', color: good === IOU_GOOD ? '#b9c4d0' : T.goldHi };
    attachSideTip(el, () => wideTip(w));
    return w;
  }

  // ---- tooltips (built on open, from live state) ------------------------------------
  function cellTip(c: Cell): HTMLElement[] | null {
    const s = state;
    if (!s) return null;
    const def = GOODS[c.good];
    const u = def?.unit ?? 'unit';
    const us = pluralize(u);
    const where = c.town >= 0 ? s.towns[c.town]?.name ?? '' : 'the whole realm';
    const out: HTMLElement[] = [tipTitle(`${def?.name ?? 'Goods'} · ${where}`, c.town < 0 ? 'volume-weighted' : undefined)];
    let price: number, gross: number, net: number, vol: number, sh: number, su: number, hist: ArrayLike<number>, traded: boolean;
    let bid = NaN;
    let ask = NaN;
    if (c.town < 0) {
      const n = nationalGood(s, c.good);
      ({ price, gross, net, volume: vol, shortage: sh, surplus: su, hist, traded } = n);
    } else {
      const m = marketAt(s, c.town, c.good);
      if (!m) return null;
      price = m.price;
      gross = m.gross;
      net = m.net;
      vol = m.volume;
      sh = m.shortage;
      su = m.surplus;
      hist = m.hist;
      traded = m.traded;
      bid = m.bestBid;
      ask = m.bestAsk;
    }
    out.push(tipKV(traded ? 'Base price' : 'Indicative price', fmtPrice(price)));
    if (Math.abs(fin(gross) - fin(price)) > 1e-6) out.push(tipKV('Buyers pay', fmtPrice(gross)));
    if (Math.abs(fin(net) - fin(price)) > 1e-6) out.push(tipKV('Sellers get', fmtPrice(net)));
    const ch = relChange(hist, CHANGE_DAYS);
    out.push(tipKV('30-day change', Number.isFinite(ch) ? (ch >= 0 ? '+' : '−') + fmtPct(Math.abs(ch)) : DASH));
    out.push(tipKV('Traded today', `${fmtQty(vol)} ${fin(vol) === 1 ? u : us}`));
    if (fin(sh) > 0.05) out.push(tipKV('Demand unmet', `${fmtQty(sh)} ${us}`, 'warn'));
    if (fin(su) > 0.05) out.push(tipKV('Left unsold', `${fmtQty(su)} ${us}`));
    if (c.town >= 0) {
      if (fin(bid) > 0) out.push(tipKV('Best bid', fmtPrice(bid)));
      if (fin(ask) > 0) out.push(tipKV('Best ask', fmtPrice(ask)));
    }
    if (!traded) out.push(tipNote('Nothing changed hands today: bids and asks did not meet. The price shown is the midpoint of the best bid and ask.'));
    out.push(tipNote('Click to open this market.'));
    return out;
  }

  function wideTip(w: WideRow): HTMLElement[] | null {
    const s = state;
    if (!s) return null;
    const m = marketAt(s, -1, w.good);
    if (!m) return null;
    const out: HTMLElement[] = [tipTitle(w.good === IOU_GOOD ? 'IOU market' : 'Gold market', 'national')];
    out.push(tipKV('Price', fmtPrice(m.price) + (w.good === GOLD_GOOD ? ' /oz' : '')));
    if (w.good === IOU_GOOD) {
      out.push(tipKV('Yield', fmtPct(iouYield(m.price), 2)));
      out.push(tipKV('Outstanding', fmtNum(s.treasury?.iouOutstanding) + ' IOUs'));
      out.push(tipNote('Each IOU pays ¤5 a year to its holder, forever. The lower the price, the higher the yield a buyer earns.'));
    } else {
      out.push(tipKV('Treasury holds', fmtNum(s.treasury?.gold) + ' oz'));
      out.push(tipNote('Foreign ships are paid in gold, so the gold price is also the rate at which ¤ converts into world prices.'));
    }
    out.push(tipKV('Traded today', fmtQty(m.volume)));
    out.push(tipNote('Click to open this market.'));
    return out;
  }

  // ---- update -----------------------------------------------------------------------
  function update(s: SimState, force: boolean): void {
    state = s;
    const tsig = s.towns.map((t) => t.name + t.kind).join('|');
    if (tsig !== townSig || lastS !== s || !cells.length) {
      townSig = tsig;
      build(s);
      lastSig = '';
      paintFocus();
    }
    const sig = `${s.day}|${mode}`;
    if (!force && sig === lastSig && lastS === s) return;
    lastSig = sig;
    lastS = s;
    const nat = new Map<number, ReturnType<typeof nationalGood>>();
    for (const c of cells) {
      let price: number;
      let traded: boolean;
      let vol: number;
      let badge: Badge;
      let hist: ArrayLike<number>;
      if (c.town < 0) {
        let n = nat.get(c.good);
        if (!n) nat.set(c.good, (n = nationalGood(s, c.good)));
        price = mode === 'gross' ? n.gross : n.price;
        traded = n.traded;
        vol = n.volume;
        badge = badgeOf(n.volume, n.shortage, n.surplus);
        hist = n.hist;
      } else {
        const m = marketAt(s, c.town, c.good);
        price = m ? (mode === 'gross' ? fin(m.gross, m.price) : m.price) : NaN;
        traded = !!m?.traded;
        vol = fin(m?.volume);
        badge = m ? badgeOf(m.volume, m.shortage, m.surplus) : null;
        hist = m?.hist ?? [];
      }
      setText(c.price, fmtCellPrice(price));
      toggleClass(c.el, 'idle', !traded);
      const ch = changeParts(relChange(hist, CHANGE_DAYS), true);
      setText(c.arrow, ch.arrow);
      setText(c.chVal, ch.text);
      setTone(c.change, ['mk-up', 'mk-dn'], ch.tone);
      setText(c.vol, traded ? fmtVol(vol) : DASH);
      setTone(c.badge, ['mk-badge-shortage', 'mk-badge-surplus'], badge ? 'mk-badge-' + badge : null);
      const n = hist.length;
      const a = Math.max(0, n - SPARK_DAYS);
      c.spark = Array.prototype.slice.call(hist, a) as number[];
    }
    for (const w of wide) {
      const m = marketAt(s, -1, w.good);
      const price = fin(m?.price, NaN);
      setText(w.price, price > 0 ? fmtPrice(price) : DASH);
      if (w.good === IOU_GOOD) {
        setText(w.sub, 'yields ' + fmtPct(iouYield(price), 2));
        const out = fin(s.treasury?.iouOutstanding);
        setText(w.extra, out > 0 ? `${fmtNum(out)} outstanding` : 'none issued yet');
      } else {
        setText(w.sub, 'per oz');
        setText(w.extra, `Treasury holds ${fmtNum(s.treasury?.gold)} oz`);
      }
      toggleClass(w.el, 'idle', !m?.traded);
      const ch = changeParts(relChange(m?.hist, CHANGE_DAYS));
      setText(w.arrow, ch.arrow);
      setText(w.chVal, ch.text);
      setTone(w.change, ['mk-up', 'mk-dn'], ch.tone);
      setText(w.vol, m?.traded ? fmtVol(m.volume) + ' traded' : 'no trade');
      const hist = m?.hist ?? [];
      w.spark = hist.slice(Math.max(0, hist.length - SPARK_DAYS));
    }
    // volume gives way when the change needs the room (never show a clipped number)
    for (const c of cells) c.vol.style.visibility = '';
    for (const c of cells) {
      const room = c.l3.clientWidth;
      if (room > 0 && c.change.offsetWidth + c.vol.offsetWidth + 3 > room) c.vol.style.visibility = 'hidden';
    }
    drawAllSparks(false);
  }

  // ---- sparklines (one small canvas per cell, drawn only when data or size changes) --
  function drawSpark(cv: HTMLCanvasElement, data: number[], color: string, sigIn: string, force: boolean): string {
    const w = cv.clientWidth;
    const hh = cv.clientHeight;
    if (w <= 0 || hh <= 0) return '';
    const n = data.length;
    const sig = `${w}x${hh}|${n}|${n ? data[n - 1] : ''}|${n ? data[0] : ''}|${color}`;
    if (!force && sig === sigIn) return sig;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.round(w * dpr);
    const H = Math.round(hh * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return sig;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSparkline(ctx, data, 0, 0, w, hh, { color, dot: false, area: true });
    return sig;
  }

  function drawAllSparks(force: boolean): void {
    for (const c of cells) c.sparkSig = drawSpark(c.canvas, c.spark, c.color, c.sparkSig, force);
    for (const w of wide) w.sparkSig = drawSpark(w.canvas, w.spark, w.color, w.sparkSig, force);
  }

  function paintFocus(): void {
    for (const c of cells) toggleClass(c.el, 'focus', c.town === focus.town && c.good === focus.good);
    for (const w of wide) toggleClass(w.el, 'focus', w.good === focus.good);
  }

  return {
    el,
    update,
    setFocus(town, good) {
      if (town === focus.town && good === focus.good) return;
      focus = { town, good };
      paintFocus();
    },
  };
}
