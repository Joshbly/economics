// ============================================================================
// DEV ONLY: widget gallery. Built by scripts/gallery.mjs into dist/gallery.html.
// Shows every widget with synthetic data so the design system can be reviewed
// (and screenshotted) without a running simulation.
// ============================================================================
import '../styles.css';
import type { Game } from '../../sim/game';
import { GOODS, G } from '../../sim/goods';
import { h, type Child } from '../dom';
import { fmtDay, fmtIndex, fmtInt, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, fmtPctSigned, fmtPrice, fmtPts } from '../format';
import { confirmDialog, initToasts, openModal } from '../modal';
import { initUi, toast } from '../uiState';
import { barChart } from '../widgets/barchart';
import { button, field, goodOptions, numberInput, segmented, selectInput, slider, swatch, textInput, toggle, townOptions } from '../widgets/controls';
import { curveChart } from '../widgets/curvechart';
import { histogram } from '../widgets/histogram';
import { icon } from '../widgets/icons';
import { kpi, kpiGrid, trend } from '../widgets/kpi';
import { lineChart } from '../widgets/linechart';
import { sparkline } from '../widgets/sparkline';
import { table } from '../widgets/table';
import { goodColor, SERIES, T } from '../widgets/theme';
import { attachTip, tipKV, tipNote, tipTitle } from '../widgets/tooltip';
import { fakeCurve, fakeState, lcg, noise, walk } from './fake';

const s = fakeState();
initUi({ s, dispatch: () => ({ ok: true, message: 'Done.' }), save: () => JSON.stringify({}) } as unknown as Game);
initToasts();

const style = h(
  'style',
  null,
  `
  html, body { overflow: visible; height: auto; }
  .gal { max-width: 1320px; margin: 0 auto; padding: 28px 28px 80px; }
  .gal-head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 22px; }
  .gal-title { font: 600 26px/1.1 var(--serif); }
  .gal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 14px; align-items: start; }
  .gal-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gal-sec { margin: 30px 0 12px; }
  .gal-note { color: var(--ink-3); font-size: 11.5px; margin-top: 6px; }
  .tok { display: flex; flex-direction: column; gap: 4px; width: 92px; font-size: 10.5px; color: var(--ink-2); }
  .tok i { height: 34px; border-radius: 6px; border: 1px solid var(--line-2); }
  .sidebar-sim { width: 430px; background: var(--bg-1); border: 1px solid var(--line-2); border-radius: 12px; padding: 14px 16px; }
`,
);
document.head.appendChild(style);

const root = h('div', { class: 'gal' });
document.getElementById('app')!.replaceWith(root);

function sec(title: string, sub?: string): void {
  root.appendChild(h('div', { class: 'gal-sec' }, h('div', { class: 'section-title' }, title), sub ? h('div', { class: 'gal-note', style: 'margin-top:-2px' }, sub) : null));
}
function card(title: string, sub: string | null, ...body: Child[]): HTMLElement {
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title), sub ? h('div', { class: 'card-sub' }, sub) : null), ...body);
}
function grid(cls = '', ...cards: HTMLElement[]): HTMLElement {
  const g = h('div', { class: 'gal-grid ' + cls }, ...cards);
  root.appendChild(g);
  return g;
}

root.appendChild(
  h(
    'div',
    { class: 'gal-head' },
    h('div', { class: 'tb-crest' }, icon('crown', 17)),
    h('div', { class: 'gal-title' }, 'Realm Ledger · widget gallery'),
    h('span', { class: 'muted' }, 'Synthetic data · ', fmtDay(s.day)),
  ),
);

// ---- tokens ---------------------------------------------------------------
sec('Tokens', 'Surfaces, ink, accent, status, and the 8 categorical series colours (fixed order).');
const tok = (name: string, color: string) => h('div', { class: 'tok' }, h('i', { style: { background: color } }), name, h('span', { class: 'faint mono' }, color));
root.appendChild(
  h(
    'div',
    { class: 'row wrap', style: 'gap:10px' },
    tok('bg-0', T.bg0),
    tok('bg-1', T.bg1),
    tok('bg-2', T.bg2),
    tok('bg-3', T.bg3),
    tok('ink-0', T.ink0),
    tok('ink-2', T.ink2),
    tok('gold', T.gold),
    tok('good', T.good),
    tok('bad', T.bad),
    tok('warn', T.warn),
    ...SERIES.map((c, i) => tok('series ' + (i + 1), c)),
  ),
);

