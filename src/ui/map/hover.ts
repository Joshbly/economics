// ============================================================================
// Hover tooltips for the map: what is under the pointer, in plain words.
// Built from DOM nodes with the shared tooltip blocks (names from the
// simulation are inserted as text, never HTML).
// ============================================================================
import { GOODS, N_GOODS, SECTORS } from '../../sim/goods';
import { isFirm, isPerson, refId } from '../../sim/ledger';
import { STATE, Terrain, type Building, type SimState } from '../../sim/types';
import { tileResource } from '../../sim/world/mapgen';
import { h, type Child } from '../dom';
import { fmtMoney, fmtNum, fmtPct, fmtPrice, plural } from '../format';
import { tipKV, tipNote, tipTitle } from '../widgets/tooltip';
import { projectProgress } from './buildings';
import { roundQty, treasuryWagonText } from './routes';
import { shipmentProgress } from './schedule';

export type HoverTarget =
  | { kind: 'building'; id: number }
  | { kind: 'person'; id: number }
  | { kind: 'wagon'; id: number }
  | { kind: 'town'; id: number }
  /** A Treasury supply route (id = the order's id) or freight line (id = the line's id). */
  | { kind: 'route'; id: number }
  | { kind: 'tile'; i: number }
  | null;

export function sameTarget(a: HoverTarget, b: HoverTarget): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'tile' ? a.i === (b as { i: number }).i : (a as { id: number }).id === (b as { id: number }).id;
}

const TERRAIN_NAMES = ['Deep sea', 'Shallow sea', 'Sand', 'Grassland', 'Forest', 'Hills', 'Mountains', 'Marsh'];
const RESOURCE_WORDS: Record<number, string> = { 2: 'timber', 3: 'coal', 4: 'oil seeps', 5: 'ore', 1: 'fishing grounds' };

function ownerName(s: SimState, ref: number): string {
  if (ref === STATE) return 'the Treasury';
  if (ref === -2) return 'the Bank';
  if (isPerson(ref)) return s.people[ref]?.name ?? 'a householder';
  if (isFirm(ref)) return s.firms[refId(ref)]?.name ?? 'a firm';
  return '—';
}

function qty(g: number, n: number): string {
  const def = GOODS[g];
  if (!def) return fmtNum(n);
  return plural(Math.round(n * 10) / 10, def.unit);
}

function statusLine(s: SimState, b: Building): Child {
  if (b.status === 'construction') {
    const p = projectProgress(s, b.project);
    return tipKV('Status', p >= 0 ? `Being built · ${fmtPct(p, 0)} done` : 'Being built', 'warn');
  }
  if (b.status === 'vacant') return tipKV('Status', 'Standing empty', 'bad');
  if (b.project >= 0) {
    const p = projectProgress(s, b.project);
    return tipKV('Builders', p >= 0 ? `Enlarging · ${fmtPct(p, 0)}` : 'Enlarging', 'warn');
  }
  return null;
}

