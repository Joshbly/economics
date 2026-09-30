// ============================================================================
// Lever VI — Build: commission construction paid from the Purse — pave a road
// between two towns, a block of Treasury houses, a Treasury workshop of any
// trade, a pier at the port, or enlarge a Treasury workshop. Sites can be
// picked on the map (placement mode) or left to the builders. Treasury
// projects are listed below with their progress.
// Also: open a Treasury freight line (Treasury wagons, drivers and fuel kept in
// the first town, carrying the trading houses' goods between the two towns for
// a fare the player sets); the lines are listed below with their accounts.
// ============================================================================
import { LINE_MARGIN_MAX, LINE_MARGIN_MIN, LINE_MAX_FARE, LINE_MAX_WAGONS, LINE_UNDER_MAX, PIER_CAP_BONUS, SPEED_DIRT, SPEED_PAVED, TOOLS_PER_WAGON, WAGON_CAPACITY } from '../../../sim/config';
import { freightPerUnit } from '../../../sim/agents/traders';
import { estimateLine, lineBetween } from '../../../sim/policy/lines';
import type { LineFare, LineStaffing } from '../../../sim/types';
import { estimateCost, needCost, projectNeed, roadNeed } from '../../../sim/agents/construction';
import { isWorks } from '../../../sim/agents/ownership';
import { GOODS, HOUSE_SLOTS, SECTORS } from '../../../sim/goods';
import { roadPlan, trackPlan } from '../../../sim/world/paths';
import { findSite, townCentreTile } from '../../../sim/world/layout';
import { plotPrice } from '../../../sim/agents/council';
import { paveEffect } from '../../../sim/world/roadEffect';
import { STATE, type Materials, type ProjectKind, type Sector, type SimState, type TownId } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtNum, fmtPct, fmtPrice, plural } from '../../format';
import { centerMap, on, setPlacing, ui, type PrefillRequest } from '../../uiState';
import { button, icon, numberInput, segmented, selectInput, toggle, townOptions, type Option } from '../../widgets';
import { banner, dynRow, fin, fmtM, formEl, formFoot, msgLine, row, run, safe, subhead, submitButton, townName, type Lever } from './common';
import { projectList, treasuryProjects } from './projects';
import { autoCrewOn, ensureCrew, setAutoCrew } from '../../crew';
import { freightLines, lineList } from './lines';

type BKind = 'road' | 'house' | 'firm' | 'pier' | 'expand' | 'line';
const BUILDABLE = (Object.keys(SECTORS) as Sector[]).filter((k) => k !== 'stateworks');
const TOOLS = GOODS.findIndex((g) => g.key === 'tools');

function sectorOpts(): Option<Sector>[] {
  return BUILDABLE.map((k) => ({ value: k, label: SECTORS[k].name, group: SECTORS[k].producer ? 'Makes goods' : 'Services' }));
}

function recipe(sec: Sector): string {
  const d = SECTORS[sec];
  if (!d) return '';
  if (sec === 'builder') return 'A builders’ yard: takes on construction work in its town.';
  if (sec === 'trader') return 'A trading house: runs wagons that carry goods between towns for profit.';
  const out = GOODS[d.out]?.name.toLowerCase() ?? 'goods';
  const ins = d.inputs.map(([g]) => GOODS[g]?.name.toLowerCase()).filter(Boolean);
  return `Makes ${out}${ins.length ? ' from ' + ins.join(' and ') : ''}; room for ${plural(d.capacityPerLevel, 'worker')} per level.`;
}

function matText(m: Materials): string {
  const parts: string[] = [];
  if (m.labor > 0) parts.push(`${fmtNum(m.labor)} worker-days`);
  if (m.wood > 0) parts.push(`${fmtNum(m.wood)} logs`);
  if (m.iron > 0) parts.push(`${fmtNum(m.iron)} iron bars`);
  if (m.tools > 0) parts.push(`${fmtNum(m.tools)} tool sets`);
  return parts.join(' · ');
}

/** What a new dirt track does: the ground it clears, the rivers it bridges. */
function trackText(s: SimState, plan: readonly number[]): string {
  const bridges = plan.filter((i) => s.map.river[i] === 1).length;
  return `Clears and lays ${plural(plan.length, 'tile')} of new dirt track${bridges ? `, with ${plural(bridges, 'timber bridge')}` : ''}; it joins the roads already there. Wagons and walkers cover about ${SPEED_DIRT} tiles a day on dirt, far more than across open country. To lay one anywhere else, draw it on the map.`;
}

