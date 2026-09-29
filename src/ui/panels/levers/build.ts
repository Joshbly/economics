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
import { LINE_MAX_FARE, LINE_MAX_WAGONS, PIER_CAP_BONUS, SPEED_DIRT, SPEED_PAVED, TOOLS_PER_WAGON, WAGON_CAPACITY } from '../../../sim/config';
import { freightPerUnit } from '../../../sim/agents/traders';
import { estimateLine, lineBetween } from '../../../sim/policy/lines';
import type { LineFare } from '../../../sim/types';
import { estimateCost, projectNeed } from '../../../sim/agents/construction';
import { GOODS, HOUSE_SLOTS, SECTORS } from '../../../sim/goods';
import { roadPlan } from '../../../sim/world/paths';
import { paveEffect } from '../../../sim/world/roadEffect';
import { STATE, type Materials, type ProjectKind, type Sector, type SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtNum, fmtPct, fmtPrice, plural } from '../../format';
import { centerMap, on, setPlacing, ui, type PrefillRequest } from '../../uiState';
import { button, icon, numberInput, segmented, selectInput, townOptions, type Option } from '../../widgets';
import { banner, dynRow, fin, fmtM, formEl, formFoot, msgLine, row, run, safe, subhead, submitButton, townName, type Lever } from './common';
import { projectList, treasuryProjects } from './projects';
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

export function buildLever(): Lever {
  let kind: BKind = 'road';
  let from = 0;
  let to = 1;
  let town = 0;
  let sector: Sector = 'bakery';
  let firmId = -1;
  let wagons = 4;
  let fare: LineFare = 'cost';
  let farePrice = 0.2;
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
      { value: 'road', label: 'Road', title: 'Pave the track between two towns' },
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
  // freight line
  const wagonsIn = numberInput({ value: wagons, min: 1, max: LINE_MAX_WAGONS, integer: true, unit: 'wagons', width: '120px', onChange: (v) => ((wagons = v), changed()) });
  const fareSeg = segmented<LineFare>({
    options: [
      { value: 'cost', label: 'At cost', title: 'Traders pay what the line’s recent trips cost per unit carried' },
      { value: 'fixed', label: 'Fixed', title: 'Traders pay a set amount per unit carried' },
      { value: 'free', label: 'Free', title: 'Traders pay nothing: the Purse pays all its running costs' },
    ],
    value: fare,
    size: 'sm',
    onChange: (v) => ((fare = v), changed()),
  });
  const fareIn = numberInput({ value: farePrice, min: 0, max: LINE_MAX_FARE, prefix: '¤', unit: 'a unit', width: '120px', onChange: (v) => ((farePrice = v), changed()) });
  const wagonsRow = row('Wagons', wagonsIn.el);
  const fareRow = row('Traders pay', fareSeg.el, fareIn.el);
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
  const preview = h('div', { class: 'lv-preview' });

  const projects = projectList({ empty: 'No Treasury projects yet. Anything commissioned here appears with its progress.' });
  const projCount = h('span', { class: 'lv-sub-v' });
  const lines = lineList({ empty: 'No freight lines. Choose Freight line above to run Treasury wagons between two towns.' });
  const lineCount = h('span', { class: 'lv-sub-v' });
  const linesHead = subhead('Treasury freight lines', lineCount);

  const form = formEl(() => submit(), h('div', { class: 'lv-row lv-row-full' }, kindSeg.el), routeRow, wagonsRow, fareRow, townRow.el, sectorRow, firmRow, what, placingNote, formFoot(preview, msg, showRoute, pickSite, go));
  const body = h('div', { class: 'lv-body-in' }, form, h('div', { class: 'lv-sep' }), linesHead, lines.el, subhead('Treasury projects', projCount), projects.el);

  on('placing', () => last && paint());

  function treasuryFirms(s: SimState) {
    return s.firms.filter((f) => f && f.alive && f.status !== 'closed' && f.owner === STATE && f.building >= 0 && !!s.buildings[f.building]);
  }

  function projKind(): ProjectKind {
    return kind === 'expand' ? 'expand' : kind === 'line' ? 'road' : kind;
  }

  function cost(s: SimState): { money: number; need: Materials; tiles: number } {
    let tiles = 0;
    let t = town;
    let sec: Sector | undefined;
    if (kind === 'road') {
      const key = `${from}>${to}:${s.day}`;
      if (key !== planKey) {
        planKey = key;
        plan = from === to ? [] : safe(() => roadPlan(s, from, to), [] as number[]);
      }
      tiles = plan.length;
      t = from;
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
    show(wagonsRow, kind === 'line');
    show(fareRow, kind === 'line');
    show(fareIn.el, fare === 'fixed');
    fareSeg.set(fare);
    show(townRow.el, kind === 'house' || kind === 'firm' || kind === 'pier');
    setText(townRow.lab, kind === 'pier' ? 'Harbour' : 'Town');
    show(sectorRow, kind === 'firm');
    show(firmRow, kind === 'expand');
    const sited = kind === 'house' || kind === 'firm' || kind === 'pier';
    show(pickSite, sited);
    show(showRoute, kind === 'road' || kind === 'line');
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
        title = `Paved road ${townName(s, from)} – ${townName(s, to)}`;
        if (from === to) {
          desc = 'Choose two different towns.';
          ok = false;
        } else if (c.tiles === 0) {
          desc = 'This road is already paved all the way (or there is no route).';
          ok = false;
        } else desc = roadText(s, plan);
        break;
      case 'house':
        title = `Treasury houses in ${townName(s, town)}`;
        desc = `A block of ${HOUSE_SLOTS} homes. The Treasury is the landlord: rent flows to the Purse.`;
        break;
      case 'firm':
        title = `Treasury ${SECTORS[sector]?.name ?? 'workshop'} in ${townName(s, town)}`;
        desc = recipe(sector) + ' It hires, buys and sells like any firm; its profits flow to the Purse.';
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
    if (p) {
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
    } else if (!wagonsIn.valid || (fare === 'fixed' && !fareIn.valid)) {
      desc = 'Check the numbers.';
      ok = false;
    } else {
      desc =
        `The Treasury keeps ${plural(n, 'wagon')} in ${A} (${TOOLS_PER_WAGON} tool sets each, bought there), drives them with Treasury workers hired there and buys their oil there. ` +
        `The trading houses of both towns load their goods onto it when it is cheaper than their own wagons, and pay ${fare === 'free' ? 'nothing' : fare === 'fixed' ? `${fmtM(farePrice)} a unit` : 'what its recent trips cost per unit carried'}. The Treasury’s own goods between the two towns ride it too.`;
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
      );
    }
    go.disabled = !ok;
    pickSite.disabled = true;
    show(placingNote, !!ui.placing);
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
        r = run({ type: 'build', kind: 'road', from, to }, msg, '✓ Commissioned — see Treasury projects below.');
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
        r = run({ type: 'openLine', a: from, b: to, wagons: Math.round(wagons), fare, farePrice: fare === 'fixed' ? farePrice : undefined }, msg, '✓ Line opened — see Treasury freight lines below.');
        break;
    }
    if (r?.ok) planKey = '';
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
