// ============================================================================
// Inspector: a town (and the market table shared with the market hall view).
// ============================================================================
import { ALL_SECTORS, GOODS, N_GOODS } from '../../../sim/goods';
import { STATE, type SimState } from '../../../sim/types';
import { h } from '../../dom';
import { fmtIndex, fmtInt, fmtMoneyShort, fmtPct, fmtPrice, fmtQty } from '../../format';
import { focusMarket, prefill } from '../../uiState';
import { button, kpi, kpiGrid, trend, type Kpi, type Tone } from '../../widgets';
import { block, fin, firmLink, kvBlock, miniTable, sectorName, type MiniRow, type MiniTable } from './common';
import { hero, type View } from './kit';

const KIND: Record<string, string> = { capital: 'The capital', farm: 'Farming town', mining: 'Mining town', harbor: 'Harbour town' };

/** Market prices of one town (click a row to open that market). */
export function marketTable(): { el: HTMLElement; update(s: SimState, town: number): void } {
  const t: MiniTable = miniTable(
    [
      { label: 'Good', align: 'left', width: '28%' },
      { label: 'Buyers pay', title: 'Last price paid by buyers, including any levy' },
      { label: 'Traded', title: 'Units that changed hands today' },
      { label: 'Today', align: 'right', width: '26%', title: 'Demand turned away (short) or supply left unsold (surplus)' },
    ],
    { empty: 'No markets' },
  );
  return {
    el: t.el,
    update(s, town) {
      const rows: MiniRow[] = [];
      for (let g = 0; g < N_GOODS; g++) {
        const m = s.markets?.[town * N_GOODS + g];
        if (!m) continue;
        const short = fin(m.shortage);
        const sur = fin(m.surplus);
        const vol = fin(m.volume);
        let note = m.traded ? '' : 'no trade';
        let tone: Tone = null;
        if (short > 0.05 && short >= sur) {
          note = `short ${fmtQty(short)}`;
          tone = 'bad';
        } else if (sur > 0.05) {
          note = `surplus ${fmtQty(sur)}`;
          tone = 'warn';
        }
        rows.push({
          key: g,
          cells: [GOODS[g].name, fmtPrice(m.gross || m.price), fmtQty(vol), note || '—'],
          tones: [undefined, undefined, undefined, tone ?? undefined],
          onClick: () => focusMarket(town, g),
          title: `Open the ${GOODS[g].name.toLowerCase()} market`,
          cls: m.traded ? '' : 'muted-row',
        });
      }
      t.set(rows);
    },
  };
}

