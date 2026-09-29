// ============================================================================
// Levers panel — "Treasury stores & wagons": where the Treasury's goods are
// and where they are going. Used in Levers → Trade and in Ledger → Treasury.
//
//   summary   in store (value) · wagons on the road · carry rules · freight today
//   Stores    holdings by good × town (only towns where something is held);
//             a dot marks goods a carry rule takes on to another town
//   On the road  every Treasury shipment: good, qty, from → to, ETA (from
//             s.day + ui.dayFrac vs shipment.arrive), the carry rule that loaded
//             it, Show on map
//   Freight lines  one card per Treasury freight line (./lines.ts): wagons out,
//             carried, fare, and its accounts (fares in, drivers, fuel & wear)
//
// The rules themselves (orders, carry rules) are listed and changed in In force.
// Everything is keyed and updated in place, so update() is cheap at 4×/s.
// ============================================================================
import { GOODS, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import { carryById, describeCarry } from '../../../sim/policy/carry';
import { STATE, type Shipment, type SimState } from '../../../sim/types';
import { h, setText, setTone, show } from '../../dom';
import { fmtNum, plural } from '../../format';
import { centerMap, ui } from '../../uiState';
import { attachTip, icon, swatch, tipNote, tipTitle } from '../../widgets';
import { bar, fin, fmtM, fmtMS, fmtQ, goodName, keyedList, safe, signedMoney, townName, TONES, unitsOf } from './common';
import { lineList } from './lines';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Treasury shipments on the road, soonest arrival first. */
export function treasuryShipments(s: SimState): Shipment[] {
  return s.shipments.filter((x) => x && x.owner === STATE).sort((a, b) => a.arrive - b.arrive || a.id - b.id);
}

/** Current time in fractional days (the map's clock). */
function now(s: SimState): number {
  return s.day + fin(ui?.dayFrac, 0);
}

/** 0..1 progress of a shipment along its road. */
function progress(s: SimState, sh: Shipment): number {
  const span = sh.arrive - sh.depart;
  if (!(span > 1e-6)) return 1;
  const f = (now(s) - sh.depart) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Approximate tile position of a wagon (along its route's tiles; else between the towns). */
export function wagonXY(s: SimState, sh: Shipment): { x: number; y: number } {
  const f = progress(s, sh);
  const r = safe(() => routeBetweenTowns(s, sh.from, sh.to), null);
  if (r && r.tiles && r.tiles.length >= 2) {
    const t = r.tiles[Math.max(0, Math.min(r.tiles.length - 1, Math.round(f * (r.tiles.length - 1))))];
    return { x: (t % s.map.w) + 0.5, y: Math.floor(t / s.map.w) + 0.5 };
  }
  const A = s.towns[sh.from];
  const B = s.towns[sh.to];
  if (!A || !B) return { x: A?.x ?? 0, y: A?.y ?? 0 };
  return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f };
}

/** "in 1.4 days" / "unloading". */
function etaText(s: SimState, sh: Shipment): string {
  const left = sh.arrive - now(s);
  if (left <= 0.05) return 'arriving';
  if (left < 1) return `in ${Math.max(1, Math.round(left * 24))} h`;
  return `in ${fmtNum(left, left < 10 ? 1 : 0)} days`;
}

/** Tight money for small cells: "¤1.7k", "¤211", "¤9.50" (signed when asked). */
function tight(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? fmtMS(a) : a >= 100 ? '¤' + Math.round(a) : fmtM(a);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
interface ShipRow {
  el: HTMLElement;
  sw: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  tag: HTMLElement;
  eta: HTMLElement;
  bar: ReturnType<typeof bar>;
  good: number;
}

function shipRow(sh: Shipment, state: () => SimState | null): ShipRow {
  const id = sh.id;
  const sw = swatch(GOODS[sh.good]?.color ?? '#999', 'box');
  const title = h('span', { class: 'lv-ship-t' });
  const tag = h('span', { class: 'lv-ship-tag' });
  const sub = h('span', { class: 'lv-ship-s' });
  const eta = h('span', { class: 'lv-ship-eta' });
  const b = bar('lv-ship-bar');
  const btn = h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Show this wagon on the map', 'aria-label': 'Show on map' }, icon('target', 15));
  btn.addEventListener('click', () => {
    const s = state();
    const x = s?.shipments.find((q) => q && q.id === id);
    if (!s || !x) return;
    const p = wagonXY(s, x);
    centerMap(p.x, p.y);
  });
  const el = h(
    'div',
    { class: 'lv-ship' },
    sw,
    h('div', { class: 'lv-ship-main' }, title, h('div', { class: 'lv-ship-head' }, tag, sub)),
    h('div', { class: 'lv-ship-when' }, eta, b.el),
    btn,
  );
  attachTip(tag, () => {
    const s = state();
    const x = s?.shipments.find((q) => q && q.id === id);
    const c = s && x && x.order >= 0 ? carryById(s, x.order) : undefined;
    if (!s || !x) return null;
    if (!c) return [tipTitle(x.order >= 0 ? 'Carry rule ended' : 'Carried once'), tipNote('On arrival it joins the Treasury’s stores there.')];
    return [tipTitle('Carry rule'), tipNote(safe(() => describeCarry(s, c), c.label))];
  });
  return { el, sw, title, sub, tag, eta, bar: b, good: sh.good };
}

function paintShip(s: SimState, v: ShipRow, sh: Shipment): void {
  if (v.good !== sh.good) {
    v.good = sh.good;
    v.sw.style.background = GOODS[sh.good]?.color ?? '#999';
  }
  setText(v.title, `${fmtQ(sh.qty)} ${unitsOf(sh.good)} of ${goodName(sh.good).toLowerCase()}`);
  const nw = Math.max(1, Math.round(fin(sh.wagons, 1)));
  setText(v.sub, `${townName(s, sh.from)} → ${townName(s, sh.to)}${nw > 1 ? ` · ${nw} wagons` : ''}`);
  const ruled = sh.order >= 0 && !!carryById(s, sh.order);
  setText(v.tag, ruled ? 'carry rule' : sh.order >= 0 ? 'rule ended' : 'once');
  setTone(v.tag, TONES, ruled ? 'gold' : null);
  setText(v.eta, etaText(s, sh));
  v.bar.set(progress(s, sh));
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
export interface FlowsView {
  el: HTMLElement;
  update(s: SimState): void;
}

export function flowsView(opts: { place: 'levers' | 'ledger' }): FlowsView {
  let state: SimState | null = null;
  const S = () => state;

  // summary
  const kv = (label: string) => {
    const v = h('span', { class: 'lv-kv-v' });
    const sub = h('span', { class: 'lv-kv-s' });
    return { el: h('div', null, h('span', { class: 'lv-kv-l' }, label), v, sub), v, sub };
  };
  const kStore = kv('In store');
  const kRoad = kv('Wagons');
  const kRules = kv('Carrying');
  const kFreight = kv('Freight');
  const summary = h('div', { class: 'lv-kv4 lv-flows-kv' }, kStore.el, kRoad.el, kRules.el, kFreight.el);
  attachTip(kFreight.el, () => [tipTitle('Freight', 'this month'), tipNote('What the Purse paid trading houses to carry the Treasury’s goods. The Treasury’s own freight lines carry its goods for nothing (their running costs are in their own accounts).')]);

  // stores
  const holdTable = h('div', { class: 'lv-hold' });
  const holdEmpty = h('div', { class: 'lv-empty-sm' }, 'The Treasury holds no goods. Whatever an order buys is kept in the town where it was bought; a carry rule takes it on to another town.');
  let holdSig = '';
  const storeNote = h('span', { class: 'lv-grp-n' });

  // wagons
  const shipList = h('div', { class: 'lv-ships' });
  const shipEmpty = h('div', { class: 'lv-empty-sm' }, 'No Treasury wagons on the road.');
  const shipCount = h('span', { class: 'lv-grp-n' });
  const recShip = keyedList<Shipment, ShipRow>(shipList, (x) => x.id, (x) => shipRow(x, S), (v, x) => state && paintShip(state, v, x));

  const grp = (title: string, n: HTMLElement, ...body: HTMLElement[]) => h('div', { class: 'lv-grp' }, h('div', { class: 'lv-grp-t' }, title, n), ...body);
  const lines = lineList();
  const lineCount = h('span', { class: 'lv-grp-n' });
  const gLines = grp('Freight lines', lineCount, lines.el);
  const gShips = grp('On the road', shipCount, shipList, shipEmpty);
  const el = h('div', { class: 'lv-flows' + (opts.place === 'ledger' ? ' in-ledger' : '') }, summary, grp('Stores', storeNote, holdTable, holdEmpty), gShips, gLines);

  function paintHoldings(s: SimState): number {
    const t = s.treasury;
    const nT = s.towns.length;
    let value = 0;
    const rows: number[] = [];
    let sig = s.towns.map((x) => x.name).join('|');
    const holdsIn = new Set<number>();
    // (town, good) stores a running carry rule takes on elsewhere: key → destination names
    const onward: Record<number, string[]> = {};
    for (const c of s.policy.carries ?? []) {
      if (!c.enabled || (c.until >= 0 && c.until < s.day)) continue;
      for (const f of c.sources && c.sources.length >= 2 ? c.sources : [c.from]) {
        const k = f * N_GOODS + c.good;
        (onward[k] ??= []).push(c.to >= 0 ? townName(s, c.to) : 'where it runs short');
      }
    }
    for (const k in onward) sig += `|c${k}:${onward[k].join(',')}`;
    for (let g = 0; g < N_GOODS; g++) {
      let any = false;
      for (let k = 0; k < nT; k++) {
        const q = fin(t.goods[k]?.[g]);
        if (q > 0.005) {
          any = true;
          holdsIn.add(k);
          const m = s.markets[k * N_GOODS + g];
          value += q * fin(m?.price > 0 ? m.price : m?.ema);
        }
        sig += ',' + q.toFixed(2);
      }
      if (any) rows.push(g);
    }
    if (sig !== holdSig) {
      holdSig = sig;
      if (rows.length) {
        const cols = s.towns.filter((x) => holdsIn.has(x.id));
        const head = h('div', { class: 'lv-hold-r lv-hold-h' }, h('span', null, 'Good'), cols.map((x) => h('span', { title: x.name }, x.name)));
        const body = rows.map((g) =>
          h(
            'div',
            { class: 'lv-hold-r' },
            h('span', { class: 'lv-hold-g' }, swatch(GOODS[g].color, 'box'), GOODS[g].name),
            cols.map((x) => {
              const q = fin(t.goods[x.id]?.[g]);
              const to = onward[x.id * N_GOODS + g];
              return h(
                'span',
                { class: q > 0.005 ? (to ? 'routed' : '') : 'faint', title: q > 0.005 && to ? `${fmtQ(q)} held in ${x.name}; a carry rule takes them on to ${to.join(' and ')}` : null },
                q > 0.005 ? fmtQ(q) : '·',
              );
            }),
          ),
        );
        holdTable.replaceChildren(head, ...body);
        holdTable.style.setProperty('--cols', String(cols.length));
      } else holdTable.replaceChildren();
    }
    show(holdTable, rows.length > 0);
    show(holdEmpty, rows.length === 0);
    setText(storeNote, Object.keys(onward).length ? '● carried on by a rule' : '');
    setText(kStore.sub, rows.length ? `in ${plural(holdsIn.size, 'town')}` : 'nothing held');
    kStore.sub.title = rows.length ? `${plural(rows.length, 'good')} in ${plural(holdsIn.size, 'town')}` : '';
    return value;
  }

  return {
    el,
    update(s) {
      state = s;
      const value = paintHoldings(s);
      setText(kStore.v, tight(value));
      kStore.v.title = `≈ ${fmtM(value)} at today’s prices`;

      const ships = treasuryShipments(s);
      recShip(ships);
      let wagons = 0;
      let units = 0;
      for (const x of ships) {
        wagons += Math.max(1, Math.round(fin(x.wagons, 1)));
        units += fin(x.qty);
      }
      setText(kRoad.v, wagons ? String(wagons) : 'None');
      setText(kRoad.sub, wagons ? `${fmtQ(units)} units` : 'on the road');
      setText(shipCount, ships.length ? String(ships.length) : '');
      show(shipList, ships.length > 0);
      show(shipEmpty, ships.length === 0);

      const rules = s.policy.carries ?? [];
      const running = rules.filter((c) => c.enabled && !(c.until >= 0 && c.until < s.day)).length;
      setText(kRules.v, rules.length ? plural(running, 'rule') : 'None');
      setText(kRules.sub, rules.length > running ? `${rules.length - running} paused` : rules.length ? 'in In force' : 'no rules');
      const fMonth = -fin(s.treasury.flowsMonth?.freight);
      setText(kFreight.v, tight(Math.max(0, fMonth)));
      kFreight.v.title = `${signedMoney(-fMonth)} this month; ${signedMoney(fin(s.treasury.flows?.freight))} today`;
      setText(kFreight.sub, 'this month');
      const nLines = lines.update(s);
      setText(lineCount, nLines ? String(nLines) : '');
      show(gLines, nLines > 0);
    },
  };
}