// ---- KPIs -------------------------------------------------------------------
sec('Stat tiles', 'Value · signed delta with arrow (coloured by whether the direction is good) · sparkline · hover for the explanation.');
const D = s.stats.daily;
const k1 = kpi({ label: 'Prices (index)', format: fmtIndex, good: null, spark: true, hint: 'Cost of the household basket; 100 when you took charge.' });
const k2 = kpi({ label: 'Jobless', format: (v) => fmtPct(v), good: 'down', spark: true, deltaFormat: fmtPts, hint: 'Share of households without a job.' });
const k3 = kpi({ label: 'Output', format: fmtMoneyShort, unit: '/day', good: 'up', spark: true });
const k4 = kpi({ label: 'Purse', format: fmtMoney, good: null, spark: true });
const k5 = kpi({ label: 'Hunger', format: (v) => fmtPct(v), good: 'down', size: 'sm' });
const k6 = kpi({ label: 'Gold', format: fmtPrice, size: 'sm', good: null });
const k7 = kpi({ label: 'Population', format: fmtInt, size: 'sm', good: 'up' });
const k8 = kpi({ label: 'Loan rate', format: (v) => fmtPct(v, 1), size: 'sm', good: null });
const tr = (k: string) => trend(D[k], 30);
k1.set(tr('cpi').now, { delta: tr('cpi').rel, deltaLabel: 'in 30 days', spark: D.cpi.slice(-180) });
k2.set(tr('unemp').now, { delta: tr('unemp').delta, deltaLabel: 'in 30 days', spark: D.unemp.slice(-180) });
k3.set(tr('gdpReal').now, { delta: tr('gdpReal').rel, deltaLabel: 'in 30 days', spark: D.gdpReal.slice(-180) });
k4.set(-1240.5, { delta: -3200, deltaFormat: (d) => fmtMoneyShort(d), deltaLabel: 'this month', spark: D.purse.slice(-180), tone: 'bad', sub: 'Overdrawn: auto-mint is on' });
k5.set(0.043, { delta: 0.012, deltaFormat: fmtPts });
k6.set(104.2, { delta: 0.021 });
k7.set(642, { delta: 5, deltaFormat: (d) => fmtNum(d) });
k8.set(0.0725, { delta: 0.004, deltaFormat: fmtPts, deltaLabel: 'since last month' });
root.appendChild(kpiGrid([k1, k2, k3, k4], 4));
root.appendChild(h('div', { style: 'height:8px' }));
root.appendChild(kpiGrid([k5, k6, k7, k8], 4));