/** What paving the planned tiles does: the track it upgrades, and the trips it speeds up. */
function roadText(s: SimState, plan: readonly number[]): string {
  const fresh = plan.filter((i) => !(s.map.road[i] >= 1)).length;
  const upgraded = plan.length - fresh;
  const what =
    fresh === 0
      ? `Upgrades the existing dirt track in place: ${plural(plan.length, 'tile')} become paving.`
      : upgraded > 0
        ? `Upgrades ${plural(upgraded, 'tile')} of the existing dirt track in place and lays ${plural(fresh, 'tile')} of new paving.`
        : `Lays ${plural(fresh, 'tile')} of new paving.`;
  const fx = safe(() => paveEffect(s, plan), []);
  const trips = fx.slice(0, 4).map((e) => {
    const via = e.via.length ? ` (via ${e.via.map((t) => townName(s, t)).join(', ')})` : '';
    const fr = e.freightNow > 0 && e.freightPaved >= 0 ? `, freight ${fmtPrice(e.freightNow)} → ${fmtPrice(e.freightPaved)} a unit` : '';
    return `${townName(s, e.a)}–${townName(s, e.b)}${via} ${e.daysNow.toFixed(2)} → ${e.daysPaved.toFixed(2)} days${fr}`;
  });
  const speed = `Wagons and walkers cover about ${SPEED_PAVED} tiles a day on paving against ${SPEED_DIRT} on dirt.`;
  if (!trips.length) return `${what} ${speed}`;
  return `${what} ${speed} Trips it speeds up: ${trips.join('; ')}. Cheaper carrying lets the trading houses move more between these towns, so their prices draw closer.`;
}

/**
 * What running a new workplace as the Treasury's own means (agents/works.ts): where its output goes,
 * and which of the Treasury's workplaces it would draw its materials from — or supply.
 */
function runByTreasuryText(s: SimState, sector: string, town: number): string {
  const d = SECTORS[sector as keyof typeof SECTORS];
  if (!d || !d.producer) return 'It hires, buys and sells like any firm; its profits flow to the Purse.';
  const tn = townName(s, town);
  const own = s.firms.filter((f) => isWorks(f));
  const parts: string[] = [`The Treasury runs it as its own: what it makes goes to your stores in ${tn}, sold at the going price by a standing order (price it at 0 to hand it out free); the Purse pays its wages and materials.`];
  for (const [g] of d.inputs) {
    const here = own.find((f) => f.town === town && SECTORS[f.sector]?.out === g);
    const there = here ? undefined : own.find((f) => SECTORS[f.sector]?.out === g);
    const what = GOODS[g]?.name.toLowerCase() ?? 'materials';
    if (here) parts.push(`It draws its ${what} from your ${SECTORS[here.sector].name} here first.`);
    else if (there) parts.push(`It draws its ${what} from your ${SECTORS[there.sector].name} in ${townName(s, there.town)}, carried in as it needs it.`);
  }
  const users = own.filter((f) => f.town === town && SECTORS[f.sector]?.inputs.some(([g]) => g === d.out));
  if (users.length) parts.push(`Your ${users.map((f) => SECTORS[f.sector].name).join(' and ')} here will draw on what it makes.`);
  return parts.join(' ');
}

