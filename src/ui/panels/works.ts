// ============================================================================
// Works panel — the Treasury's own workforce and what it is doing, town by town.
//
//   summary tiles · "staff every town's projects" · one card per town:
//     staffing (none / staff the projects automatically / a set number) and the
//     wage (the going wage + a margin) — composed from an ordinary labour order;
//     who is where: on each building site, driving the freight lines, idle
//     (names; click one to inspect); the town's Treasury projects with progress,
//     today's crew and what they wait for; lines based there; the stores held.
// Everything shown is read from the sim (policy/crews.treasuryCrew); every change
// is a placeOrder / updateOrder / cancelOrder on the town's order for workers.
// ============================================================================
import './works.css';
import { AUTO_CREW_MAX, PLAYER_MAX_WORKERS } from '../../sim/config';
import { GOODS, N_GOODS } from '../../sim/goods';
import { treasuryCrew, type TownCrew } from '../../sim/policy/crews';
import { goingWage } from '../../sim/policy/player';
import type { PlayerAction, PlayerOrder, Project, SimState } from '../../sim/types';
import type { Panel } from '../panel';
import { h, setText, show, toggleClass } from '../dom';
import { fmtInt, fmtMoney, fmtMoneyShort, fmtPct } from '../format';
import { confirmDialog } from '../modal';
import { centerMap, select, setTab, ui, act } from '../uiState';
import { kpi, kpiGrid, numberInput, segmented, type Control, type Kpi, type NumberInput } from '../widgets';
import { projectFraction } from './levers/projects';

type Mode = 'off' | 'auto' | 'fixed';
type WageBand = 0 | 0.1 | 0.25 | 0.5;

const MATS: ['labor' | 'wood' | 'iron' | 'tools', string][] = [
  ['labor', 'labour'],
  ['wood', 'wood'],
  ['iron', 'iron'],
  ['tools', 'tools'],
];

function state(): SimState | null {
  return ui.game?.s ?? null;
}

function run(a: PlayerAction): boolean {
  const r = act(a);
  return !!r?.ok;
}

function townName(s: SimState, t: number): string {
  return s.towns[t]?.name ?? '—';
}

function personName(s: SimState, id: number): string {
  return s.people[id]?.name ?? '—';
}

/** The town's order for workers (the first one; the panel manages that one). */
function crewOrder(c: TownCrew): PlayerOrder | undefined {
  return c.orders[0];
}

function modeOf(o: PlayerOrder | undefined): Mode {
  if (!o || !o.enabled) return 'off';
  return o.staff === 'projects' ? 'auto' : 'fixed';
}

function bandOf(o: PlayerOrder | undefined): WageBand {
  if (!o || o.priceMode !== 'follow') return 0.1;
  const b = o.band ?? 0;
  return b >= 0.4 ? 0.5 : b >= 0.2 ? 0.25 : b >= 0.05 ? 0.1 : 0;
}

/** Apply a staffing choice to a town: one labour order (placed, updated or withdrawn). */
function applyStaffing(s: SimState, town: number, mode: Mode, n: number, band: WageBand): boolean {
  const orders = s.policy.orders.filter((o) => o.market.kind === 'labor' && o.market.town === town);
  const [main, ...extra] = orders;
  let ok = true;
  if (mode === 'off') {
    for (const o of orders) ok = run({ type: 'cancelOrder', id: o.id }) && ok;
    return ok;
  }
  const qty = Math.max(1, Math.min(PLAYER_MAX_WORKERS, Math.round(n)));
  if (!main)
    ok = run({ type: 'placeOrder', market: { kind: 'labor', town }, side: 'buy', price: 0, qty, priceMode: 'follow', band, staff: mode === 'auto' ? 'projects' : undefined });
  else ok = run({ type: 'updateOrder', id: main.id, patch: { qty, priceMode: 'follow', band, staff: mode === 'auto' ? 'projects' : 'fixed', enabled: true } });
  for (const o of extra) run({ type: 'cancelOrder', id: o.id });
  return ok;
}