// ---- line charts ---------------------------------------------------------------
sec('Line charts', 'Calendar x axis, nice ticks, hover crosshair with every series, click the legend to hide (shift-click to solo).');
const x0 = s.stats.dailyStart;
const c1 = lineChart({ height: 190, format: fmtIndex, refLines: [{ y: 100, label: 'when you took charge' }], markers: [{ x: x0 + 300, label: 'Levy on bread' }] });
const wageIdx = D.wage.map((v) => (v / D.wage[0]) * 100);
const breadIdx = walk(D.cpi.length, 100, { vol: 0.009, seed: 33, drift: 0.0002 });
c1.set(
  [
    { label: 'Prices', data: D.cpi },
    { label: 'Wages', data: wageIdx },
    { label: 'Bread', data: breadIdx, color: SERIES[3], dashed: true },
  ],
  { x0 },
);
const c2 = lineChart({ height: 190, format: fmtMoneyShort, zero: true });
c2.set(
  [
    { label: 'Money', data: D.money, area: true },
    { label: 'Bank loans', data: D.credit, area: true },
    { label: 'Reserves', data: D.reserves },
  ],
  { x0 },
);
const c3 = lineChart({ height: 190, format: fmtIndex, rightFormat: (v) => fmtPct(v), rightTickFormat: (v) => fmtPct(v, 0) });
c3.set(
  [
    { label: 'Prices', data: D.cpi },
    { label: 'Jobless', data: D.unemp, axis: 'right' },
  ],
  { x0 },
);
const goldGaps = D.goldPrice.map((v, i) => (i > 200 && i < 230 ? NaN : v * (1 + i / 180)));
const c4 = lineChart({ height: 190, log: true, format: fmtPrice, tickFormat: (v) => '¤' + fmtNum(v) });
c4.set([{ label: 'Gold price (log scale, with a gap)', data: goldGaps, color: SERIES[3] }], { x0 });
const big = walk(4000, 50, { vol: 0.02, seed: 44, season: 0.1 });
const big2 = walk(4000, 45, { vol: 0.015, seed: 45, season: 0.05 });
const c5 = lineChart({ height: 190, format: (v) => fmtNum(v) });
const t0 = performance.now();
c5.set(
  [
    { label: 'Series A', data: big },
    { label: 'Series B', data: big2 },
  ],
  { x0: 0 },
);
const monthly = walk(40, 5000, { drift: 0.004, vol: 0.03, seed: 50 });
const c6 = lineChart({ height: 190, format: fmtMoneyShort, xStep: 30, zero: true });
c6.set([{ label: 'Output per month', data: monthly, area: true, color: SERIES[2] }], { x0: 0 });
const c7 = lineChart({ height: 150, empty: 'No history yet — let a few days pass' });
c7.set([{ label: 'Nothing', data: [] }]);
grid(
  '',
  card('Prices, wages and bread', 'index, 100 = start · reference line · event marker', c1.el),
  card('Money and credit', 'area fills to zero', c2.el),
  card('Right axis', 'prefer indexing to a common base; use sparingly', c3.el),
  card('Log scale & gaps', 'NaN values break the line', c4.el),
  card('4 000 points', 'min/max decimation per pixel column', c5.el, h('div', { class: 'gal-note' }, `first set() + draw scheduled in ${(performance.now() - t0).toFixed(1)} ms`)),
  card('Monthly series', 'xStep = 30', c6.el),
  card('Empty state', null, c7.el),
);

// ---- curve charts -------------------------------------------------------------------
sec('Supply & demand', 'From a CurveSnapshot: step curves, clearing point, the levy wedge (buyer gross vs seller net), limits and Treasury orders. Hover for the price read-out.');
const cc1 = curveChart({ unit: 'loaf' });
cc1.set(fakeCurve(4));
const cc2 = curveChart({ unit: 'loaf' });
cc2.set(fakeCurve(4, { wedge: { bPct: 0.3, bUnit: 0, sPct: 0, sUnit: 0 }, state: [0, 3.2, 90] }));
const cc3 = curveChart({ unit: 'loaf' });
cc3.set(fakeCurve(4, { ceiling: 3.1 }));
const cc4 = curveChart({ unit: 'set' });
cc4.set(fakeCurve(20, { floor: 23, wedge: { bPct: 0, bUnit: 0, sPct: -0.15, sUnit: 0 }, state: [1, 26, 60], depth: 120 }));
const cc5 = curveChart({ unit: 'cask' });
const noTrade = fakeCurve(3);
noTrade.bids = noTrade.bids.map((v, i) => (i % 2 === 0 ? v * 0.22 : v));
noTrade.volume = 0;
noTrade.price = (noTrade.bids[0] + noTrade.asks[0]) / 2;
cc5.set(noTrade);
const cc6 = curveChart({ unit: 'barrel' });
cc6.set(null);
grid(
  '',
  card('Bread · Kingsbridge', 'no levies', cc1.el),
  card('Bread · Millbrook', '30 % levy on buyers · Treasury bid', cc2.el),
  card('Bread under a price ceiling', 'shortage measured off the curves', cc3.el),
  card('Tools with a floor', 'Treasury pays sellers 15 % · Treasury sell order', cc4.el),
  card('Ale · no trade', 'bids and asks do not cross', cc5.el),
  card('Empty market', null, cc6.el),
);