export function townView(s0: SimState, id: number): View {
  const hr = hero();
  const tiles: Record<string, Kpi> = {
    pop: kpi({ label: 'Households', size: 'sm', format: fmtInt }),
    jobless: kpi({ label: 'Jobless', size: 'sm', format: (v) => fmtPct(v), good: 'down' }),
    posts: kpi({ label: 'Open posts', size: 'sm', format: fmtInt }),
    homeless: kpi({ label: 'Homeless', size: 'sm', format: fmtInt, good: 'down' }),
    wage: kpi({ label: 'Average wage', size: 'sm', format: fmtPrice, unit: '/day' }),
    rent: kpi({ label: 'Average rent', size: 'sm', format: fmtPrice, unit: '/day' }),
    cpi: kpi({ label: 'Prices', size: 'sm', format: fmtIndex, good: 'down', hint: 'The town’s consumer price index; 100 = when you took charge. Change over 30 days.' }),
    content: kpi({ label: 'Contentment', size: 'sm', format: (v) => fmtPct(v), good: 'up' }),
    health: kpi({ label: 'Health', size: 'sm', format: (v) => fmtPct(v), good: 'up' }),
  };
  const firms = miniTable(
    [
      { label: 'Workshop', align: 'left', width: '44%' },
      { label: 'Trade', align: 'left', width: '24%' },
      { label: 'Crew', title: 'Workers employed / room for' },
      { label: 'Wage', title: 'Posted wage per day' },
    ],
    { empty: 'No workshops', maxHeight: 360 },
  );
  const firmNote = h('div', { class: 'ins-para faint' });
  const market = marketTable();
  const homes = kvBlock();
  const rBlocks = homes.row('House blocks');
  const rSlots = homes.row('Homes let', 'Occupied slots of all home slots');
  const rVacant = homes.row('Empty slots');
  const rRent = homes.row('Average rent', 'Per occupied slot per day');
  const rState = homes.row('Treasury’s house blocks');
  const stores = miniTable(
    [
      { label: 'Treasury stores here', align: 'left', width: '50%' },
      { label: 'Units' },
      { label: 'Worth', title: 'At today’s local price' },
    ],
    { empty: 'The Treasury holds no goods in this town' },
  );
  const town0 = s0.towns[id];
  const el = h(
    'div',
    { class: 'ins-view ins-town' },
    hr.el,
    kpiGrid(Object.values(tiles), 3),
    block('Workshops', null, firms.el, firmNote),
    block('Market', button({ label: 'Go to Markets', size: 'sm', kind: 'secondary', onClick: () => focusMarket(id, 8) }), market.el, h('div', { class: 'ins-para faint' }, 'Click a good to open its market: the day’s bids and offers, and the price history.')),
    block('Homes', null, homes.el),
    block('Treasury', button({ label: 'Trade here', size: 'sm', kind: 'secondary', title: 'Open a Trade order in this town’s markets', onClick: () => prefill({ lever: 'trade', market: { kind: 'good', town: id, good: 8 } }) }), stores.el),
  );
  void town0;

  function update(s: SimState): void {
    const t = s.towns[id];
    if (!t) return;
    hr.kicker(KIND[t.kind] ?? 'Town');
    hr.title(t.name);
    const chips: [Tone | '', string, string?][] = [];
    if (t.hasPort) chips.push(['gold', 'Port', 'Foreign ships trade here']);
    if (t.strikeDays > 0) chips.push(['bad', `On strike · ${t.strikeDays} d`, 'Workers down tools when contentment stays very low']);
    else if (t.unrestDays > 0) chips.push(['warn', `Unrest · ${t.unrestDays} d`, 'Contentment has been very low; a strike may follow']);
    if (t.droughtDays > 0) chips.push(['warn', `Drought · ${t.droughtDays} d`, 'Farms here yield less']);
    hr.chips(chips);
    hr.sub.text(`${fmtInt(t.pop)} households · market at the centre`);

    const pop = Math.max(0, fin(t.pop));
    const cpiSeries = s.stats?.daily?.['cpi_' + id];
    const ctr = trend(cpiSeries, 30);
    tiles.pop.set(pop, { sub: `${fmtInt(t.employed)} in work` });
    tiles.jobless.set(pop > 0 ? t.unemployed / pop : NaN, { sub: `${fmtInt(t.unemployed)} households` });
    tiles.posts.set(t.vacancies);
    tiles.homeless.set(t.homeless, { tone: t.homeless > 0 ? 'bad' : null });
    tiles.wage.set(t.avgWage);
    tiles.rent.set(t.avgRent);
    tiles.cpi.set(t.cpi, { delta: Number.isFinite(ctr.rel) ? ctr.rel : null, deltaLabel: '30 d' });
    tiles.content.set(t.contentment, { tone: t.contentment < 0.35 ? 'bad' : null });
    tiles.health.set(t.health, { tone: t.health < 0.4 ? 'bad' : null });

    // workshops by trade
    const order = new Map(ALL_SECTORS.map((k, i) => [k, i]));
    const list = (s.firms ?? []).filter((f) => f && f.alive && f.town === id);
    list.sort((a, b) => (order.get(a.sector) ?? 99) - (order.get(b.sector) ?? 99) || b.workers.length - a.workers.length);
    firms.set(
      list.map((f) => ({
        key: f.id,
        cells: [{ key: 'f' + f.id, node: () => firmLink(s, f.id) }, sectorName(f.sector), f.sector === 'stateworks' ? fmtInt(f.workers.length) : `${fmtInt(f.workers.length)}/${fmtInt(f.capacity)}`, fmtPrice(f.wage)],
        tones: [undefined, f.owner === STATE ? 'gold' : undefined, undefined, undefined],
        cls: f.status === 'liquidating' ? 'muted-row' : '',
      })),
    );
    let vacant = 0;
    let building = 0;
    for (const b of s.buildings ?? []) {
      if (!b || b.town !== id || b.kind !== 'firm') continue;
      if (b.status === 'vacant') vacant++;
      else if (b.status === 'construction') building++;
    }
    firmNote.textContent = [vacant ? `${vacant} empty workshop ${vacant === 1 ? 'building' : 'buildings'} waiting for an owner` : '', building ? `${building} going up` : ''].filter(Boolean).join(' · ');
    firmNote.hidden = !firmNote.textContent;

    market.update(s, id);

    // homes
    let blocks = 0;
    let slots = 0;
    let let_ = 0;
    let stateBlocks = 0;
    for (const b of s.buildings ?? []) {
      if (!b || b.town !== id || b.kind !== 'house' || b.status !== 'active') continue;
      blocks++;
      slots += fin(b.slots);
      let_ += b.residents?.length ?? 0;
      if (b.owner === STATE) stateBlocks++;
    }
    rBlocks.text(fmtInt(blocks));
    rSlots.text(`${fmtInt(let_)} of ${fmtInt(slots)}${slots ? ' · ' + fmtPct(let_ / slots) : ''}`);
    rVacant.text(fmtInt(Math.max(0, slots - let_)), slots - let_ <= 0 && t.homeless > 0 ? 'bad' : undefined);
    rRent.text(`${fmtPrice(t.avgRent)} / day`);
    rState.text(fmtInt(stateBlocks));

    // treasury stores
    const held = s.treasury?.goods?.[id] ?? [];
    const rows: MiniRow[] = [];
    for (let g = 0; g < N_GOODS; g++) {
      const q = fin(held[g]);
      if (q <= 0.005) continue;
      const m = s.markets?.[id * N_GOODS + g];
      rows.push({ key: g, cells: [GOODS[g].name, fmtQty(q), m ? fmtMoneyShort(q * fin(m.price)) : '—'] });
    }
    stores.set(rows);
  }

  return { el, update };
}