/** Why a project is not moving (or '' if it is). */
function waitingFor(s: SimState, p: Project): string {
  if (p.status === 'queued') return 'queued with the builders';
  if (p.loanWanted > 0) return 'waiting for funds';
  if (p.status === 'stalled') return `stalled ${p.stalledDays} days — the bills cannot be paid`;
  const b = s.firms[p.builder];
  const labourFrac = p.need.labor > 0 ? p.done.labor / p.need.labor : 1;
  const short: string[] = [];
  for (const [k, word] of MATS) {
    if (k === 'labor') continue;
    const need = p.need[k];
    if (!(need > 0)) continue;
    const g = k === 'wood' ? 2 : k === 'iron' ? 6 : 7;
    const have = p.done[k] + Math.max(0, b?.inv?.[g] ?? 0);
    if (have / need < Math.min(1, labourFrac + 0.02)) short.push(word);
  }
  return short.length ? `waiting for ${short.join(' and ')}` : '';
}

// ---------------------------------------------------------------------------
// A town card
// ---------------------------------------------------------------------------
interface TownCard {
  town: number;
  el: HTMLElement;
  head: HTMLElement;
  headSub: HTMLElement;
  mode: Control<Mode>;
  qty: NumberInput;
  qtyLab: HTMLElement;
  wage: Control<WageBand>;
  wageHint: HTMLElement;
  apply: HTMLButtonElement;
  hint: HTMLElement;
  bar: { site: HTMLElement; drive: HTMLElement; idle: HTMLElement; gap: HTMLElement };
  legend: HTMLElement;
  who: HTMLElement;
  whoSig: string;
  projects: HTMLElement;
  projSig: string;
  extra: HTMLElement;
  touched: boolean;
  lastOrderSig: string;
}

function townCard(town: number): TownCard {
  const card = {} as TownCard;
  card.town = town;
  card.touched = false;
  card.lastOrderSig = '';
  card.whoSig = '';
  card.projSig = '';
  const touch = () => {
    card.touched = true;
    paintControls(card);
  };
  card.mode = segmented<Mode>({
    options: [
      { value: 'off', label: 'None', title: 'Employ no Treasury workers here (the freight lines keep their drivers)' },
      { value: 'auto', label: 'Staff projects', title: 'Each morning, employ as many people as the Treasury’s projects here can use; let them go as the projects finish' },
      { value: 'fixed', label: 'Set number', title: 'Employ a set number of people, whatever there is to do' },
    ],
    value: 'off',
    size: 'sm',
    onChange: touch,
  });
  card.qty = numberInput({ value: AUTO_CREW_MAX, integer: true, min: 1, max: PLAYER_MAX_WORKERS, width: '64px', onChange: touch, title: 'Number of people' });
  card.qtyLab = h('span', { class: 'wk-w' });
  card.wage = segmented<WageBand>({
    options: [
      { value: 0, label: 'Going wage', title: 'The town’s average posted wage' },
      { value: 0.1, label: '+10%' },
      { value: 0.25, label: '+25%' },
      { value: 0.5, label: '+50%', title: 'Pay well above the going wage: hires fast, draws people from other work' },
    ],
    value: 0.1,
    size: 'sm',
    onChange: touch,
  });
  card.wageHint = h('span', { class: 'wk-hint' });
  card.apply = h('button', { class: 'btn btn-primary btn-sm wk-apply', type: 'button' }, 'Apply');
  card.apply.addEventListener('click', () => {
    const s = state();
    if (!s) return;
    if (applyStaffing(s, town, card.mode.value, card.qty.value, card.wage.value)) {
      card.touched = false;
      card.lastOrderSig = '';
    }
    update();
  });
  card.hint = h('div', { class: 'wk-hint wk-hint-row' });
  const seg = (cls: string) => h('span', { class: 'wk-bar-seg ' + cls });
  card.bar = { site: seg('site'), drive: seg('drive'), idle: seg('idle'), gap: seg('gap') };
  card.legend = h('div', { class: 'wk-legend' });
  card.who = h('div', { class: 'wk-who' });
  card.projects = h('div', { class: 'wk-projs' });
  card.extra = h('div', { class: 'wk-extra' });
  card.head = h('div', { class: 'card-title' });
  card.headSub = h('div', { class: 'card-sub' });
  const showBtn = h('button', { class: 'icon-link', type: 'button', title: 'Show the town on the map' }, 'map');
  showBtn.addEventListener('click', () => {
    const s = state();
    const t = s?.towns[town];
    if (t) centerMap(t.x, t.y);
  });
  card.el = h(
    'div',
    { class: 'card wk-town', dataset: { town: String(town) } },
    h('div', { class: 'card-head' }, h('div', { class: 'wk-head-l' }, card.head, showBtn), card.headSub),
    h(
      'div',
      { class: 'wk-ctl' },
      h('div', { class: 'wk-ctl-row' }, h('span', { class: 'wk-lab' }, 'Staffing'), card.mode.el, card.qtyLab, card.qty.el),
      h('div', { class: 'wk-ctl-row' }, h('span', { class: 'wk-lab' }, 'Wage'), card.wage.el, card.wageHint, h('span', { class: 'spacer' }), card.apply),
      card.hint,
    ),
    h('div', { class: 'wk-bar' }, card.bar.site, card.bar.drive, card.bar.idle, card.bar.gap),
    card.legend,
    card.who,
    card.projects,
    card.extra,
  );
  return card;
}