// ---- bars & histograms -----------------------------------------------------------------
sec('Bars & distributions');
const b1 = barChart({ format: (v) => fmtMoney(v) + '/day', onClick: (r) => toast(`Clicked ${r.label}`, 'info') });
b1.set(s.towns.map((t, i) => ({ key: t.id, label: t.name, sub: t.kind, value: [10.4, 9.1, 11.8, 9.7][i], hint: 'Employment-weighted posted wage.' })));
const b2 = barChart({ format: (v) => (v >= 0 ? '+' : '') + fmtMoneyShort(v) });
b2.set([
  { label: 'Bread sales', value: 412 },
  { label: 'Wages (employer)', value: 260 },
  { label: 'Interest on reserves', value: -95 },
  { label: 'Treasury workers', value: -540 },
  { label: 'Per-head payments', value: -310 },
  { label: 'Imports', value: 88 },
]);
const b3 = barChart({ format: fmtNum, rowHeight: 22 });
b3.set(GOODS.map((g) => ({ label: g.name, value: 40 + ((g.id * 37) % 90), color: goodColor(g.id) })));
const r = lcg(9);
const wealth = Array.from({ length: 640 }, () => Math.exp(Math.log(300) + 1.1 * noise(r) * 1.6));
for (let i = 0; i < 30; i++) wealth.push(0);
const sorted = [...wealth].sort((a, b) => a - b);
const h1 = histogram({ bins: 26, log: true, format: fmtMoneyShort, unit: 'households', markers: [{ x: sorted[sorted.length >> 1], label: 'median' }] });
h1.set(wealth);
const health = Array.from({ length: 640 }, () => Math.max(0, Math.min(1, 0.85 + 0.12 * noise(r) * 1.6)));
const h2 = histogram({ bins: 20, format: (v) => fmtPct(v, 0), unit: 'households', min: 0, max: 1, color: SERIES[2], markers: [{ x: 0.6, label: 'frail', color: T.warn }] });
h2.set(health);
grid('', card('Wages by town', 'click a bar', b1.el), card('Treasury flows today', 'diverging from zero', b2.el), card('Goods traded', 'colour = the good’s own colour', b3.el), card('Household wealth', 'log bins · the ≤ 0 bin is separate', h1.el), card('Health', 'linear bins', h2.el));

// ---- sparklines --------------------------------------------------------------------------
sec('Sparklines');
const sparks = h('div', { class: 'row wrap', style: 'gap:18px' });
for (const [k, lab, col] of [
  ['cpi', 'Prices', T.ink1],
  ['unemp', 'Jobless', T.bad],
  ['gdpReal', 'Output', T.good],
  ['money', 'Money', T.gold],
  ['goldPrice', 'Gold', SERIES[3]],
] as const) {
  const sp = sparkline({ width: 120, height: 28, color: col });
  sp.set(D[k].slice(-360));
  sparks.appendChild(h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'caps' }, lab), sp.el));
}
root.appendChild(h('div', { class: 'card' }, sparks));