function buildingTip(s: SimState, id: number): Child[] {
  const b = s.buildings[id];
  if (!b) return [];
  const town = s.towns[b.town];
  const tn = town?.name ?? '';
  const out: Child[] = [];
  switch (b.kind) {
    case 'house': {
      out.push(tipTitle('Houses', tn));
      if (b.status === 'active') {
        out.push(tipKV('Households', `${b.residents.length} of ${b.slots}`));
        out.push(tipKV('Rent', `${fmtPrice(b.rent)} a day`));
      }
      out.push(tipKV('Landlord', ownerName(s, b.owner), b.owner === STATE ? 'gold' : undefined));
      out.push(statusLine(s, b));
      break;
    }
    case 'firm': {
      const f = b.firm >= 0 ? s.firms[b.firm] : undefined;
      const def = b.sector ? SECTORS[b.sector] : undefined;
      out.push(tipTitle(f && f.alive ? f.name : def?.name ?? 'Workshop', `${def?.name ?? ''}${tn ? ' · ' + tn : ''}`));
      if (f && f.alive && b.status === 'active') {
        out.push(tipKV('Workers', `${f.workers.length} of ${f.capacity}`));
        if (f.wage > 0) out.push(tipKV('Wage', `${fmtPrice(f.wage)} a day`));
        if (def && def.out >= 0) out.push(tipKV('Made today', qty(def.out, f.producedToday || 0)));
        if (f.sector === 'trader' && f.trade) out.push(tipKV('Wagons', `${f.trade.wagons} (${f.trade.busy.length} on the road)`));
        if (f.sector === 'builder' && f.build) out.push(tipKV('Projects queued', String(f.build.queue.length)));
        if (f.status === 'liquidating') out.push(tipKV('Status', 'Winding up', 'bad'));
        out.push(tipKV('Owner', ownerName(s, f.owner), f.owner === STATE ? 'gold' : undefined));
      }
      out.push(statusLine(s, b));
      break;
    }
    case 'market': {
      out.push(tipTitle(`${tn} Market Hall`, 'daily market'));
      for (const g of [8, 1, 9, 3]) {
        const m = s.markets[b.town * N_GOODS + g];
        if (m) out.push(tipKV(GOODS[g].name, fmtPrice(Number.isFinite(m.gross) && m.gross > 0 ? m.gross : m.price)));
      }
      out.push(tipNote('Click to open this town’s markets.'));
      break;
    }
    case 'bank': {
      const bk = s.bank;
      out.push(tipTitle('The Bank', tn));
      if (bk) {
        out.push(tipKV('Lends at', fmtPct(bk.baseRate, 1) + ' a year'));
        out.push(tipKV('Pays savers', fmtPct(bk.depositRate, 1) + ' a year'));
        if (bk.failed) out.push(tipKV('Status', 'Failed', 'bad'));
      }
      break;
    }
    case 'palace': {
      out.push(tipTitle('The Palace', 'seat of the Treasury'));
      out.push(tipKV('Purse', fmtMoney(s.treasury?.purse ?? 0), 'gold'));
      break;
    }
    case 'port': {
      const water = s.map.terrain[b.y * s.map.w + b.x] <= Terrain.Water;
      out.push(tipTitle(water ? 'Pier' : `Port of ${tn}`, water ? tn : 'foreign ships call here'));
      if (!water && s.foreign) {
        out.push(tipKV('Imports today', fmtMoney(s.foreign.importValue || 0)));
        out.push(tipKV('Exports today', fmtMoney(s.foreign.exportValue || 0)));
      }
      out.push(statusLine(s, b));
      break;
    }
  }
  return out;
}

function personTip(s: SimState, id: number): Child[] {
  const p = s.people[id];
  if (!p || !p.alive) return [];
  const town = s.towns[p.town]?.name ?? '';
  const out: Child[] = [tipTitle(p.name, town)];
  if (p.job >= 0) {
    const f = s.firms[p.job];
    const def = f ? SECTORS[f.sector] : undefined;
    out.push(tipKV('Works', f ? (f.sector === 'stateworks' ? 'for the Treasury' : `${def?.worker ?? 'hand'} at ${f.name}`) : '—', f?.sector === 'stateworks' ? 'gold' : undefined));
    if (p.wage > 0) out.push(tipKV('Wage', `${fmtPrice(p.wage)} a day`));
  } else out.push(tipKV('Work', p.unempDays > 0 ? `Looking for work · ${plural(p.unempDays, 'day')}` : 'Looking for work', 'bad'));
  out.push(tipKV('Home', p.home >= 0 ? 'Rents or owns a home' : 'Sleeping rough', p.home >= 0 ? undefined : 'bad'));
  out.push(tipKV('Health', fmtPct(p.health, 0), p.health < 0.6 ? 'bad' : undefined));
  out.push(tipNote('Click to follow this household.'));
  return out;
}

