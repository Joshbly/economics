// ============================================================================
// Inspector: buildings that are not (running) workshops — house blocks, empty
// or unfinished workshop buildings, the market halls, the Palace (you), the
// Bank and the Port.
// ============================================================================
import { BANK_MIN_CAPITAL, IOU_COUPON } from '../../../sim/config';
import { capitalRuleSource, minCapital } from '../../../sim/agents/bank';
import { GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import { STATE, type Building, type SimState } from '../../../sim/types';
import { h } from '../../dom';
import { fmtDay, fmtDuration, fmtInt, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, fmtPrice, fmtQty, fmtRate } from '../../format';
import { focusMarket, setTab, ui } from '../../uiState';
import { button, type Tone } from '../../widgets';
import { block, buildingLabel, fin, kvBlock, meter, miniTable, personLink, refKey, refLink, sectorName, townLink, type MiniRow } from './common';
import { projectRow } from './firmView';
import { hero, para, statStrip, statTile, type View } from './kit';
import { marketTable } from './townView';

// ---------------------------------------------------------------------------
// Construction block (any building with an active project)
// ---------------------------------------------------------------------------
function projectBlock(): { el: HTMLElement; update(s: SimState, b: Building): void } {
  const host = h('div');
  const el = block('Construction', null, host);
  let pid = -2;
  let row: ReturnType<typeof projectRow> | null = null;
  return {
    el,
    update(s, b) {
      const p = b.project >= 0 ? s.projects.find((x) => x.id === b.project) : undefined;
      el.hidden = !p;
      if (!p) {
        pid = -2;
        return;
      }
      if (p.id !== pid) {
        pid = p.id;
        row = projectRow(s, p);
        host.replaceChildren(row.el);
      } else row?.update(s, p);
    },
  };
}

// ---------------------------------------------------------------------------
// House block
// ---------------------------------------------------------------------------
function houseView(_s0: SimState, id: number): View {
  const hr = hero();
  const tLet = statTile('Homes let');
  const tRent = statTile('Rent', false, 'Asked per slot per day');
  const tValue = statTile('Book value', false, 'What it cost to build');
  const kv = kvBlock();
  const rOwner = kv.row('Landlord');
  const rVacant = kv.row('Empty for', 'Days in a row with at least one empty slot; landlords cut the rent when homes stay empty');
  const rBuilt = kv.row('Built');
  const rIncome = kv.row('Rent roll', 'Rent due per day from current tenants');
  const tenants = miniTable(
    [
      { label: 'Tenant', align: 'left', width: '42%' },
      { label: 'Work', align: 'left', width: '30%' },
      { label: 'Behind', title: 'Days behind on rent' },
    ],
    { empty: 'Nobody lives here' },
  );
  const proj = projectBlock();
  const el = h('div', { class: 'ins-view' }, hr.el, statStrip([tLet, tRent, tValue]), proj.el, block('Tenants', null, tenants.el), block('The block', null, kv.el));
  return {
    el,
    update(s) {
      const b = s.buildings[id];
      if (!b) return;
      hr.kicker(`House block · ${s.towns[b.town]?.name ?? ''}`);
      hr.title(b.owner === STATE ? 'Treasury houses' : 'House block');
      const n = b.residents?.length ?? 0;
      const chips: [Tone | '', string][] = [];
      if (b.status === 'construction') chips.push(['warn', 'Being built']);
      else if (b.status === 'ruin') chips.push(['', 'Ruin']);
      else chips.push(n >= b.slots ? ['good', 'Full'] : n === 0 ? ['warn', 'Empty'] : ['', `${b.slots - n} empty ${b.slots - n === 1 ? 'slot' : 'slots'}`]);
      if (b.owner === STATE) chips.push(['gold', 'Yours']);
      hr.chips(chips);
      hr.sub.node(`${b.town}|${refKey(s, b.owner)}`, () => [townLink(s, b.town), ' · let by ', refLink(s, b.owner)]);
      tLet.set(`${fmtInt(n)} / ${fmtInt(b.slots)}`, b.slots ? fmtPct(n / b.slots, 0) + ' full' : undefined);
      tRent.set(fmtPrice(b.rent), 'per slot per day');
      tValue.set(fmtMoneyShort(b.cost));
      rOwner.node(refKey(s, b.owner), () => refLink(s, b.owner));
      rVacant.text(n >= b.slots ? 'full' : fmtDuration(b.vacantDays));
      rBuilt.text(b.built >= 0 ? fmtDay(b.built) : 'not yet');
      rIncome.text(`${fmtMoney(n * fin(b.rent))} / day`);
      proj.update(s, b);
      tenants.set(
        (b.residents ?? []).map((pid) => {
          const p = s.people[pid];
          const f = p && p.job >= 0 ? s.firms[p.job] : undefined;
          return {
            key: pid,
            cells: [{ key: 'p' + pid, node: () => personLink(s, pid) }, f ? sectorName(f.sector) : 'jobless', p && p.arrears > 0 ? `${p.arrears} d` : '—'],
            tones: [undefined, f ? undefined : 'warn', p && p.arrears >= 5 ? 'bad' : undefined],
          };
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Workshop building with no running firm (empty, ruined, or going up)
// ---------------------------------------------------------------------------
function emptyWorkshopView(_s0: SimState, id: number): View {
  const hr = hero();
  const kv = kvBlock();
  const rOwner = kv.row('Owner');
  const rCap = kv.row('Room for', 'Workers the building can hold');
  const rValue = kv.row('Book value');
  const rEmpty = kv.row('Standing empty');
  const stock = miniTable(
    [
      { label: 'Left in store', align: 'left', width: '55%' },
      { label: 'Units' },
    ],
    { empty: 'Nothing left inside' },
  );
  const proj = projectBlock();
  const note = para('');
  const stockBlock = block('Stock', null, stock.el);
  const el = h('div', { class: 'ins-view' }, hr.el, proj.el, block('The building', null, kv.el, note), stockBlock);
  return {
    el,
    update(s) {
      const b = s.buildings[id];
      if (!b) return;
      const d = SECTORS[b.sector as keyof typeof SECTORS];
      hr.kicker(`${sectorName(b.sector)} · ${s.towns[b.town]?.name ?? ''}`);
      hr.title(buildingLabel(s, b));
      hr.chips([b.status === 'construction' ? ['warn', 'Being built'] : b.status === 'ruin' ? ['', 'Ruin'] : ['warn', 'Empty']]);
      hr.sub.node(`${b.town}`, () => [townLink(s, b.town)]);
      rOwner.node(refKey(s, b.owner), () => refLink(s, b.owner));
      rCap.text(d ? `${fmtInt(d.capacityPerLevel * Math.max(1, b.level))} workers · level ${fmtInt(b.level)}` : `level ${fmtInt(b.level)}`);
      rValue.text(fmtMoneyShort(b.cost));
      rEmpty.show(b.status === 'vacant');
      rEmpty.text(fmtDuration(b.vacantDays));
      note.textContent =
        b.status === 'vacant'
          ? 'An empty workshop can be reopened: an entrepreneur does so when the trade looks profitable enough to borrow for.'
          : b.status === 'construction'
            ? 'Builders are putting it up. It opens for work when the last of the labour and materials are in.'
            : 'Nothing is left worth reopening.';
      proj.update(s, b);
      const f = b.firm >= 0 ? s.firms[b.firm] : undefined;
      const inv = f?.inv ?? [];
      const rows: MiniRow[] = [];
      for (let g = 0; g < N_GOODS; g++) if (fin(inv[g]) > 0.005) rows.push({ key: g, cells: [GOODS[g].name, fmtQty(inv[g])] });
      stock.set(rows);
      stockBlock.hidden = b.status === 'construction' && rows.length === 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Market hall
// ---------------------------------------------------------------------------
export function marketHallView(s0: SimState, town: number, good?: number): View {
  const hr = hero();
  const table = marketTable();
  const t0 = s0.towns[town];
  const open = button({ label: 'Open in Markets', kind: 'primary', size: 'sm', onClick: () => focusMarket(town, good ?? ui.marketGood ?? 8) });
  const el = h(
    'div',
    { class: 'ins-view' },
    hr.el,
    h('div', { class: 'ins-actions' }, open),
    para(`Every good is auctioned here once a day at midday. Buyers bring bids, sellers bring offers, and the hall finds the one price at which the most changes hands.`),
    block('Today’s prices', null, table.el),
  );
  return {
    el,
    update(s) {
      const t = s.towns[town];
      hr.kicker(`Market hall · ${t?.name ?? t0?.name ?? ''}`);
      hr.title(`${t?.name ?? ''} Market Hall`);
      hr.sub.node(String(town), () => ['The market of ', townLink(s, town), good !== undefined && GOODS[good] ? ` · ${GOODS[good].name}` : '']);
      hr.chips([]);
      table.update(s, town);
    },
  };
}

// ---------------------------------------------------------------------------
// The Palace (the Treasury — you)
// ---------------------------------------------------------------------------
const FLOW_NAMES: Record<string, string> = {
  wage: 'Wages of Treasury workers',
  buy: 'Trading in markets',
  levy: 'Levies',
  give: 'Payments out',
  interest: 'Window interest',
  coupon: 'Payments on IOUs',
  dividend: 'Profits of your workshops',
  rent: 'Rent from your houses',
  transfer: 'Transfers',
  build: 'Construction',
  freight: 'Carting your goods',
  estate: 'Estates',
  migrate: 'Migration',
  bailin: 'Deposits written down',
  recap: 'Bank capital',
  fee: 'Fees',
  asset: 'IOUs and gold',
  mint: 'Minted',
  burn: 'Destroyed',
  misc: 'Other',
};

function palaceView(): View {
  const hr = hero();
  const tPurse = statTile('The Purse');
  const tToday = statTile('Today, net', false, 'Everything that came into the Purse today less everything paid out');
  const tGold = statTile('Gold');
  const kv = kvBlock();
  const rMint = kv.row('Minted, all time');
  const rBurn = kv.row('Destroyed, all time');
  const rAuto = kv.row('Auto-mint', 'When on, any payment the Purse cannot cover mints the difference');
  const rIou = kv.row('IOUs held by the public', 'Each pays ¤5 a year from the Purse');
  const rWin = kv.row('Window', 'The rate you pay the bank on its reserves / the rate you charge when it borrows');
  const rPolicy = kv.row('In force', 'Levies, limits and standing orders');
  const warn = h('div', { class: 'ins-warn', hidden: true });
  const flows = miniTable(
    [
      { label: 'Money in (+) and out (−)', align: 'left', width: '46%' },
      { label: 'Today' },
      { label: 'This month' },
      { label: 'Last month' },
    ],
    { empty: 'No money has moved yet' },
  );
  const el = h(
    'div',
    { class: 'ins-view' },
    hr.el,
    statStrip([tPurse, tToday, tGold]),
    warn,
    h(
      'div',
      { class: 'ins-actions' },
      button({ label: 'Levers', size: 'sm', kind: 'primary', onClick: () => setTab('levers') }),
      button({ label: 'The Ledger', size: 'sm', kind: 'secondary', onClick: () => setTab('ledger') }),
    ),
    block('The Treasury', null, kv.el),
    block('Where the money went', null, flows.el),
  );
  return {
    el,
    update(s) {
      const t = s.treasury;
      if (!t) return;
      hr.kicker('The Palace · seat of the Treasury');
      hr.title('The Treasury');
      hr.sub.text('That is you. You act only through the seven levers.');
      hr.chips(t.autoMint ? [['gold', 'Auto-mint on']] : [['', 'Auto-mint off']]);
      tPurse.set(fmtMoneyShort(t.purse), undefined, t.purse < 0 ? 'bad' : 'gold');
      let net = 0;
      for (const k in t.flows ?? {}) net += fin(t.flows[k]);
      tToday.set(fmtMoneyShort(net), undefined, net < 0 ? 'bad' : net > 0 ? 'good' : undefined);
      const gp = fin(s.foreign?.goldPrice);
      tGold.set(`${fmtNum(t.gold)} oz`, gp > 0 ? `≈ ${fmtMoneyShort(t.gold * gp)}` : undefined);
      rMint.text(fmtMoney(t.minted));
      rBurn.text(fmtMoney(t.burned));
      rAuto.text(t.autoMint ? 'on' : 'off');
      rIou.text(`${fmtInt(t.iouOutstanding)} · ${fmtMoneyShort(t.iouOutstanding * IOU_COUPON)} a year`);
      rWin.text(`pays ${fmtRate(t.reserveRate)} · charges ${fmtRate(t.lendRate)}`);
      const pol = s.policy ?? { levies: [], limits: [], orders: [], lines: [], carries: [] };
      const on = (a: { enabled: boolean }[]) => a.filter((x) => x.enabled).length;
      rPolicy.text(`${on(pol.levies)} levies · ${on(pol.limits)} limits · ${on(pol.orders)} orders${pol.carries?.length ? ` · ${on(pol.carries)} carry rules` : ''}`);
      warn.hidden = !t.givesSuspended;
      warn.textContent = t.givesSuspended ? 'The Purse is empty: payments you promised (negative levies, transfers) are suspended today. Mint, collect, or turn on auto-mint.' : '';
      const keys = new Set([...Object.keys(t.flows ?? {}), ...Object.keys(t.flowsMonth ?? {}), ...Object.keys(t.flowsLastMonth ?? {})]);
      const rows: MiniRow[] = [...keys]
        .map((k) => ({ k, m: fin(t.flowsMonth?.[k]), d: fin(t.flows?.[k]), l: fin(t.flowsLastMonth?.[k]) }))
        .filter((x) => Math.abs(x.m) > 0.005 || Math.abs(x.d) > 0.005 || Math.abs(x.l) > 0.005)
        .sort((a, b) => Math.abs(b.m) + Math.abs(b.l) - (Math.abs(a.m) + Math.abs(a.l)))
        .map((x) => ({
          key: x.k,
          cells: [FLOW_NAMES[x.k] ?? x.k[0].toUpperCase() + x.k.slice(1), signed(x.d), signed(x.m), signed(x.l)],
          tones: [undefined, tone(x.d), tone(x.m), tone(x.l)],
        }));
      flows.set(rows);
    },
  };
}

const signed = (v: number) => (Math.abs(v) < 0.005 ? '—' : (v > 0 ? '+' : '') + fmtMoneyShort(v));
const tone = (v: number): Tone | undefined => (v > 0.005 ? 'good' : v < -0.005 ? 'bad' : undefined);

// ---------------------------------------------------------------------------
// The Bank
// ---------------------------------------------------------------------------
function bankView(): View {
  const hr = hero();
  const tDep = statTile('Deposits', false, 'All the realm’s money: every private balance is a deposit at the bank');
  const tLoans = statTile('Loans');
  const tCap = statTile('Capital ratio', false, 'Equity ÷ loans. Below the floor the bank stops lending');
  const kv = kvBlock();
  const rOwner = kv.row('Owner');
  const rRes = kv.row('Reserves at the Treasury');
  const rIou = kv.row('IOUs held', 'Units, and what the bank paid for them');
  const rEq = kv.row('Equity', 'Assets less what it owes depositors and the window');
  const rWin = kv.row('Borrowed at the window');
  const rates = kvBlock();
  const rBase = rates.row('Base rate', 'Its funding cost plus a margin; loans are priced above it');
  const rLoan = rates.row('Average loan rate');
  const rDep = rates.row('Deposit rate');
  const rStance = rates.row('Lending standards', 'Tightens after defaults and when capital runs thin');
  const mStance = meter();
  const rToday = rates.row('Loan requests today');
  const rWrite = rates.row('Written off, all time');
  const warn = h('div', { class: 'ins-warn', hidden: true });
  const el = h('div', { class: 'ins-view' }, hr.el, statStrip([tDep, tLoans, tCap]), warn, block('Balance sheet', null, kv.el), block('Lending', null, rates.el));
  rStance.el.parentElement?.insertBefore(mStance.el, rStance.el);
  return {
    el,
    update(s) {
      const b = s.bank;
      if (!b) return;
      const L = s.stats?.latest ?? {};
      hr.kicker(`The Bank · ${s.towns[0]?.name ?? ''}`);
      hr.title('The Bank');
      hr.sub.node('o' + b.owner, () => ['Owned by ', personLink(s, b.owner)]);
      const cap = fin(L.capRatio, NaN);
      // the capital rule in force: the standing one, or a Limit in its place (never below the Bank's own floor)
      let floor = BANK_MIN_CAPITAL;
      let src: ReturnType<typeof capitalRuleSource> = 'standing';
      try {
        floor = minCapital(s);
        src = capitalRuleSource(s);
      } catch {
        /* keep the standing rule */
      }
      hr.chips(b.failed ? [['bad', `Failed · ${b.failedDays} d`]] : cap < floor ? [['warn', 'Below its capital floor']] : [['good', 'Lending']]);
      tDep.set(fmtMoneyShort(L.money));
      tLoans.set(fmtMoneyShort(L.credit));
      tCap.set(fmtPct(cap, 1), `floor ${fmtPct(floor, floor < 0.1 && Math.abs(floor * 100 - Math.round(floor * 100)) > 1e-6 ? 1 : 0)}${src === 'standing' ? '' : src === 'limit' ? ' · Limit' : ' · own'}`, cap < floor ? 'bad' : undefined);
      rOwner.node('o' + b.owner, () => personLink(s, b.owner));
      rRes.text(fmtMoney(b.reserves), b.reserves < 0 ? 'bad' : undefined);
      rIou.text(b.iou > 0 ? `${fmtInt(b.iou)} · book ${fmtMoneyShort(b.iouBook)}` : 'none');
      rEq.text(fmtMoney(b.equity), b.equity < 0 ? 'bad' : undefined);
      rWin.text(b.windowDebt > 0.005 ? fmtMoney(b.windowDebt) : 'nothing');
      rBase.text(fmtRate(b.baseRate));
      rLoan.text(fmtRate(fin(L.loanRate, b.baseRate)));
      rDep.text(fmtRate(b.depositRate));
      const st = Math.max(0, Math.min(1, fin(b.stance)));
      rStance.text(st < 0.3 ? 'loose' : st < 0.6 ? 'ordinary' : 'tight');
      mStance.set(st, st > 0.6 ? 'warn' : undefined);
      rToday.text(`${fmtInt(b.approved)} granted · ${fmtInt(b.rejected)} refused`);
      rWrite.text(fmtMoney(b.writeoffs));
      warn.hidden = !b.failed;
      warn.textContent = b.failed ? 'The bank’s equity is below zero and it has stopped lending. Unless it is recapitalised, depositors will lose part of their balances.' : '';
    },
  };
}

// ---------------------------------------------------------------------------
// The Port
// ---------------------------------------------------------------------------
function portView(_s0: SimState, id: number): View {
  const hr = hero();
  const tGold = statTile('Gold price', false, '¤ per ounce: the price of foreign money');
  const tIn = statTile('Bought abroad', false, 'Today');
  const tOut = statTile('Sold abroad', false, 'Today');
  const kv = kvBlock();
  const rPiers = kv.row('Piers', 'Each pier lets more ships call');
  const rDesk = kv.row('Foreign desk’s coin', 'Coin foreign merchants hold here; they turn surpluses into gold');
  const rTrade = kv.row('Trade, recent average', 'Per day, half of imports plus exports');
  const goods = miniTable(
    [
      { label: 'Good', align: 'left', width: '26%' },
      { label: 'World', title: 'World price in gold' },
      { label: 'In ¤', title: 'World price × today’s gold price' },
      { label: 'Ships', title: 'Units foreign ships can carry each way per day' },
      { label: 'In / out', title: 'Units imported / exported today' },
    ],
    { empty: 'Nothing is traded abroad' },
  );
  const el = h(
    'div',
    { class: 'ins-view' },
    hr.el,
    statStrip([tGold, tIn, tOut]),
    para('Foreign ships sell a little above the world price and buy a little below it, in this town’s markets. What they earn in coin they turn into gold.'),
    block('Harbour', null, kv.el),
    block('Goods the ships carry', null, goods.el),
  );
  return {
    el,
    update(s) {
      const b = s.buildings[id];
      const F = s.foreign;
      if (!F) return;
      const town = b ? b.town : (s.towns.find((t) => t.hasPort)?.id ?? 0);
      hr.kicker(`Port · ${s.towns[town]?.name ?? ''}`);
      hr.title(`Port of ${s.towns[town]?.name ?? ''}`);
      hr.sub.node('t' + town, () => [townLink(s, town), ' · the realm’s one door to the outside world']);
      hr.chips([]);
      const gp = fin(F.goldPrice);
      tGold.set(fmtPrice(gp));
      tIn.set(fmtMoneyShort(F.importValue));
      tOut.set(fmtMoneyShort(F.exportValue));
      rPiers.text(fmtInt(F.piers));
      rDesk.text(fmtMoney(F.coin));
      rTrade.text(`${fmtMoneyShort(F.tradeEma)} / day`);
      const rows: MiniRow[] = [];
      for (let g = 0; g < N_GOODS; g++) {
        const w = fin(F.world?.[g]);
        if (!(w > 0)) continue;
        rows.push({
          key: g,
          cells: [GOODS[g].name, `${fmtNum(w)} oz`, fmtPrice(w * gp), fmtQty(F.shipCap?.[g]), `${fmtQty(F.importsQty?.[g] ?? 0)} / ${fmtQty(F.exportsQty?.[g] ?? 0)}`],
          onClick: () => focusMarket(town, g),
          title: `Open the ${GOODS[g].name.toLowerCase()} market in ${s.towns[town]?.name ?? 'the port town'}`,
        });
      }
      goods.set(rows);
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export function placeView(s: SimState, b: Building): View {
  switch (b.kind) {
    case 'house':
      return houseView(s, b.id);
    case 'market':
      return marketHallView(s, b.town);
    case 'palace':
      return palaceView();
    case 'bank':
      return bankView();
    case 'port':
      return portView(s, b.id);
    default:
      return emptyWorkshopView(s, b.id);
  }
}