// ---- table ----------------------------------------------------------------------------------
sec('Table', 'Sortable (click headers), pooled rows, virtualised beyond 120 rows — 600 households here.');
interface Row {
  id: number;
  name: string;
  town: string;
  job: string;
  wage: number;
  cash: number;
  health: number;
}
const first = ['Ada', 'Bran', 'Cora', 'Dunstan', 'Edda', 'Fenn', 'Gwen', 'Hale', 'Ines', 'Jory', 'Kit', 'Lark', 'Mabel', 'Nye'];
const last = ['Cooper', 'Miller', 'Fletcher', 'Thatcher', 'Baker', 'Mason', 'Weaver', 'Smith', 'Tanner', 'Wright'];
const jobs = ['baker', 'miner', 'farmhand', 'carter', 'smith', '—', 'brewer', 'fisher'];
const rows: Row[] = Array.from({ length: 600 }, (_, i) => ({
  id: i,
  name: `${first[(i * 7) % first.length]} ${last[(i * 3) % last.length]}`,
  town: s.towns[i % 4].name,
  job: jobs[(i * 5) % jobs.length],
  wage: jobs[(i * 5) % jobs.length] === '—' ? 0 : 8 + ((i * 13) % 50) / 10,
  cash: wealth[i % wealth.length],
  health: health[i % health.length],
}));
const tbl = table<Row>({
  columns: [
    { key: 'name', label: 'Household', value: (x) => x.name, align: 'left', width: '32%' },
    { key: 'town', label: 'Town', value: (x) => x.town, align: 'left' },
    { key: 'job', label: 'Job', value: (x) => x.job, align: 'left' },
    { key: 'wage', label: 'Wage', value: (x) => x.wage, format: (v: number) => (v ? fmtMoney(v) : '—') },
    { key: 'cash', label: 'Cash', value: (x) => x.cash, format: (v: number) => fmtMoney(v) },
    { key: 'health', label: 'Health', value: (x) => x.health, format: (v: number) => fmtPct(v, 0), tone: (x) => (x.health < 0.6 ? 'bad' : null) },
  ],
  rowKey: (x) => x.id,
  onRowClick: (x) => {
    tbl.setSelected(x.id);
    toast(`Selected ${x.name}`, 'info');
  },
  maxHeight: 300,
  sort: { key: 'cash', dir: -1 },
});
tbl.set(rows);
const small = table<{ g: number }>({
  columns: [
    { key: 'good', label: 'Good', value: (x) => GOODS[x.g].name, align: 'left', format: (_v: string, x) => h('span', { class: 'row', style: 'gap:7px' }, swatch(goodColor(x.g)), GOODS[x.g].name) },
    { key: 'price', label: 'Price', value: (x) => 2 + x.g * 1.7, format: (v: number) => fmtPrice(v) },
    { key: 'chg', label: '30d', value: (x) => ((x.g * 7) % 11) / 100 - 0.04, format: (v: number) => fmtPctSigned(v), tone: (x) => (((x.g * 7) % 11) / 100 - 0.04 > 0.03 ? 'bad' : null) },
    { key: 'vol', label: 'Volume', value: (x) => 50 + ((x.g * 31) % 200), format: (v: number) => fmtInt(v) },
  ],
  rowKey: (x) => x.g,
  dense: true,
});
small.set(GOODS.map((g) => ({ g: g.id })));
grid('two', card('Households', 'click a row', tbl.el), card('Market board', 'dense rows · node cells', small.el));

// ---- controls ---------------------------------------------------------------------------------
sec('Controls', 'Native select (macOS popup), number input with units, validation and k/M suffixes, segmented, switch, slider.');
const goodSel = selectInput({ options: goodOptions(), value: G.bread });
const townSel = selectInput({ options: townOptions(s, 'All towns'), value: -1 });
const money = numberInput({ value: 5000, prefix: '¤', unit: '/day', min: 0 });
const pct = numberInput({ value: 0.1, percent: true, min: -1, max: 10 });
const bad = numberInput({ value: 12, unit: 'workers', integer: true, min: 0, max: 10 });
bad.input.value = '12.5';
bad.input.dispatchEvent(new Event('input'));
const side = segmented({ options: [{ value: 'take', label: 'Take' }, { value: 'give', label: 'Give' }], value: 'take' });
const dur = segmented({ options: [{ value: 'once', label: 'Once' }, { value: 'days', label: 'N days' }, { value: 'standing', label: 'Standing' }], value: 'standing', size: 'sm' });
const sw = toggle({ value: true, label: 'Auto-mint' });
const sw2 = toggle({ value: false, label: 'Random events' });
const sl = slider({ min: -0.1, max: 0.2, step: 0.0025, value: 0.02, format: (v) => fmtPct(v, 2) });
const nameIn = textInput({ value: 'Aldermoor', placeholder: 'Realm name' });
grid(
  'two',
  card(
    'A levy form',
    null,
    field('Good', goodSel),
    field('Town', townSel),
    field('Direction', side, 'Take = the Treasury receives; give = it pays.'),
    field('Rate', pct, 'Share of each sale’s value.'),
    field('Duration', dur),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, button({ label: 'Cancel', kind: 'ghost' }), button({ label: 'Add levy', kind: 'primary', icon: icon('plus', 15) })),
  ),
  card(
    'More inputs',
    null,
    field('Budget', money),
    field('Workers', bad, 'Validation message shown under the field.'),
    field('Window rate', sl),
    field('Realm', nameIn),
    field('Settings', h('div', { class: 'stack' }, sw.el, sw2.el)),
    h('div', { class: 'row wrap', style: 'margin-top:10px' }, button({ label: 'Primary', kind: 'primary' }), button({ label: 'Secondary' }), button({ label: 'Ghost', kind: 'ghost' }), button({ label: 'Danger', kind: 'danger' }), button({ label: 'Small', size: 'sm' }), button({ label: 'Disabled', disabled: true })),
    h('div', { class: 'row wrap', style: 'margin-top:10px' }, h('span', { class: 'chip' }, 'neutral'), h('span', { class: 'chip good' }, '▲ good'), h('span', { class: 'chip bad' }, '▼ bad'), h('span', { class: 'chip warn' }, 'binding'), h('span', { class: 'chip gold' }, 'Treasury')),
  ),
);