function wagonTip(s: SimState, id: number, dayFrac: number): Child[] {
  const sh = s.shipments.find((x) => x && x.id === id);
  if (!sh) return [];
  const from = s.towns[sh.from]?.name ?? '?';
  const to = s.towns[sh.to]?.name ?? '?';
  if (sh.owner === STATE) {
    // "Treasury: 40 bread → Saltmere" over "arrives in 1.4 days"
    const [line, when] = treasuryWagonText(s, sh, dayFrac);
    const title = tipTitle(line, when);
    title.classList.add('mapc-tt2');
    const out: Child[] = [title];
    out.push(tipKV('From', from));
    out.push(tipKV('On the way', fmtPct(shipmentProgress(s.day, dayFrac, sh.depart, sh.arrive), 0)));
    const o = sh.order >= 0 ? s.policy?.orders.find((x) => x && x.id === sh.order) : undefined;
    if (o && o.route) out.push(tipKV('Supply route', `${fmtNum(roundQty(o.qty))} a day`, 'gold'));
    if (sh.line >= 0) out.push(tipKV('Carried by', 'the Treasury freight line', 'gold'));
    if (sh.wagons > 1) out.push(tipKV('Wagons', fmtNum(sh.wagons)));
    out.push(tipNote(`Click to open ${to}.`));
    return out;
  }
  const L = sh.line >= 0 ? s.policy?.lines?.find((x) => x && x.id === sh.line) : undefined;
  const out: Child[] = [L ? tipTitle('Treasury freight line', `${from} → ${to}`) : tipTitle(`Wagon${sh.wagons > 1 ? 's' : ''} to ${to}`, `from ${from}`)];
  out.push(tipKV('Carrying', qty(sh.good, sh.qty) + ' of ' + (GOODS[sh.good]?.name.toLowerCase() ?? 'goods')));
  const left = Math.max(0, sh.arrive - (s.day + dayFrac));
  const prog = shipmentProgress(s.day, dayFrac, sh.depart, sh.arrive);
  out.push(tipKV('Arrives', left < 0.05 ? 'now' : `in ${fmtNum(left, 1)} days`));
  out.push(tipKV('On the way', fmtPct(prog, 0)));
  out.push(tipKV(L ? 'Goods of' : 'Owner', sh.owner === STATE ? 'the Treasury' : ownerName(s, sh.owner), sh.owner === STATE ? 'gold' : undefined));
  if (L) out.push(tipNote(L.fare === 'free' ? 'Carried on a Treasury wagon for nothing.' : `Carried on a Treasury wagon for ${fmtPrice(sh.qty > 0 ? L.fareToday : 0)} a unit.`));
  return out;
}

function routeTip(s: SimState, id: number): Child[] {
  const o = s.policy?.orders.find((x) => x && x.id === id);
  if (!o || !o.route || o.market.kind !== 'good') return [];
  const r = o.route;
  const g = o.market.good;
  const from = s.towns[o.market.town]?.name ?? '?';
  const to = s.towns[r.to]?.name ?? '?';
  const name = (GOODS[g]?.name ?? 'Goods').toLowerCase();
  const out: Child[] = [tipTitle('Supply route', `${name} · ${from} → ${to}`)];
  out.push(tipKV(`Buys in ${from}`, `${qty(g, roundQty(o.qty))} a day, up to ${fmtPrice(o.price)}`));
  let carried = 0;
  let carts = 0;
  for (const sh of s.shipments) {
    if (!sh || sh.owner !== STATE || sh.order !== o.id) continue;
    carts++;
    carried += Number.isFinite(sh.qty) ? sh.qty : 0;
  }
  const onRoad = Math.max(Number.isFinite(r.inTransit) ? r.inTransit : 0, carried);
  if (carts === 0 && !(onRoad > 0)) out.push(tipKV('On the road', 'nothing yet'));
  else out.push(tipKV('On the road', qty(g, roundQty(onRoad)) + (carts ? ` · ${plural(carts, 'convoy')}` : '')));
  if (r.waiting > 0) out.push(tipKV(`For sale in ${to}`, qty(g, roundQty(r.waiting))));
  if (r.soldTotal > 0) out.push(tipKV('Sold so far', qty(g, roundQty(r.soldTotal))));
  if (!o.enabled) out.push(tipKV('Status', 'Paused', 'warn'));
  out.push(tipNote(`Gold dashes follow the road the Treasury’s wagons take; chevrons point toward ${to}. Click to open ${to}.`));
  return out;
}

