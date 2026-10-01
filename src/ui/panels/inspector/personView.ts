// ============================================================================
// Inspector: a household.
// ============================================================================
import { COLD_BELOW, HUNGRY_BELOW } from '../../../sim/config';
import { plotValue } from '../../../sim/agents/land';
import { GOODS, N_GOODS } from '../../../sim/goods';
import type { SimState } from '../../../sim/types';
import { h } from '../../dom';
import { fmtDay, fmtDuration, fmtInt, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, fmtPctSigned, fmtPrice, fmtQty } from '../../format';
import type { Tone } from '../../widgets';
import {
  assetPrices,
  block,
  buildingLabel,
  buildingLink,
  debtMap,
  fin,
  firmLink,
  kvBlock,
  meter,
  miniTable,
  qtyUnit,
  refKey,
  refLink,
  sectorName,
  townLink,
  wealthOf,
  wellTone,
  type MiniRow,
} from './common';
import { hero, statStrip, statTile, type View } from './kit';

export function personView(_s0: SimState, id: number): View {
  const hr = hero();
  const tCash = statTile('Cash', false, 'Bank deposit');
  const tIncome = statTile('Income', false, 'Recent average of everything received per day, after levies');
  const tWealth = statTile('Net worth', false, 'Savings plus houses and workshops owned, less debts');

  // home
  const hm = kvBlock();
  const rHome = hm.row('Home');
  const rLandlord = hm.row('Landlord');
  const rRent = hm.row('Rent', 'Per day for their slot in the house block');
  const rArrears = hm.row('Behind on rent', 'Ten days behind and they are evicted');
  const rNeigh = hm.row('Shares with');

  // work
  const wk = kvBlock();
  const rJob = wk.row('Works at');
  const rWage = wk.row('Wage', 'Posted gross wage of their job');
  const rTenure = wk.row('In this job');
  const rCommute = wk.row('Walk to work', 'Tiles between home and work');
  const rJobless = wk.row('Without work for');
  const rMeans = wk.row('Lives on');
  const rLast = wk.row('Last wage', 'Take-home pay of their last job — what they hope to earn again');
  const rSkill = wk.row('Skill', 'Productivity compared with an average worker');

  // money
  const mo = kvBlock();
  const rCash = mo.row('Cash');
  const rIou = mo.row('IOUs', 'Each pays ¤5 a year; valued at today’s IOU price');
  const rGold = mo.row('Gold', 'Valued at today’s gold price');
  const rDebt = mo.row('Owes the bank');
  const rLandHeld = mo.row('Land held unbuilt', 'Plots of town land bought from the council to sell dearer later: what they would cost today, and what was paid for them');
  const rInc = mo.row('Income, recent average');
  const rCapInc = mo.row('From capital, recent average');
  const rToday = mo.row('Today', 'Planned spending, spent in markets, and received');
  const rExp = mo.row('Expects prices to change', 'Their expectation of price rises over the next year — it shapes how much they keep in reserve');

  // wellbeing
  const wb = kvBlock();
  const rHealth = wb.row('Health', 'Falls with hunger and cold; low health means less work done and a higher chance of death');
  const mHealth = meter();
  const rContent = wb.row('Contentment', 'Food, warmth, work, a home, comforts and income');
  const mContent = meter();
  const rFood = wb.row('Food yesterday', 'Share of a day’s food eaten (bread and fish)');
  const rHeat = wb.row('Warmth yesterday', 'Share of the coal needed to heat the home');
  const rJoy = wb.row('Ale', 'Recent enjoyment of ale');

  const pantry = miniTable(
    [
      { label: 'Pantry', align: 'left', width: '40%' },
      { label: 'Held' },
      { label: 'Worth', title: 'At today’s price in their town' },
    ],
    { empty: 'The pantry is empty' },
  );
  const owns = miniTable(
    [
      { label: 'Owns', align: 'left', width: '44%' },
      { label: 'Kind', align: 'left', width: '26%' },
      { label: 'Detail' },
    ],
    { empty: 'Owns no workshops or houses' },
  );

  const el = h(
    'div',
    { class: 'ins-view ins-person' },
    hr.el,
    statStrip([tCash, tIncome, tWealth]),
    block('Home', null, hm.el),
    block('Work', null, wk.el),
    block('Money', null, mo.el),
    block('Wellbeing', null, wb.el),
    block('Property', null, owns.el, h('div', { class: 'ins-gap' }), pantry.el),
  );
  // meters sit inside the health / contentment values
  const withMeter = (row: { el: HTMLElement }, m: { el: HTMLElement }) => row.el.parentElement?.insertBefore(m.el, row.el);
  withMeter(rHealth, mHealth);
  withMeter(rContent, mContent);

  function update(s: SimState): void {
    const p = s.people[id];
    if (!p) return;
    const debts = debtMap(s);
    const px = assetPrices(s);
    const w = wealthOf(s, p, debts, px);
    const f = p.job >= 0 ? s.firms[p.job] : undefined;
    const home = p.home >= 0 ? s.buildings[p.home] : undefined;
    const town = s.towns[p.town];
    const hungry = fin(p.foodSat, 1) < HUNGRY_BELOW;
    const cold = fin(p.heatSat, 1) < COLD_BELOW;

    hr.kicker(`Household${town ? ' · ' + town.name : ''}`);
    hr.title(p.name);
    const chips: [Tone | '', string, string?][] = [];
    if (!p.alive) chips.push(['', 'No longer in the realm']);
    chips.push(['', `${fmtInt(Math.floor(fin(p.age)))} years old`]);
    if (p.alive) {
      if (f) chips.push(['good', 'Working']);
      else if (p.means) chips.push(['gold', 'Of independent means', 'Lives on what their capital brings in — interest, dividends, rents — and looks for no work. They take up work again if that falls below three times what a worker earns in their town.']);
      else chips.push(['warn', 'Looking for work']);
      if (!home) chips.push(['bad', 'Homeless']);
      if (hungry) chips.push(['bad', 'Hungry']);
      if (cold) chips.push(['warn', 'Cold']);
      if ((p.owns?.length ?? 0) > 0 || (p.houses?.length ?? 0) > 0) chips.push(['gold', 'Owner']);
      if (s.bank?.owner === p.id) chips.push(['gold', 'Owns the Bank']);
    }
    hr.chips(chips);
    hr.sub.node(`${p.town}|${p.born}`, () => ['Lives in ', townLink(s, p.town), Number.isFinite(p.born) && p.born > 0 ? ` · here since ${fmtDay(p.born)}` : '']);

    tCash.set(fmtMoneyShort(p.cash), undefined, p.cash < 1 ? 'bad' : undefined);
    tIncome.set(fmtPrice(p.income), 'per day');
    tWealth.set(fmtMoneyShort(w.net), w.property > 0 ? `${fmtMoneyShort(w.property)} in property` : `${fmtMoneyShort(w.savings)} saved`, w.net < 0 ? 'bad' : undefined);

    // home
    if (home) {
      rHome.node('h' + home.id, () => buildingLink(s, home.id, buildingLabel(s, home)));
      const own = home.owner === p.id;
      rLandlord.show(!own);
      rRent.show(!own);
      if (!own) {
        rLandlord.node(refKey(s, home.owner), () => refLink(s, home.owner));
        rRent.text(`${fmtPrice(home.rent)} / day`);
      }
      rArrears.show(!own);
      rArrears.text(p.arrears > 0 ? `${fmtInt(p.arrears)} ${p.arrears === 1 ? 'day' : 'days'}` : 'no', p.arrears >= 5 ? 'bad' : p.arrears > 0 ? 'warn' : undefined);
      const others = (home.residents ?? []).filter((r) => r !== p.id);
      rNeigh.show(true);
      rNeigh.text(others.length ? `${fmtInt(others.length)} other ${others.length === 1 ? 'household' : 'households'} · ${fmtInt(home.slots)} slots` : `nobody · ${fmtInt(home.slots)} slots`);
      if (own) rHome.label('Home (owns it)');
      else rHome.label('Home');
    } else {
      rHome.label('Home');
      rHome.text('none — sleeping rough', 'bad');
      rLandlord.show(false);
      rRent.show(false);
      rArrears.show(false);
      rNeigh.show(false);
    }

    // work
    const working = !!f;
    rJob.show(working);
    rWage.show(working);
    rTenure.show(working);
    rCommute.show(working);
    rJobless.show(!working && p.alive && !p.means);
    rMeans.show(!working && p.alive && !!p.means);
    if (p.means) rMeans.text(`their means: ${fmtPrice(fin(p.capInc ?? 0))} a day from capital`, 'gold');
    if (f) {
      rJob.node('f' + f.id, () => [firmLink(s, f.id), h('span', { class: 'kv-sub' }, sectorName(f.sector))]);
      rWage.text(`${fmtPrice(p.wage || f.wage)} / day`);
      rTenure.text(fmtDuration(p.tenure));
      rCommute.text(p.commute > 0 ? `${fmtNum(p.commute)} tiles` : 'next door');
    } else rJobless.text(fmtDuration(p.unempDays), p.unempDays > 60 ? 'bad' : p.unempDays > 20 ? 'warn' : undefined);
    rLast.text(p.lastWage > 0 ? `${fmtPrice(p.lastWage)} / day` : '—');
    rSkill.text(fmtPct(p.skill, 0));

    // money
    rCash.text(fmtMoney(p.cash));
    rIou.text(p.iou > 0 ? `${fmtNum(p.iou)} · ${fmtMoneyShort(p.iou * px.iou)}` : 'none');
    rGold.text(p.gold > 0 ? `${fmtNum(p.gold)} oz · ${fmtMoneyShort(p.gold * px.gold)}` : 'none');
    const debt = debts.get(p.id) ?? 0;
    rDebt.text(debt > 0.005 ? fmtMoney(debt) : 'nothing');
    {
      const mine = (s.plots ?? []).filter((pl) => pl.owner === p.id);
      rLandHeld.show(mine.length > 0);
      if (mine.length) {
        const worth = mine.reduce((a, pl) => a + plotValue(s, pl.tile, pl.town), 0);
        const paid = mine.reduce((a, pl) => a + pl.paid, 0);
        const towns = [...new Set(mine.map((pl) => s.towns[pl.town]?.name ?? ''))].join(', ');
        rLandHeld.text(`${fmtInt(mine.length)} ${mine.length === 1 ? 'plot' : 'plots'} in ${towns} · worth ${fmtMoneyShort(worth)} (paid ${fmtMoneyShort(paid)})`, worth >= paid ? 'good' : 'warn');
      }
    }
    rInc.text(`${fmtPrice(p.income)} / day`);
    rCapInc.text(fin(p.capInc ?? 0) !== 0 ? `${fmtPrice(fin(p.capInc ?? 0))} / day (interest, dividends, rents)` : 'nothing');
    rToday.text(`plan ${fmtMoneyShort(p.budget)} · spent ${fmtMoneyShort(p.spent)} · got ${fmtMoneyShort(p.earned)}`);
    rExp.text(`${fmtPctSigned(p.expInfl)} a year`);

    // wellbeing
    rHealth.text(fmtPct(p.health), wellTone(p.health) ?? undefined);
    mHealth.set(p.health, wellTone(p.health));
    rContent.text(fmtPct(p.contentment), wellTone(p.contentment) ?? undefined);
    mContent.set(p.contentment, wellTone(p.contentment));
    rFood.text(fmtPct(Math.min(1, fin(p.foodSat))), hungry ? 'bad' : undefined);
    rHeat.text(fmtPct(Math.min(1, fin(p.heatSat))), cold ? 'warn' : undefined);
    rJoy.text(fmtPct(Math.min(1, fin(p.joy))));

    // pantry
    const pr: MiniRow[] = [];
    for (let g = 0; g < N_GOODS; g++) {
      const q = fin(p.pantry?.[g]);
      if (q <= 0.005) continue;
      const m = s.markets?.[p.town * N_GOODS + g];
      const price = m ? fin(m.gross, fin(m.price)) : 0;
      pr.push({ key: g, cells: [GOODS[g].name + (g === 10 ? ' (at home)' : ''), qtyUnit(g, q, fmtQty), price > 0 ? fmtMoneyShort(q * price) : '—'] });
    }
    pantry.set(pr);

    // property
    const orows: MiniRow[] = [];
    for (const fid of p.owns ?? []) {
      const of = s.firms[fid];
      if (!of) continue;
      orows.push({
        key: 'f' + fid,
        cells: [{ key: 'f' + fid + (of.alive ? '' : 'x'), node: () => firmLink(s, fid) }, sectorName(of.sector), of.alive ? `${fmtInt(of.workers.length)} workers` : 'closed'],
        cls: of.alive ? '' : 'muted-row',
      });
    }
    for (const hid of p.houses ?? []) {
      const b = s.buildings[hid];
      if (!b) continue;
      orows.push({
        key: 'h' + hid,
        cells: [{ key: 'h' + hid, node: () => buildingLink(s, hid, `House block · ${s.towns[b.town]?.name ?? ''}`) }, 'Houses', `${fmtInt(b.residents?.length ?? 0)}/${fmtInt(b.slots)} let · ${fmtPrice(b.rent)}`],
      });
    }
    owns.set(orows);
  }

  return { el, update };
}
