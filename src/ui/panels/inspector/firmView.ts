// ============================================================================
// Inspector: a workshop (any firm — producers, builders' yards, trading houses,
// Treasury works). Updates in place; keeps a small ring buffer of the firm's
// daily output, cash and price while it stays selected, drawn as sparklines.
// ============================================================================
import { GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import { STATE, type Firm, type Project, type SimState } from '../../../sim/types';
import { h } from '../../dom';
import { fmtDay, fmtDuration, fmtInt, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, fmtPrice, fmtQty, fmtRate } from '../../format';
import { focusMarket } from '../../uiState';
import { button, icon, type Tone } from '../../widgets';
import {
  block,
  buildingLink,
  debtMap,
  fin,
  firmRefOf,
  kvBlock,
  meter,
  miniTable,
  personLink,
  projectShare,
  qtyUnit,
  refKey,
  refLink,
  sectorName,
  townLink,
  type MiniRow,
} from './common';
import { hero, linkList, statStrip, statTile, type View } from './kit';

const RING = 180;
const ring = { id: -1, day: -1, out: [] as number[], cash: [] as number[], price: [] as number[] };

function pushRing(s: SimState, f: Firm, price: number): void {
  if (ring.id !== f.id) {
    ring.id = f.id;
    ring.day = -1;
    ring.out = [];
    ring.cash = [];
    ring.price = [];
  }
  if (ring.day === s.day) return;
  ring.day = s.day;
  const push = (a: number[], v: number) => {
    a.push(Number.isFinite(v) ? v : NaN);
    if (a.length > RING) a.shift();
  };
  const svc = !SECTORS[f.sector]?.producer;
  push(ring.out, svc ? f.workers.length : fin(f.producedToday));
  push(ring.cash, fin(f.cash));
  push(ring.price, price);
}

/** Reset the ring buffer (selection moved away). */
export function resetFirmRing(): void {
  ring.id = -1;
}

const STATUS: Record<string, [Tone | '', string]> = {
  active: ['good', 'Trading'],
  liquidating: ['bad', 'Winding up'],
  closed: ['', 'Closed'],
};

export function firmView(s0: SimState, id: number, viaBuilding = false): View {
  const f0 = s0.firms[id];
  const def = SECTORS[f0.sector];
  const out = def?.out ?? -1;
  const producer = !!def?.producer;
  const isTrader = !!f0.trade;
  const isBuilder = !!f0.build;
  const isState = f0.sector === 'stateworks';

  const hr = hero();

  // ---- stat strip ----
  const tOut = statTile(producer ? 'Made today' : 'Workers', true, producer ? 'Units made today (sparkline: daily since you opened this page)' : 'Workers employed');
  const tCash = statTile('Cash', true, 'Bank deposit');
  const tPrice = statTile(producer && out >= 0 ? `${GOODS[out].name} price` : isTrader ? 'Shipping rate' : 'Wage', true, producer ? 'Base price of its output in its town’s market' : undefined);
  const ringNote = h('div', { class: 'ins-ringnote' });

  // ---- workforce ----
  const wf = kvBlock();
  const rWorkers = wf.row('Workers', 'Employed now, the number it wants, and how many the building can hold');
  const rWage = wf.row('Posted wage', 'Gross wage per worker per day');
  const rVac = wf.row('Unfilled posts', 'Days in a row it has had posts nobody took');
  const rToday = wf.row('Today');
  const rTools = wf.row('Tools', 'Tools held vs tools needed for every worker to work at full pace');

  // ---- production ----
  const pr = kvBlock();
  const rMade = pr.row('Made today');
  const rMadeAvg = pr.row('Made, recent average');
  const rSold = pr.row('Sold, recent average');
  const rPExp = pr.row('Expected price', 'What it expects to receive per unit, after any levy on the seller');
  const rCost = pr.row('Cost per unit', 'Wages, materials, tool wear and interest per unit made');
  const rMargin = pr.row('Margin');
  const rProfit = pr.row('Profit, recent average', 'Per day');
  const rMonth = pr.row('Profit this month');

  // ---- money ----
  const mo = kvBlock();
  const rCash = mo.row('Cash');
  const rDebt = mo.row('Owes the bank');
  const rRev = mo.row('Today: received');
  const rSpent = mo.row('Today: spent', 'In markets (materials, tools), including levies it paid there');
  const rWages = mo.row('Today: wages', 'Including any levy the employer pays on wages');
  const rOther = mo.row('Today: other', 'Interest, rent, levies and fees');
  const loans = miniTable(
    [
      { label: 'Loan', align: 'left', width: '28%' },
      { label: 'Owed' },
      { label: 'Rate' },
      { label: 'Left' },
      { label: 'Late', title: 'Days a payment has been missed' },
    ],
    { empty: 'No loans' },
  );

  // ---- inventory ----
  const inv = miniTable(
    [
      { label: 'Good', align: 'left', width: '30%' },
      { label: 'Use', align: 'left', width: '18%' },
      { label: 'On hand' },
      { label: 'Per unit', title: 'Needed per unit of output' },
      { label: 'Days', title: 'Days of production the stock covers' },
    ],
    { empty: 'Nothing in store' },
  );

  // ---- trader ----
  const tr = kvBlock();
  const rWagons = tr.row('Wagons', 'Owned, and on the road now');
  const rBack = tr.row('Next wagon home');
  const rFreight = tr.row('Freight cost', '¤ per unit per tile travelled (recent average)');
  const rShipped = tr.row('Shipped today');
  const away = miniTable(
    [
      { label: 'Held in', align: 'left', width: '26%' },
      { label: 'Good', align: 'left', width: '22%' },
      { label: 'Units' },
      { label: 'Landed', title: 'Average cost per unit delivered (purchase + freight + levies)' },
      { label: 'Waiting', title: 'Days the stock has waited for a buyer' },
    ],
    { empty: 'No stock waiting in other towns' },
  );
  const transit = miniTable(
    [
      { label: 'On the road', align: 'left', width: '34%' },
      { label: 'Units' },
      { label: 'Route', align: 'left', width: '30%' },
      { label: 'Arrives' },
    ],
    { empty: 'No wagons on the road' },
  );

  // ---- builder ----
  const queueEl = h('div', { class: 'ins-queue' });
  let queueSig = '';
  const queueRows = new Map<number, ReturnType<typeof projectRow>>();

  // ---- workers ----
  const workers = linkList('No workers');

  const sections: (HTMLElement | null)[] = [
    hr.el,
    statStrip([tOut, tCash, tPrice]),
    ringNote,
    block('Workforce', null, wf.el),
    producer ? block('Making and selling', null, pr.el) : null,
    isTrader ? block('Wagons', null, tr.el, h('div', { class: 'ins-gap' }), away.el, h('div', { class: 'ins-gap' }), transit.el) : null,
    isBuilder || isState ? block(isState ? 'Treasury projects here' : 'Projects in hand', null, queueEl) : null,
    block('Money', null, mo.el, h('div', { class: 'ins-gap' }), loans.el),
    producer || isTrader || isBuilder ? block('In store', null, inv.el) : null,
    block('Workers', null, workers.el),
  ];
  const actions = h('div', { class: 'ins-actions' });
  if (producer && out >= 0) {
    actions.appendChild(button({ label: `${GOODS[out].name} market in ${s0.towns[f0.town]?.name ?? 'town'}`, size: 'sm', kind: 'secondary', icon: icon('chevronRight', 14), onClick: () => focusMarket(f0.town, out) }));
  }
  sections.splice(3, 0, actions.childElementCount ? actions : null);
  const el = h('div', { class: 'ins-view ins-firm' }, sections);

  function update(s: SimState): void {
    const f = s.firms[id];
    if (!f) return;
    const town = s.towns[f.town];
    const debts = debtMap(s);
    const debt = debts.get(firmRefOf(f.id)) ?? 0;
    const mk = out >= 0 ? s.markets?.[f.town * N_GOODS + out] : undefined;
    const price = mk ? fin(mk.price, NaN) : NaN;
    pushRing(s, f, producer ? price : isTrader ? fin(f.trade?.freightEma, NaN) : fin(f.wage, NaN));

    // hero
    hr.kicker(`${sectorName(f.sector)}${town ? ' · ' + town.name : ''}${viaBuilding ? ' · building' : ''}`);
    hr.title(f.name);
    const st = STATUS[f.status] ?? ['', f.status];
    const chips: [Tone | '', string, string?][] = [[st[0], f.alive ? st[1] : 'Closed']];
    if (f.owner === STATE) chips.push(['gold', 'Treasury-owned']);
    if (f.distress > 0) chips.push(['warn', `In distress ${f.distress} ${f.distress === 1 ? 'day' : 'days'}`, 'Unpaid wages or overdue loans. 20 days in a row and it fails.']);
    if (town && town.strikeDays > 0) chips.push(['bad', 'Town on strike']);
    if (town && town.droughtDays > 0 && f.sector === 'farm') chips.push(['warn', 'Drought']);
    if (f.lossDays > 30) chips.push(['warn', `Losing money ${fmtDuration(f.lossDays)}`]);
    hr.chips(chips);
    hr.sub.node(`${refKey(s, f.owner)}|${f.town}|${f.building}`, () => [
      f.owner === STATE ? 'Run by ' : 'Owned by ',
      refLink(s, f.owner),
      ' · ',
      townLink(s, f.town),
      f.building >= 0 && !viaBuilding ? [' · ', buildingLink(s, f.building, 'the building')] : null,
      Number.isFinite(f.founded) && f.founded > 0 ? ` · founded ${fmtDay(f.founded)}` : '',
    ]);

    // stat strip
    if (producer) {
      tOut.set(out >= 0 ? fmtQty(f.producedToday) : '—', `average ${fmtQty(f.output)}${out >= 0 ? ' ' + GOODS[out].unit + 's' : ''}`, undefined, ring.out);
      tPrice.set(fmtPrice(price), `cost ${fmtPrice(f.unitCost)} / unit`, undefined, ring.price);
    } else {
      tOut.set(fmtInt(f.workers.length), `wants ${fmtNum(Math.round(fin(f.target) * 10) / 10)}`, undefined, ring.out);
      if (isTrader) tPrice.set(fmtPrice(fin(f.trade?.freightEma) * 10), 'per unit, 10 tiles', undefined, ring.price);
      else tPrice.set(fmtPrice(f.wage), 'per worker per day', undefined, ring.price);
    }
    tCash.set(fmtMoneyShort(f.cash), debt > 0.5 ? `owes ${fmtMoneyShort(debt)}` : 'no debts', f.cash < 0 ? 'bad' : undefined, ring.cash);
    const n = ring.out.length;
    ringNote.textContent = n <= 1 ? 'Trend lines fill in day by day while this page stays open.' : `Trend lines: the last ${n} days, recorded while this page was open.`;

    // workforce
    const cap = Math.max(0, fin(f.capacity));
    rWorkers.text(`${fmtInt(f.workers.length)} of ${fmtNum(Math.round(fin(f.target) * 10) / 10)} wanted · room for ${isState ? 'any number' : fmtInt(cap)}`);
    rWage.text(fmtPrice(f.wage) + ' / day');
    rVac.text(f.vacancyDays > 0 ? `${fmtInt(f.vacancyDays)} ${f.vacancyDays === 1 ? 'day' : 'days'}` : 'none', f.vacancyDays > 10 ? 'warn' : undefined);
    rToday.text(`hired ${fmtInt(f.hired)} · let go ${fmtInt(f.fired)}`);
    const tpw = def?.toolsPerWorker ?? 0;
    const need = tpw * f.workers.length;
    rTools.show(tpw > 0);
    if (tpw > 0) {
      const share = need > 0 ? fin(f.tools) / need : 1;
      rTools.text(`${fmtNum(f.tools)} of ${fmtNum(need)} needed · ${fmtPct(Math.min(9.99, share))}`, share < 0.5 ? 'bad' : share < 0.9 ? 'warn' : undefined);
    }

    // production
    if (producer) {
      const u = out >= 0 ? GOODS[out].unit : 'unit';
      rMade.text(qtyUnit(out, fin(f.producedToday), fmtQty));
      rMadeAvg.text(`${fmtQty(f.output)} / day`);
      rSold.text(`${fmtQty(f.sales)} / day`);
      rPExp.text(`${fmtPrice(f.pExp)} / ${u}`);
      rCost.text(`${fmtPrice(f.unitCost)} / ${u}`);
      const margin = fin(f.pExp) - fin(f.unitCost);
      rMargin.text(`${fmtPrice(margin)}${f.pExp > 0 ? ` · ${fmtPct(margin / f.pExp)}` : ''}`, margin < 0 ? 'bad' : undefined);
      rProfit.text(`${fmtMoney(f.profit)} / day`, f.profit < 0 ? 'bad' : f.profit > 0 ? 'good' : undefined);
      rMonth.text(fmtMoney(f.monthProfit), f.monthProfit < 0 ? 'bad' : undefined);
    }

    // money
    rCash.text(fmtMoney(f.cash), f.cash < 0 ? 'bad' : undefined);
    rDebt.text(debt > 0.005 ? fmtMoney(debt) : 'nothing');
    rRev.text(fmtMoney(f.revenue));
    rSpent.text(fmtMoney(f.spent));
    rWages.text(fmtMoney(f.wageBill));
    rOther.text(fmtMoney(f.otherCosts));
    const ref = firmRefOf(f.id);
    loans.set(
      (s.loans ?? [])
        .filter((ln) => ln && ln.active && ln.borrower === ref)
        .map((ln) => ({
          key: ln.id,
          cells: [PURPOSE[ln.purpose] ?? ln.purpose, fmtMoneyShort(ln.principal), fmtRate(ln.rate), fmtDuration(ln.left), ln.overdue > 0 ? `${ln.overdue} d` : '—'],
          tones: [undefined, undefined, undefined, undefined, ln.overdue > 0 ? 'bad' : undefined],
        })),
    );

    // inventory
    const rows: MiniRow[] = [];
    const inputs = new Map<number, number>(def?.inputs ?? []);
    const perDay = Math.max(fin(f.output), 0.01);
    for (let g = 0; g < N_GOODS; g++) {
      const q = fin(f.inv?.[g]);
      const isIn = inputs.has(g);
      const isOut = g === out;
      if (q <= 0.005 && !isIn && !isOut) continue;
      const a = inputs.get(g) ?? 0;
      const cover = isIn && a > 0 ? q / (a * perDay) : NaN;
      rows.push({
        key: g,
        cells: [GOODS[g].name, isOut ? 'makes' : isIn ? 'needs' : g === 7 ? 'tools' : 'holds', fmtQty(q), isIn ? fmtNum(a) : '—', Number.isFinite(cover) ? fmtNum(Math.min(cover, 999)) : '—'],
        tones: [undefined, isOut ? 'gold' : undefined, undefined, undefined, isIn && cover < 1 ? 'bad' : isIn && cover < 3 ? 'warn' : undefined],
      });
    }
    inv.set(rows);

    // trader
    if (f.trade) {
      const t = f.trade;
      const busy = t.busy?.length ?? 0;
      rWagons.text(`${fmtInt(t.wagons)} owned · ${fmtInt(busy)} on the road`);
      const next = busy ? Math.min(...t.busy) - s.day : NaN;
      rBack.text(busy ? (next <= 0.5 ? 'today' : `in ${fmtDuration(next)}`) : 'all at home');
      rFreight.text(`${fmtPrice(t.freightEma)} / unit / tile`);
      rShipped.text(`${fmtQty(t.shippedToday)} units`);
      const aw: MiniRow[] = [];
      (t.stock ?? []).forEach((row, u) => {
        if (!row || u === f.town) return;
        row.forEach((q, g) => {
          if (!(q > 0.01)) return;
          aw.push({
            key: u * 100 + g,
            cells: [s.towns[u]?.name ?? '—', GOODS[g]?.name ?? '?', fmtQty(q), fmtPrice(t.basis?.[u]?.[g]), `${fmtInt(t.age?.[u]?.[g] ?? 0)} d`],
          });
        });
      });
      away.set(aw);
      transit.set(
        (s.shipments ?? [])
          .filter((sh) => sh && sh.owner === ref)
          .map((sh) => ({
            key: sh.id,
            cells: [GOODS[sh.good]?.name ?? '?', fmtQty(sh.qty), `${s.towns[sh.from]?.name ?? '?'} → ${s.towns[sh.to]?.name ?? '?'}`, sh.arrive - s.day <= 0.5 ? 'today' : `${fmtNum(Math.max(0, sh.arrive - s.day))} d`],
          })),
      );
    }

    // builder / Treasury works
    if (isBuilder || isState) {
      let projects: Project[];
      if (f.build) {
        const ids = f.build.queue ?? [];
        projects = ids.map((pid) => s.projects.find((p) => p.id === pid)).filter((p): p is Project => !!p);
      } else projects = (s.projects ?? []).filter((p) => p.owner === STATE && p.town === f.town && p.status !== 'done' && p.status !== 'cancelled');
      const sig = projects.map((p) => p.id).join(',');
      if (sig !== queueSig) {
        queueSig = sig;
        queueRows.clear();
        queueEl.replaceChildren(
          ...(projects.length
            ? projects.map((p) => {
                const r = projectRow(s, p);
                queueRows.set(p.id, r);
                return r.el;
              })
            : [h('div', { class: 'faint ins-para' }, isState ? 'No Treasury projects in this town. Treasury workers here help build anything you commission in the town — for free.' : 'Nothing queued. The yard hires when someone commissions a building.')]),
        );
      }
      for (const p of projects) queueRows.get(p.id)?.update(s, p);
    }

    // workers
    workers.set(
      f.workers.join(','),
      f.workers.map((pid) => () => personLink(s, pid)),
    );
  }

  return { el, update };
}

const PURPOSE: Record<string, string> = {
  working: 'Working capital',
  invest: 'Tools',
  startup: 'Start-up',
  house: 'House',
  project: 'Building',
};

const PSTATUS: Record<string, [Tone | '', string]> = {
  queued: ['', 'queued'],
  active: ['good', 'building'],
  stalled: ['warn', 'stalled'],
  done: ['good', 'done'],
  cancelled: ['', 'cancelled'],
};

/** One project in a builder's queue (also used by building views). */
export function projectRow(s0: SimState, p0: Project): { el: HTMLElement; update(s: SimState, p: Project): void } {
  const title = h('div', { class: 'ins-proj-title' });
  const chip = h('span', { class: 'chip ins-proj-chip' });
  const pct = h('span', { class: 'ins-proj-pct' });
  const bar = meter('wide');
  const mats = h('div', { class: 'ins-proj-mats' });
  const who = h('div', { class: 'ins-proj-who' });
  let whoKey = '';
  let titleKey = '';
  const el = h('div', { class: 'ins-proj' }, h('div', { class: 'ins-proj-head' }, title, chip, pct), bar.el, mats, who);
  function update(s: SimState, p: Project): void {
    const tk = p.building + '|' + p.label;
    if (tk !== titleKey) {
      titleKey = tk;
      title.replaceChildren(p.building >= 0 && s.buildings[p.building] ? buildingLink(s, p.building, p.label || 'Project') : document.createTextNode(p.label || 'Project'));
    }
    const [tone, txt] = PSTATUS[p.status] ?? ['', p.status];
    const waiting = fin(p.loanWanted) > 0;
    chip.textContent = waiting ? 'waiting for a loan' : txt;
    chip.className = 'chip ins-proj-chip' + (waiting ? ' warn' : tone ? ' ' + tone : '');
    const share = projectShare(p);
    pct.textContent = fmtPct(share, 0);
    bar.set(share, p.status === 'stalled' ? 'warn' : 'gold');
    const m = (k: 'labor' | 'wood' | 'iron' | 'tools', lab: string) => {
      const need = fin(p.need?.[k]);
      if (!(need > 0)) return null;
      const done = fin(p.done?.[k]);
      const ok = done >= need - 1e-6;
      return h('span', { class: ok ? 'ok' : '' }, `${lab} ${fmtInt(done)}/${fmtInt(need)}`);
    };
    mats.replaceChildren(...[m('labor', 'labour'), m('wood', 'wood'), m('iron', 'iron'), m('tools', 'tools')].filter(Boolean) as HTMLElement[]);
    const key = refKey(s, p.owner) + '|' + Math.round(p.billed);
    if (key !== whoKey) {
      whoKey = key;
      who.replaceChildren('Paid for by ', refLink(s, p.owner), ` · billed ${fmtMoneyShort(p.billed)}`, p.stalledDays > 0 ? ` · stalled ${p.stalledDays} d` : '');
    }
  }
  update(s0, p0);
  return { el, update };
}