function paintControls(c: TownCard): void {
  const s = state();
  if (!s) return;
  const m = c.mode.value;
  show(c.qty.el, m !== 'off');
  setText(c.qtyLab, m === 'auto' ? 'at most' : m === 'fixed' ? 'people:' : '');
  show(c.wage.el.parentElement as HTMLElement, m !== 'off' || c.touched);
  const gw = goingWage(s, c.town);
  setText(c.wageHint, m === 'off' ? '' : `${fmtMoney(gw * (1 + c.wage.value))} a day`);
  toggleClass(c.apply, 'pulse', c.touched);
  c.apply.disabled = !c.touched;
}

function nameList(s: SimState, ids: number[], max = 10): HTMLElement {
  const out = h('span', { class: 'wk-names' });
  ids.slice(0, max).forEach((id, i) => {
    if (i) out.append(', ');
    const b = h('button', { class: 'ent-link', type: 'button', title: 'Inspect' }, personName(s, id));
    b.addEventListener('click', () => select({ kind: 'person', id }));
    out.append(b);
  });
  if (ids.length > max) out.append(` and ${ids.length - max} more`);
  return out;
}

function paintCard(s: SimState, c: TownCard, crew: TownCrew): void {
  const o = crewOrder(crew);
  // controls follow the order unless the player is changing them
  const sig = o ? `${o.id}|${o.enabled}|${o.staff ?? ''}|${o.qty}|${o.priceMode}|${o.band}` : 'none';
  if (!c.touched && sig !== c.lastOrderSig) {
    c.lastOrderSig = sig;
    c.mode.set(modeOf(o));
    c.qty.set(o ? o.qty : Math.max(AUTO_CREW_MAX, crew.canUse));
    c.wage.set(bandOf(o));
  }
  paintControls(c);

  const n = crew.workers.length;
  const onSites = crew.sites.reduce((a, x) => a + x.people.length, 0);
  const bill = n * crew.wage;
  setText(c.head, townName(s, c.town));
  setText(c.headSub, n ? `${fmtInt(n)} at work · ${fmtMoney(bill)} a day` : crew.projects.length ? 'no Treasury workers' : 'nothing under way');

  const mode = modeOf(o);
  const fixedWage = o && o.priceMode !== 'follow' ? ` It now pays a fixed ${fmtMoney(o.price)} a day; applying switches it to the going wage.` : '';
  const hint =
    mode === 'auto'
      ? `Hires what the projects here can use — ${fmtInt(o?.staffToday ?? 0)} today — and lets people go as the work runs out.`
      : mode === 'fixed'
        ? crew.canUse > 0
          ? `The projects here could use about ${fmtInt(crew.canUse)} today.`
          : 'Nothing to build here: a set crew waits idle, still paid.'
        : crew.canUse > 0
          ? `The Treasury’s projects here could use about ${fmtInt(crew.canUse)} people today — the builders do the rest, and bill for it.`
          : 'Treasury workers build on the Treasury’s own projects in their town (the builders then bill less), or drive its freight lines.';
  setText(c.hint, hint + fixedWage);

  // assignment bar
  const denom = Math.max(1, n, crew.wanted);
  const w = (k: number) => `${(100 * k) / denom}%`;
  c.bar.site.style.width = w(onSites);
  c.bar.drive.style.width = w(crew.drivers.length);
  c.bar.idle.style.width = w(crew.idle.length);
  c.bar.gap.style.width = w(Math.max(0, crew.wanted - n));
  const parts: string[] = [];
  if (onSites) parts.push(`${fmtInt(onSites)} building`);
  if (crew.drivers.length) parts.push(`${fmtInt(crew.drivers.length)} driving`);
  if (crew.idle.length) parts.push(`${fmtInt(crew.idle.length)} idle`);
  if (crew.wanted > n) parts.push(`${fmtInt(crew.wanted - n)} still to hire`);
  setText(c.legend, parts.length ? parts.join(' · ') : 'Nobody employed.');

  // who is where (rebuilt only when it changes)
  const whoSig = [crew.sites.map((x) => x.project.id + ':' + x.people.join(',')).join(';'), crew.drivers.join(','), crew.idle.join(',')].join('|');
  if (whoSig !== c.whoSig) {
    c.whoSig = whoSig;
    const rows: HTMLElement[] = [];
    for (const site of crew.sites) {
      if (!site.people.length) continue;
      rows.push(h('div', { class: 'wk-who-row' }, h('span', { class: 'wk-who-t site' }, `${site.project.label || 'Project'} — ${site.people.length}`), nameList(s, site.people)));
    }
    if (crew.drivers.length) rows.push(h('div', { class: 'wk-who-row' }, h('span', { class: 'wk-who-t drive' }, `Driving the freight lines — ${crew.drivers.length}`), nameList(s, crew.drivers)));
    if (crew.idle.length) {
      const letGo = h('button', { class: 'lv-chip', type: 'button', title: 'Keep only the people with work to do' }, 'Let the idle go');
      letGo.addEventListener('click', () => {
        const st = state();
        if (!st) return;
        const cr = treasuryCrew(st, c.town);
        const keep = cr.workers.length - cr.idle.length - cr.drivers.length;
        const ord = crewOrder(cr);
        if (ord && ord.staff === 'projects') return; // automatic staffing already sizes the crew
        if (keep <= 0) applyStaffing(st, c.town, 'off', 0, bandOf(ord));
        else applyStaffing(st, c.town, 'fixed', keep, bandOf(ord));
        c.touched = false;
        c.lastOrderSig = '';
        update();
      });
      const auto = mode === 'auto';
      rows.push(
        h(
          'div',
          { class: 'wk-who-row' },
          h('span', { class: 'wk-who-t idle' }, `Idle — ${crew.idle.length}`),
          nameList(s, crew.idle),
          auto ? h('span', { class: 'wk-hint' }, ' (waiting for materials or for work to start)') : letGo,
        ),
      );
    }
    c.who.replaceChildren(...rows);
  }

  // projects (rebuilt when their numbers change)
  const projSig = crew.projects.map((p) => `${p.id}:${p.status}:${Math.round(p.done.labor)}:${Math.round(p.done.wood)}:${Math.round(p.done.iron)}:${Math.round(p.done.tools)}:${(p.crewHeads ?? 0).toFixed(1)}:${p.stalledDays}:${p.loanWanted > 0}`).join('|');
  if (projSig !== c.projSig) {
    c.projSig = projSig;
    const rows = crew.projects.map((p) => {
      const f = projectFraction(p);
      const fill = h('i', { style: { width: `${Math.round(f * 100)}%` } });
      const mats = MATS.filter(([k]) => p.need[k] > 0)
        .map(([k, word]) => `${word} ${Math.floor(Math.min(p.done[k], p.need[k]))}/${Math.round(p.need[k])}`)
        .join(' · ');
      const wait = waitingFor(s, p);
      const heads = p.crewHeads ?? 0;
      const crewTxt = heads > 0.05 ? `Treasury crew today: about ${fmtInt(Math.round(heads))} (${(p.crewToday ?? 0).toFixed(1)} labour-days)` : 'no Treasury crew on it today';
      const builder = s.firms[p.builder]?.name ?? 'builders';
      const map = h('button', { class: 'icon-link', type: 'button', title: 'Show on the map' }, 'map');
      map.addEventListener('click', () => {
        const b = p.building >= 0 ? s.buildings[p.building] : undefined;
        if (b) centerMap(b.x + b.w / 2, b.y + b.h / 2);
        else if (p.tiles?.length) {
          const mid = p.tiles[Math.floor(p.tiles.length / 2)];
          centerMap(mid % s.map.w, Math.floor(mid / s.map.w));
        }
      });
      const off = h('button', { class: 'icon-link bad', type: 'button', title: 'Call off this project' }, 'call off');
      off.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Call off this project?', message: `“${p.label}” stops where it is. ${fmtMoney(p.billed)} has been billed so far; nothing is refunded.`, confirm: 'Call it off', danger: true });
        if (ok) run({ type: 'cancelProject', id: p.id });
      });
      return h(
        'div',
        { class: 'wk-proj' },
        h('div', { class: 'wk-proj-head' }, h('span', { class: 'wk-proj-t' }, p.label || 'Treasury project'), h('span', { class: 'wk-proj-pct' }, fmtPct(f, 0)), h('span', { class: 'spacer' }), map, off),
        h('div', { class: 'wk-prog' }, fill),
        h('div', { class: 'wk-proj-m' }, `${crewTxt} · ${builder} · billed ${fmtMoneyShort(p.billed)}`),
        h('div', { class: 'wk-proj-m' }, mats + (wait ? ' — ' : ''), wait ? h('span', { class: 'warn' }, wait) : null),
      );
    });
    c.projects.replaceChildren(...(rows.length ? [h('div', { class: 'wk-sub' }, 'Treasury projects here'), ...rows] : []));
  }

  // lines and stores
  const extras: HTMLElement[] = [];
  for (const { line, crew: dr } of crew.lines) {
    const other = line.a === c.town ? line.b : line.a;
    extras.push(h('div', { class: 'wk-proj-m' }, `Freight line to ${townName(s, other)}: ${fmtInt(dr)} of ${fmtInt(line.drivers)} drivers, ${fmtInt(line.wagons)} wagons${line.enabled ? '' : ' (paused)'}`));
  }
  const held: string[] = [];
  const inv = s.treasury.goods?.[c.town] ?? [];
  for (let g = 0; g < N_GOODS; g++) if ((inv[g] ?? 0) >= 0.5) held.push(`${fmtInt(inv[g])} ${GOODS[g].name.toLowerCase()}`);
  if (held.length) extras.push(h('div', { class: 'wk-proj-m' }, `Treasury stores here: ${held.join(', ')}`));
  c.extra.replaceChildren(...extras);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