export function buildLever(): Lever {
  let kind: BKind = 'road';
  let grade: 1 | 2 = 2;
  let from = 0;
  let to = 1;
  let town = 0;
  let sector: Sector = 'bakery';
  let firmId = -1;
  let wagons = 4;
  let fare: LineFare = 'cost';
  let staffing: LineStaffing = 'asNeeded';
  let farePrice = 0.2;
  let marginPct = 10; // 'cost': markup over the line's cost, 'under': below the houses' own freight (%)
  let last: SimState | null = null;
  let planKey = '';
  let plan: number[] = [];
  const msg = msgLine();
  const changed = () => {
    msg.clear();
    paint();
  };

  const kindSeg = segmented<BKind>({
    options: [
      { value: 'road', label: 'Road', title: 'A road between two towns, or between any two places you draw on the map: paved, or a dirt track' },
      { value: 'house', label: 'Houses', title: `A block of ${HOUSE_SLOTS} homes the Treasury lets` },
      { value: 'firm', label: 'Workshop', title: 'A Treasury-owned workplace of any trade' },
      { value: 'pier', label: 'Pier', title: 'More room for foreign ships at the port' },
      { value: 'expand', label: 'Enlarge', title: 'Add a level to a Treasury workshop' },
      { value: 'line', label: 'Freight line', title: 'Treasury wagons carrying the trading houses’ goods between two towns' },
    ],
    value: kind,
    full: true,
    size: 'sm',
    onChange: (v) => ((kind = v), msg.clear(), changed()),
  });
  const fromSel = selectInput<number>({ options: [{ value: 0, label: '—' }], value: from, onChange: (v) => ((from = v), changed()) });
  const toSel = selectInput<number>({ options: [{ value: 1, label: '—' }], value: to, onChange: (v) => ((to = v), changed()) });
  const townSel = selectInput<number>({ options: [{ value: 0, label: '—' }], value: town, onChange: (v) => ((town = v), changed()) });
  const sectorSel = selectInput<Sector>({ options: sectorOpts(), value: sector, onChange: (v) => ((sector = v), changed()) });
  const firmSel = selectInput<number>({ options: [{ value: -1, label: 'No Treasury workshops yet' }], value: -1, onChange: (v) => ((firmId = v), changed()) });

  const routeRow = row('Between', fromSel.el, h('span', { class: 'lv-w' }, 'and'), toSel.el);
  const gradeSeg = segmented<1 | 2>({
    options: [
      { value: 2, label: 'Paved', title: 'Paving: the fastest going; over new ground it clears a track first' },
      { value: 1, label: 'Dirt track', title: 'A cleared dirt track: cheap, slower than paving, much faster than open country' },
    ],
    value: grade,
    size: 'sm',
    onChange: (v) => ((grade = v), (planKey = ''), changed()),
  });
  const gradeRow = row('Surface', gradeSeg.el);
  const drawRoad = button({ label: 'Draw on map', kind: 'secondary', title: 'Click where the road starts and where it ends — anywhere on the map; Esc cancels', icon: icon('target', 14), onClick: () => startPlacing() });
  // freight line
  const wagonsIn = numberInput({ value: wagons, min: 1, max: LINE_MAX_WAGONS, integer: true, unit: 'wagons', width: '120px', onChange: (v) => ((wagons = v), changed()) });
  const fareSeg = segmented<LineFare>({
    options: [
      { value: 'cost', label: 'Cost +', title: 'Traders pay what the line’s recent trips cost per unit carried, plus your margin (0 % = at cost)' },
      { value: 'under', label: 'Undercut', title: 'Traders pay what their own wagons would cost them on each leg, less your share: they always come out ahead, and the Treasury keeps the rest of what the line saves' },
      { value: 'fixed', label: 'Fixed', title: 'Traders pay a set amount per unit carried' },
      { value: 'free', label: 'Free', title: 'Traders pay nothing: the Purse pays all its running costs' },
    ],
    value: fare,
    size: 'sm',
    onChange: (v) => ((fare = v), changed()),
  });
  const fareIn = numberInput({ value: farePrice, min: 0, max: LINE_MAX_FARE, prefix: '¤', unit: 'a unit', width: '120px', onChange: (v) => ((farePrice = v), changed()) });
  const marginIn = numberInput({ value: marginPct, min: LINE_MARGIN_MIN * 100, max: LINE_MARGIN_MAX * 100, unit: '%', width: '96px', onChange: (v) => ((marginPct = v), changed()) });
  const staffSeg = segmented<LineStaffing>({
    options: [
      { value: 'asNeeded', label: 'As needed', title: 'As many drivers as the loads need; when the wagons stand idle they join the town’s works crew' },
      { value: 'permanent', label: 'Permanent, one a wagon', title: 'One driver per wagon, kept on while the line runs (or is paused): never moved to the building sites, the last let go' },
    ],
    value: staffing,
    size: 'sm',
    onChange: (v) => ((staffing = v), changed()),
  });
  const wagonsRow = row('Wagons', wagonsIn.el);
  const staffRow = row('Drivers', staffSeg.el);
  const fareRow = row('Traders pay', fareSeg.el, fareIn.el, marginIn.el);
  const townRow = dynRow('Town', townSel.el);
  const sectorRow = row('Trade', sectorSel.el);
  const firmRow = row('Workshop', firmSel.el);

  const whatT = h('div', { class: 'lv-what-t' });
  const whatD = h('div', { class: 'lv-what-d' });
  const costV = h('span', { class: 'lv-what-cost' });
  const matsV = h('div', { class: 'lv-what-m' });
  const what = h('div', { class: 'lv-what' }, h('div', { class: 'lv-what-head' }, whatT, costV), whatD, matsV);

  const placingNote = banner('info', icon('target', 16), h('div', { class: 'lv-banner-body' }, h('span', { class: 'lv-placing-t' }), ' ', button({ label: 'Cancel', kind: 'ghost', size: 'sm', onClick: () => setPlacing(null) })));
  const showRoute = button({ label: 'Show route', kind: 'ghost', size: 'sm', icon: icon('target', 14), onClick: () => showOnMap() });
  const pickSite = button({ label: 'Choose on map', kind: 'secondary', title: 'Click a spot on the map; Esc cancels', icon: icon('target', 14), onClick: () => startPlacing() });
  const go = submitButton('Commission');
  const crewSw = toggle({ value: autoCrewOn(), title: 'After commissioning, the town employs as many Treasury workers as its Treasury projects can use (the going wage + 10%) and lets them go as the projects finish', onChange: (v) => setAutoCrew(v) });
  const crewRow = row('Crew', h('span', { class: 'lv-crew' }, crewSw.el, h('span', { class: 'lv-hint-inline' }, 'Staff it with Treasury workers automatically — see the Works tab')));
  const preview = h('div', { class: 'lv-preview' });

  const projects = projectList({ empty: 'No Treasury projects yet. Anything commissioned here appears with its progress.' });
  const projCount = h('span', { class: 'lv-sub-v' });
  const lines = lineList({ empty: 'No freight lines. Choose Freight line above to run Treasury wagons between two towns.' });
  const lineCount = h('span', { class: 'lv-sub-v' });
  const linesHead = subhead('Treasury freight lines', lineCount);

  const form = formEl(() => submit(), h('div', { class: 'lv-row lv-row-full' }, kindSeg.el), gradeRow, routeRow, wagonsRow, staffRow, fareRow, townRow.el, sectorRow, firmRow, what, crewRow, placingNote, formFoot(preview, msg, showRoute, drawRoad, pickSite, go));
  const body = h('div', { class: 'lv-body-in' }, form, h('div', { class: 'lv-sep' }), linesHead, lines.el, subhead('Treasury projects', projCount), projects.el);

  on('placing', () => last && paint());

  function treasuryFirms(s: SimState) {
    return s.firms.filter((f) => f && f.alive && f.status !== 'closed' && f.owner === STATE && f.building >= 0 && !!s.buildings[f.building]);
  }

  function projKind(): ProjectKind {
    return kind === 'expand' ? 'expand' : kind === 'line' ? 'road' : kind;
  }

  /** The plot the builders would choose: bought from the town's council when it lies within the town. */
  let plotKey = '';
  let plotMemo = '';
  function plotText(s: SimState, what: Sector | 'house', t: TownId): string {
    const k = `${what}:${t}:${s.day}`;
    if (k === plotKey) return plotMemo;
    plotKey = k;
    const xy = safe(() => findSite(s, what, t), null as { x: number; y: number } | null);
    const [w, hh] = what === 'house' ? [1, 1] : (SECTORS[what]?.footprint ?? [1, 1]);
    const p = xy ? safe(() => plotPrice(s, xy.x, xy.y, w, hh), { town: -1, price: 0 }) : { town: -1, price: 0 };
    plotMemo = !xy
      ? ''
      : p.town >= 0 && p.price > 0.5
        ? ` The plot is ${townName(s, p.town)}’s land: about ${fmtM(p.price)} more, paid to its council when the works start (less on a site you pick further out).`
        : ' The site lies beyond the town: its land is free.';
    return plotMemo;
  }

  function cost(s: SimState): { money: number; need: Materials; tiles: number } {
    let tiles = 0;
    let t = town;
    let sec: Sector | undefined;
    if (kind === 'road') {
      const key = `${from}>${to}:${grade}:${s.day}`;
      if (key !== planKey) {
        planKey = key;
        plan = from === to ? [] : grade === 1 ? safe(() => trackPlan(s, townCentreTile(s, from), townCentreTile(s, to), 1).tiles, [] as number[]) : safe(() => roadPlan(s, from, to), [] as number[]);
      }
      const need = safe(() => roadNeed(s, plan, grade), { labor: 0, wood: 0, iron: 0, tools: 0 });
      return { money: fin(safe(() => needCost(s, from, need), 0)), need, tiles: plan.length };
    } else if (kind === 'firm') sec = sector;
    else if (kind === 'expand') {
      const f = s.firms[firmId];
      if (!f) return { money: 0, need: { labor: 0, wood: 0, iron: 0, tools: 0 }, tiles: 0 };
      t = f.town;
      sec = f.sector;
    }
    const need = safe(() => projectNeed(projKind(), sec ?? '', tiles), { labor: 0, wood: 0, iron: 0, tools: 0 });
    const money = safe(() => estimateCost(s, projKind(), t, sec, tiles), 0);
    return { money: fin(money), need, tiles };
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    kindSeg.set(kind);
    const ports = s.towns.filter((t) => t.hasPort);
    fromSel.setOptions(townOptions(s), from);
    toSel.setOptions(townOptions(s), to);
    from = fromSel.value;
    to = toSel.value;
    const tOpts = kind === 'pier' ? ports.map((t) => ({ value: t.id, label: t.name })) : townOptions(s);
    townSel.setOptions(tOpts.length ? tOpts : [{ value: 0, label: 'No harbour' }], town);
    town = townSel.value;
    const tf = treasuryFirms(s);
    firmSel.setOptions(
      tf.length ? tf.map((f) => ({ value: f.id, label: `${f.name} · ${townName(s, f.town)} · level ${s.buildings[f.building]?.level ?? 1}` })) : [{ value: -1, label: 'No Treasury workshops yet' }],
      firmId,
    );
    firmId = firmSel.value;

    show(routeRow, kind === 'road' || kind === 'line');
    show(gradeRow, kind === 'road');
    show(drawRoad, kind === 'road');
    gradeSeg.set(grade);
    show(wagonsRow, kind === 'line');
    show(staffRow, kind === 'line');
    show(fareRow, kind === 'line');
    show(fareIn.el, fare === 'fixed');
    show(marginIn.el, fare === 'cost' || fare === 'under');
    marginIn.el.title = fare === 'under' ? 'How far below the trading houses’ own freight (0 to 90 %)' : 'Your margin over what the line’s trips cost (0 % = at cost; below 0 the Purse pays part)';
    fareSeg.set(fare);
    show(townRow.el, kind === 'house' || kind === 'firm' || kind === 'pier');
    setText(townRow.lab, kind === 'pier' ? 'Harbour' : 'Town');
    show(sectorRow, kind === 'firm');
    show(firmRow, kind === 'expand');
    const sited = kind === 'house' || kind === 'firm' || kind === 'pier';
    show(pickSite, sited);
    show(showRoute, kind === 'road' || kind === 'line');
    show(crewRow, kind !== 'line');
    setText(go, sited ? 'Let builders choose' : kind === 'line' ? 'Open the line' : 'Commission');
    go.title = sited ? 'The builders pick a free site near the town (Enter)' : kind === 'line' ? 'Open the freight line (Enter)' : 'Queue it with the builders (Enter)';
    const nLines = freightLines(s).length;
    setText(lineCount, nLines ? String(nLines) : '');
    show(linesHead, nLines > 0 || kind === 'line');
    show(lines.el, nLines > 0 || kind === 'line');
    lines.update(s);
    if (kind === 'line') {
      paintLine(s);
      paintProjects(s);
      return;
    }

    const c = cost(s);
    const purse = fin(s.treasury.purse);
    let title = '';
    let desc = '';
    let ok = true;
    switch (kind) {
      case 'road':
        title = `${grade === 1 ? 'Track' : 'Paved road'} ${townName(s, from)} – ${townName(s, to)}`;
        if (from === to) {
          desc = 'Choose two different towns — or draw the road anywhere on the map.';
          ok = false;
        } else if (c.tiles === 0) {
          desc = grade === 1 ? 'A road already runs between these towns (or there is no way through). Draw a new one on the map to take another way.' : 'This road is already paved all the way (or there is no route).';
          ok = false;
        } else desc = grade === 1 ? trackText(s, plan) : roadText(s, plan);
        break;
      case 'house':
        title = `Treasury houses in ${townName(s, town)}`;
        desc = `A block of ${HOUSE_SLOTS} homes. The Treasury is the landlord: rent flows to the Purse.` + plotText(s, 'house', town);
        break;
      case 'firm':
        title = `Treasury ${SECTORS[sector]?.name ?? 'workshop'} in ${townName(s, town)}`;
        desc = recipe(sector) + ' ' + runByTreasuryText(s, sector, town) + plotText(s, sector, town);
        break;
      case 'pier':
        if (!ports.length) {
          title = 'Pier';
          desc = 'This realm has no harbour.';
          ok = false;
        } else {
          title = `New pier at ${townName(s, town)}`;
          desc = `Each pier adds ${fmtPct(PIER_CAP_BONUS)} to the room foreign ships have to trade each day. Piers now: ${fmtNum(fin(s.foreign?.piers))}.`;
        }
        break;
      case 'expand': {
        const f = s.firms[firmId];
        if (!f) {
          title = 'Enlarge a Treasury workshop';
          desc = 'The Treasury owns no workshops yet. Commission one first, then enlarge it here.';
          ok = false;
        } else {
          title = `Enlarge ${f.name}`;
          desc = `Adds a level: room for ${plural(SECTORS[f.sector]?.capacityPerLevel ?? 0, 'more worker')}.`;
        }
        break;
      }
    }
    setText(whatT, title);
    setText(whatD, desc);
    setText(costV, ok && c.money > 0 ? `≈ ${fmtM(c.money)}` : '');
    setText(matsV, ok ? matText(c.need) : '');
    show(matsV, ok && !!matText(c.need));

    const B = (x: string, cls?: string) => h('b', { class: cls ?? null }, x);
    if (!ok) preview.replaceChildren();
    else {
      const short = !s.treasury.autoMint && c.money > purse;
      preview.replaceChildren(
        'Billed as the work proceeds. Purse ',
        B(fmtM(purse), short ? 'warn' : ''),
        short ? h('span', { class: 'warn' }, ' — work stalls whenever the bills cannot be paid.') : '.',
      );
    }
    go.disabled = !ok;
    pickSite.disabled = !ok;

    // placement mode note
    const p = ui.placing;
    show(placingNote, !!p);
    if (p && p.kind === 'road') {
      const t = placingNote.querySelector('.lv-placing-t');
      const road = p.grade === 1 ? 'track' : 'paved road';
      if (t) setText(t, p.a === undefined || p.a < 0 ? `Click the map where the ${road} starts — a town, a building or open ground.` : `Now click where it ends: the planned way and its cost follow the pointer. Esc cancels.`);
    } else if (p) {
      const t = placingNote.querySelector('.lv-placing-t');
      const what2 = p.kind === 'house' ? 'the houses' : p.kind === 'pier' ? 'the pier' : `the ${SECTORS[p.sector as Sector]?.name ?? 'workshop'}`;
      if (t) setText(t, `Click the map to choose a site for ${what2}${p.town !== undefined ? ' near ' + townName(s, p.town) : ''}. Esc cancels.`);
    }

    paintProjects(s);
  }

  function paintProjects(s: SimState): void {
    setText(projCount, (() => {
      const n = treasuryProjects(s).filter((x) => x.status !== 'done').length;
      return n ? `${n} under way` : '';
    })());
    projects.set(s);
  }

  /** The freight-line composer: what it is, what it costs to run, what the traders pay today. */
  function paintLine(s: SimState): void {
    const B = (x: string, cls?: string) => h('b', { class: cls ?? null }, x);
    const A = townName(s, from);
    const Bn = townName(s, to);
    const est = from !== to ? safe(() => estimateLine(s, from, to, wagons), null) : null;
    const dup = from !== to ? safe(() => lineBetween(s, from, to), undefined) : undefined;
    const n = Math.max(1, Math.round(fin(wagons, 1)));
    let ok = true;
    let desc = '';
    setText(whatT, `Freight line ${A} ⇄ ${Bn}`);
    if (from === to) {
      desc = 'Choose two different towns.';
      ok = false;
    } else if (!est || !est.ok) {
      desc = `No wagon road links ${A} and ${Bn}.`;
      ok = false;
    } else if (dup) {
      desc = `A Treasury freight line already runs between ${A} and ${Bn}: change its fare or its wagons below.`;
      ok = false;
    } else if (!wagonsIn.valid || (fare === 'fixed' && !fareIn.valid) || ((fare === 'cost' || fare === 'under') && !marginOk())) {
      desc = 'Check the numbers.';
      ok = false;
    } else {
      desc =
        `The Treasury keeps ${plural(n, 'wagon')} in ${A} (${TOOLS_PER_WAGON} tool sets each, bought there), ${staffing === 'permanent' ? `each with its own driver — ${plural(n, 'Treasury worker')} hired there and kept on, whatever the loads` : 'drives them with Treasury workers hired there as the loads need them'}, and buys their oil there. ` +
        `The trading houses of both towns load their goods onto it when it is cheaper than their own wagons, and pay ${fare === 'free' ? 'nothing' : fare === 'fixed' ? `${fmtM(farePrice)} a unit` : fare === 'under' ? `${fmtNum(marginPct)} % less than their own wagons would cost them on each leg — they always come out ahead, and the Treasury keeps the rest of what the line saves` : marginPct !== 0 ? `what its recent trips cost per unit carried ${marginPct > 0 ? 'plus' : 'less'} ${fmtNum(Math.abs(marginPct))} %` : 'what its recent trips cost per unit carried'}. The Treasury’s own goods between the two towns ride it too.`;
    }
    setText(whatD, desc);
    setText(costV, ok && est ? `≈ ${fmtM(n * est.wagonCost)}` : '');
    costV.title = ok ? 'The wagons: tools bought in the depot town (the Treasury’s own tools there are used first)' : '';
    const held = fin(s.treasury.goods[from]?.[TOOLS]);
    setText(matsV, ok && est ? `${plural(n * TOOLS_PER_WAGON, 'tool set')} for the wagons${held > 0.5 ? ` (${fmtNum(held)} held in ${A})` : ''} · ${fmtNum(est.days, 1)} days each way · drivers ${fmtM(est.wage)} a day` : '');
    show(matsV, ok && !!est);
    if (!ok || !est) preview.replaceChildren();
    else {
      const own = safe(() => freightPerUnit(s, from, to), -1);
      const back = safe(() => freightPerUnit(s, to, from), -1);
      preview.replaceChildren(
        'Trading houses’ own wagons today: ',
        B(own >= 0 ? fmtM(own) : '—'),
        ` a unit ${A} → ${Bn}, `,
        B(back >= 0 ? fmtM(back) : '—'),
        ' back (a full wagon; part loads cost them more). The line: ',
        B(fmtM(est.perUnit)),
        ' a unit in full wagons; about ',
        B(fmtM(est.perDay)),
        ' a day with every wagon on the road (drivers, oil, wear), ',
        B(fmtM(est.idleDay)),
        ` standing. A wagon carries ${WAGON_CAPACITY}.`,
        ...earnText(own, back, est.perUnit),
      );
    }
    go.disabled = !ok;
    pickSite.disabled = true;
    show(placingNote, !!ui.placing);
  }

  function marginOk(): boolean {
    if (!marginIn.valid) return false;
    return fare === 'under' ? marginPct >= 0 && marginPct <= LINE_UNDER_MAX * 100 : marginPct >= LINE_MARGIN_MIN * 100 && marginPct <= LINE_MARGIN_MAX * 100;
  }

  /** What the Treasury would keep a unit carried in full wagons, by the fare chosen. */
  function earnText(own: number, back: number, perUnit: number): (string | HTMLElement)[] {
    if (!(perUnit > 0)) return [];
    const Bx = (x: string, cls?: string) => h('b', { class: cls ?? null }, x);
    let keep: number;
    if (fare === 'free') keep = -perUnit;
    else if (fare === 'fixed') keep = farePrice - perUnit;
    else if (fare === 'cost') keep = (perUnit * marginPct) / 100;
    else {
      const legs = [own, back].filter((x) => x > 0);
      if (!legs.length) return [];
      keep = legs.reduce((a, x) => a + x * (1 - marginPct / 100), 0) / legs.length - perUnit;
    }
    return [' The Treasury keeps about ', Bx(fmtM(keep), keep >= 0 ? 'good' : 'warn'), ' a unit carried in full wagons, before its drivers’ idle days and the wagons’ standing wear.'];
  }

  function showOnMap(): void {
    const s = last;
    if (!s) return;
    if (plan.length) {
      const mid = plan[Math.floor(plan.length / 2)];
      centerMap(mid % s.map.w, Math.floor(mid / s.map.w));
    } else {
      const a = s.towns[from];
      const b = s.towns[to];
      if (a && b) centerMap((a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  }

  function startPlacing(): void {
    const s = last;
    if (!s) return;
    if (kind === 'road') {
      setPlacing({ kind: 'road', grade });
      paint();
      return;
    }
    if (kind !== 'house' && kind !== 'firm' && kind !== 'pier') return;
    setPlacing({ kind, town, sector: kind === 'firm' ? sector : undefined });
    const t = s.towns[town];
    if (t) centerMap(t.x, t.y);
    paint();
  }

  function submit(): void {
    const s = last;
    if (!s) return;
    let r;
    switch (kind) {
      case 'road':
        r = run({ type: 'build', kind: 'road', from, to, grade }, msg, '✓ Commissioned — see Treasury projects below.');
        break;
      case 'house':
      case 'pier':
        r = run({ type: 'build', kind, town }, msg, '✓ Commissioned — see Treasury projects below.');
        break;
      case 'firm':
        r = run({ type: 'build', kind: 'firm', sector, town }, msg, '✓ Commissioned — see Treasury projects below.');
        break;
      case 'expand':
        if (firmId < 0) return msg.err('The Treasury owns no workshop to enlarge.');
        r = run({ type: 'build', kind: 'expand', firm: firmId }, msg, '✓ Commissioned — see Treasury projects below.');
        break;
      case 'line':
        if (!wagonsIn.valid) return msg.err(`The number of wagons must be a whole number from 1 to ${LINE_MAX_WAGONS}.`);
        if (fare === 'fixed' && !fareIn.valid) return msg.err('Set the fare per unit.');
        if ((fare === 'cost' || fare === 'under') && !marginOk()) return msg.err(fare === 'under' ? 'Undercut the trading houses by 0 to 90 %.' : 'Set the margin over cost (−90 % to +500 %).');
        r = run(
          { type: 'openLine', a: from, b: to, wagons: Math.round(wagons), fare, farePrice: fare === 'fixed' ? farePrice : undefined, margin: fare === 'cost' || fare === 'under' ? marginPct / 100 : undefined, staffing },
          msg,
          '✓ Line opened — see Treasury freight lines below.',
        );
        break;
    }
    if (r?.ok) {
      planKey = '';
      if (kind !== 'line') {
        const t = kind === 'road' ? from : kind === 'expand' ? (s.firms[firmId]?.town ?? -1) : town;
        ensureCrew(s, t);
      }
    }
  }

  return {
    id: 'build',
    title: 'Build',
    tagline: 'Roads, houses, workshops, piers, freight lines',
    body,
    summary(s) {
      const live = s.projects.filter((p) => p && p.owner === STATE && p.status !== 'done' && p.status !== 'cancelled');
      const stalled = live.filter((p) => p.status === 'stalled').length;
      const nl = freightLines(s).length;
      const lineText = nl ? plural(nl, 'freight line') : '';
      if (!live.length) return { text: lineText || 'No projects' };
      return { text: plural(live.length, 'project') + (stalled ? ` · ${stalled} stalled` : '') + (lineText ? ` · ${lineText}` : ''), tone: stalled ? 'warn' : null };
    },
    update(s) {
      if (last !== s && s.towns.length > 1 && from === to) to = (from + 1) % s.towns.length;
      last = s;
      paint();
    },
    prefill(req: PrefillRequest, s) {
      if (req.lever !== 'build') return false;
      last = s;
      if (req.kind) kind = req.kind;
      if (req.town !== undefined) {
        town = req.town;
        from = req.town;
        if (to === from && s.towns.length > 1) to = (from + 1) % s.towns.length;
      }
      if (req.sector && (BUILDABLE as string[]).includes(req.sector)) sector = req.sector as Sector;
      sectorSel.set(sector);
      paint();
      return true;
    },
    reset() {
      planKey = '';
      last = null;
      firmId = -1;
    },
  };
}