// ---- dialogs & tooltips ---------------------------------------------------------------------------
sec('Dialogs, toasts & tooltips');
const tipTarget = h('span', { class: 'chip gold', tabIndex: 0 }, 'Hover me');
attachTip(tipTarget, () => [tipTitle('The Purse', '¤12.3k'), tipNote('Money the Treasury holds. Spending from it puts money into circulation.'), tipKV('Taken in today', '¤340'), tipKV('Paid out today', '¤910', 'bad')]);
root.appendChild(
  h(
    'div',
    { class: 'card row wrap' },
    button({ label: 'Open a dialog', onClick: () => openModal({ title: 'Found a new realm', subtitle: 'A fresh land and a new seed.', body: h('div', null, field('Realm name', textInput({ value: '' })), field('Seed', numberInput({ value: 1234, integer: true }))), actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Found it', kind: 'primary', default: true }] }) }),
    button({ label: 'Confirm (danger)', onClick: async () => toast((await confirmDialog({ title: 'Abandon this realm?', message: 'Everything since the last save will be lost.', confirm: 'Abandon', danger: true })) ? 'Confirmed' : 'Cancelled') }),
    button({ label: 'Toast: info', kind: 'ghost', onClick: () => toast('The Treasury now takes 10% of every bread sale in Millbrook.', 'info') }),
    button({ label: 'Toast: good', kind: 'ghost', onClick: () => toast('Realm saved — Y2 · Blossom 17.', 'good') }),
    button({ label: 'Toast: bad', kind: 'ghost', onClick: () => toast('The Purse is empty: payments are suspended.', 'bad') }),
    tipTarget,
  ),
);

// Show a couple of toasts for the screenshot.
setTimeout(() => {
  toast('Realm saved — Y2 · Blossom 17.', 'good');
  toast('The Purse is empty: payments you promised are suspended.', 'bad');
}, 50);

// ---- a sidebar-width preview ------------------------------------------------------------------------
sec('At sidebar width (430px)');
const sb = h('div', { class: 'sidebar-sim' });
const sbc = lineChart({ height: 170, format: fmtIndex });
sbc.set(
  [
    { label: 'Kingsbridge', data: walk(D.cpi.length, 100, { seed: 60, vol: 0.004 }) },
    { label: 'Millbrook', data: walk(D.cpi.length, 100, { seed: 61, vol: 0.004 }) },
    { label: 'Coalridge', data: walk(D.cpi.length, 100, { seed: 62, vol: 0.004 }) },
    { label: 'Saltmere', data: walk(D.cpi.length, 100, { seed: 63, vol: 0.004 }) },
  ],
  { x0 },
);
const sbcc = curveChart({ unit: 'loaf', height: 220 });
sbcc.set(fakeCurve(4, { wedge: { bPct: 0.1, bUnit: 0, sPct: 0, sUnit: 0 } }));
sb.append(h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, 'Markets')), h('div', { class: 'section-title' }, 'Prices by town'), sbc.el, h('div', { class: 'section-title', style: 'margin-top:16px' }, 'Bread · Kingsbridge today'), sbcc.el);
root.appendChild(sb);