let tiles: Record<string, Kpi> = {};
let cardsHost: HTMLElement;
let cards: TownCard[] = [];
let cardsFor = -1;
let allAuto: HTMLButtonElement;
let allOff: HTMLButtonElement;

function update(): void {
  const s = state();
  if (!s || !cardsHost) return;
  if (cardsFor !== s.towns.length || cards.length !== s.towns.length) {
    cards = s.towns.map((_, t) => townCard(t));
    cardsHost.replaceChildren(...cards.map((c) => c.el));
    cardsFor = s.towns.length;
  }
  let n = 0;
  let sites = 0;
  let drivers = 0;
  let idle = 0;
  let bill = 0;
  let live = 0;
  const crews = s.towns.map((_, t) => treasuryCrew(s, t));
  crews.forEach((crew, t) => {
    n += crew.workers.length;
    sites += crew.sites.reduce((a, x) => a + x.people.length, 0);
    drivers += crew.drivers.length;
    idle += crew.idle.length;
    bill += crew.workers.length * crew.wage;
    live += crew.projects.length;
    paintCard(s, cards[t], crew);
  });
  tiles.workers.set(n, { sub: `${fmtMoney(bill)} a day in wages` });
  tiles.sites.set(sites, { sub: live ? `${fmtInt(live)} project${live === 1 ? '' : 's'} under way` : 'no projects' });
  tiles.idle.set(idle, { sub: drivers ? `${fmtInt(drivers)} driving freight lines` : 'none driving', tone: idle > 0 ? 'warn' : null });
  const autoTowns = crews.filter((c) => crewOrder(c)?.staff === 'projects' && crewOrder(c)?.enabled).length;
  setText(allAuto, autoTowns === s.towns.length ? 'Every town staffs its projects' : 'Staff every town’s projects automatically');
  allAuto.disabled = autoTowns === s.towns.length;
  allOff.disabled = !crews.some((c) => c.orders.length > 0);
}