function lineTip(s: SimState, id: number): Child[] {
  const L = s.policy?.lines?.find((x) => x && x.id === id);
  if (!L) return [];
  const A = s.towns[L.a]?.name ?? '?';
  const B = s.towns[L.b]?.name ?? '?';
  let out = 0;
  for (const d of L.busy ?? []) if (d > s.day) out++;
  let carried = 0;
  for (const sh of s.shipments) if (sh && sh.line === L.id) carried += Number.isFinite(sh.qty) ? sh.qty : 0;
  const fare = L.fare === 'free' ? 'nothing' : `${fmtPrice(L.fareToday)} a unit${L.fare === 'cost' ? ' (its running cost)' : ''}`;
  const parts: Child[] = [tipTitle('Treasury freight line', `${A} ⇄ ${B}`)];
  parts.push(tipKV('Wagons', `${fmtNum(out)} of ${fmtNum(L.wagons)} on the road`, 'gold'));
  parts.push(tipKV('On the road', carried > 0 ? `${fmtNum(roundQty(carried))} units` : 'nothing'));
  parts.push(tipKV('Carried today', `${fmtNum(roundQty(L.carriedToday))} units`));
  parts.push(tipKV('Traders pay', fare));
  if (!L.enabled) parts.push(tipKV('Status', 'Paused', 'warn'));
  parts.push(tipNote(`Treasury wagons kept in ${A}, driven by Treasury workers; trading houses of both towns load their goods onto them. Click to open ${B}.`));
  return parts;
}

function townTip(s: SimState, id: number): Child[] {
  const t = s.towns[id];
  if (!t) return [];
  const kind = t.kind === 'capital' ? 'the capital' : t.kind === 'farm' ? 'farming town' : t.kind === 'mining' ? 'mining town' : 'harbour town';
  const lab = (t.employed || 0) + (t.unemployed || 0);
  return [
    tipTitle(t.name, kind),
    tipKV('Households', fmtNum(t.pop || 0)),
    tipKV('Without work', lab > 0 ? fmtPct((t.unemployed || 0) / lab, 1) : '—'),
    tipKV('Sleeping rough', fmtNum(t.homeless || 0), (t.homeless || 0) > 0 ? 'bad' : undefined),
    tipKV('Average wage', `${fmtPrice(t.avgWage)} a day`),
    tipNote('Click to inspect the town.'),
  ];
}

function tileTip(s: SimState, i: number, extra?: string): Child[] {
  const m = s.map;
  if (i < 0 || i >= m.terrain.length) return [];
  const t = m.terrain[i];
  const out: Child[] = [];
  let name = TERRAIN_NAMES[t] ?? 'Land';
  if (m.river[i]) name = m.road[i] >= 1 ? 'Bridge' : 'River';
  else if (m.road[i] >= 2) name = 'Paved road';
  else if (m.road[i] >= 1) name = 'Track';
  const d = m.district[i];
  out.push(tipTitle(name, d >= 0 ? s.towns[d]?.name ?? '' : 'wilderness'));
  const g = tileResource(m, i);
  if (g >= 0 && (m.deposit[i] ?? 0) > 0.05) out.push(tipKV(RESOURCE_WORDS[g] ? RESOURCE_WORDS[g][0].toUpperCase() + RESOURCE_WORDS[g].slice(1) : GOODS[g].name, fmtPct(m.deposit[i], 0)));
  if (t === Terrain.Grass && (m.fert[i] ?? 0) > 0) out.push(tipKV('Fertility', fmtPct(m.fert[i], 0)));
  if (extra) out.push(tipNote(extra));
  return out;
}

/** Tooltip content for a hover target (null = nothing to show). */
export function hoverContent(s: SimState, t: HoverTarget, dayFrac: number, note?: string): Child | null {
  if (!t) return null;
  let parts: Child[] = [];
  switch (t.kind) {
    case 'building':
      parts = buildingTip(s, t.id);
      break;
    case 'person':
      parts = personTip(s, t.id);
      break;
    case 'wagon':
      parts = wagonTip(s, t.id, dayFrac);
      break;
    case 'town':
      parts = townTip(s, t.id);
      break;
    case 'route':
      parts = routeTip(s, t.id);
      if (!parts.length) parts = lineTip(s, t.id);
      break;
    case 'tile':
      parts = tileTip(s, t.i, note);
      break;
  }
  if (note && t.kind !== 'tile') parts.push(tipNote(note));
  const kept = parts.filter(Boolean);
  if (!kept.length) return null;
  return h('div', { class: 'mapc-tip' }, ...kept);
}