export const worksPanel: Panel = {
  id: 'works',
  title: 'Works',
  mount(el) {
    tiles = {
      workers: kpi({ label: 'Treasury workers', format: (v) => fmtInt(v), hint: 'People the Treasury employs, in every town, and what their wages cost the Purse each day.' }),
      sites: kpi({ label: 'On building sites', format: (v) => fmtInt(v), hint: 'Treasury workers putting in labour on the Treasury’s own projects today. The builders bill for the rest of the labour.' }),
      idle: kpi({ label: 'Idle', format: (v) => fmtInt(v), hint: 'Paid but with nothing to do today: no project in their town, or one still waiting for materials.' }),
    };
    allAuto = h('button', { class: 'btn btn-sm', type: 'button', title: 'In every town: employ as many people as the Treasury’s projects there can use, at the going wage + 10%, and let them go as the projects finish' }, 'Staff every town’s projects automatically');
    allAuto.addEventListener('click', () => {
      const s = state();
      if (!s) return;
      for (let t = 0; t < s.towns.length; t++) {
        const c = treasuryCrew(s, t);
        const o = crewOrder(c);
        if (o && o.staff === 'projects' && o.enabled) continue;
        applyStaffing(s, t, 'auto', Math.max(AUTO_CREW_MAX, o?.qty ?? 0), bandOf(o));
      }
      for (const c of cards) {
        c.touched = false;
        c.lastOrderSig = '';
      }
      update();
    });
    allOff = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Withdraw every order for Treasury workers: they are let go tomorrow (the freight lines keep their drivers)' }, 'Let everyone go');
    allOff.addEventListener('click', async () => {
      const s = state();
      if (!s) return;
      const ok = await confirmDialog({ title: 'Let every Treasury worker go?', message: 'Every order for Treasury workers is withdrawn; they leave tomorrow. The freight lines keep their drivers.', confirm: 'Let them go', danger: true });
      if (!ok) return;
      for (let t = 0; t < s.towns.length; t++) applyStaffing(s, t, 'off', 0, 0.1);
      update();
    });
    const build = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Commission roads, houses and workshops (Levers → Build)' }, 'Commission a project…');
    build.addEventListener('click', () => {
      setTab('levers');
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.lv-head[data-lever="build"]:not([aria-expanded="true"])')?.click());
    });
    cardsHost = h('div', { class: 'wk-towns' });
    el.classList.add('wk-panel');
    el.replaceChildren(
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, 'Works'), h('div', { class: 'card-sub' }, 'Your workers, your building sites, your freight lines — town by town.')),
      kpiGrid([tiles.workers, tiles.sites, tiles.idle], 3),
      h('div', { class: 'wk-actions' }, allAuto, allOff, h('span', { class: 'spacer' }), build),
      cardsHost,
    );
    cards = [];
    cardsFor = -1;
    update();
  },
  update,
};
