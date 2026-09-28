// ============================================================================
// Record factories: the ONE place where every field of every entity gets its
// initial value. Modules that create entities (world init, demography, firms,
// construction, bank…) must use these and then set what they need.
// If you add a field to types.ts, initialise it here.
// ============================================================================
import { INIT_GOLD_PRICE, INIT_LEND_RATE, INIT_RESERVE_RATE, IOU_PAR, SIM_VERSION } from './config';
import { emptyGoods, N_GOODS, SECTORS } from './goods';
import { seedRng } from './rng';
import type {
  Bank,
  Building,
  BuildingKind,
  Firm,
  Foreign,
  Loan,
  LoanPurpose,
  MapData,
  MarketState,
  Person,
  Project,
  ProjectKind,
  Ref,
  Sector,
  Shipment,
  SimState,
  Stats,
  Town,
  TownId,
  TownKind,
  Treasury,
} from './types';
import { GOLD_GOOD, IOU_GOOD, STATE } from './types';

export function newPerson(s: SimState, town: TownId, name: string): Person {
  const p: Person = {
    id: s.ids.person++,
    alive: true,
    name,
    town,
    home: -1,
    job: -1,
    wage: 0,
    cash: 0,
    iou: 0,
    gold: 0,
    pantry: emptyGoods(),
    health: 0.9,
    contentment: 0.6,
    joy: 0.3,
    income: 0,
    lastWage: 0,
    expInfl: 0,
    unempDays: 0,
    tenure: 0,
    arrears: 0,
    age: 30,
    skill: 1,
    owns: [],
    houses: [],
    foodSat: 1,
    heatSat: 1,
    commute: 0,
    born: s.day,
    budget: 0,
    spent: 0,
    earned: 0,
  };
  s.people[p.id] = p;
  return p;
}

export function newFirm(s: SimState, sector: Sector, town: TownId, building: number, owner: Ref, name: string): Firm {
  const d = SECTORS[sector];
  const f: Firm = {
    id: s.ids.firm++,
    alive: true,
    status: 'active',
    name,
    sector,
    town,
    building,
    owner,
    workers: [],
    capacity: d.capacityPerLevel,
    target: 0,
    wage: 0,
    vacancyDays: 0,
    applicants: 0,
    hired: 0,
    fired: 0,
    tools: 0,
    inv: emptyGoods(),
    cash: 0,
    pExp: 0,
    sales: 0,
    output: 0,
    producedToday: 0,
    soldToday: 0,
    unitCost: 0,
    profit: 0,
    monthProfit: 0,
    revenue: 0,
    spent: 0,
    wageBill: 0,
    otherCosts: 0,
    distress: 0,
    founded: s.day,
    liquidationDays: 0,
    trade: null,
    build: null,
  };
  if (sector === 'trader') {
    const nt = s.towns.length;
    const grid = () => Array.from({ length: nt }, () => new Array(N_GOODS).fill(0));
    f.trade = { wagons: 0, busy: [], stock: grid(), basis: grid(), age: grid(), freightEma: 0, shippedToday: 0 };
  }
  if (sector === 'builder') f.build = { queue: [] };
  s.firms[f.id] = f;
  return f;
}

export function newBuilding(
  s: SimState,
  kind: BuildingKind,
  sector: Sector | '',
  town: TownId,
  x: number,
  y: number,
  w: number,
  h: number,
  status: Building['status'],
): Building {
  const b: Building = {
    id: s.ids.building++,
    kind,
    town,
    x,
    y,
    w,
    h,
    status,
    level: 1,
    sector,
    firm: -1,
    slots: 0,
    residents: [],
    rent: 0,
    owner: STATE,
    vacantDays: 0,
    cost: 0,
    built: status === 'active' ? s.day : -1,
    project: -1,
  };
  s.buildings[b.id] = b;
  return b;
}

export function newLoan(s: SimState, borrower: Ref, principal: number, spread: number, rate: number, term: number, purpose: LoanPurpose): Loan {
  const l: Loan = {
    id: s.ids.loan++,
    borrower,
    principal,
    spread,
    rate,
    term,
    left: term,
    purpose,
    overdue: 0,
    start: s.day,
    active: true,
  };
  s.loans.push(l);
  return l;
}

export function newProject(s: SimState, kind: ProjectKind, town: TownId, owner: Ref, builder: number, label: string): Project {
  const p: Project = {
    id: s.ids.project++,
    kind,
    town,
    owner,
    builder,
    sector: '',
    building: -1,
    tiles: [],
    need: { labor: 0, wood: 0, iron: 0, tools: 0 },
    done: { labor: 0, wood: 0, iron: 0, tools: 0 },
    billed: 0,
    status: 'queued',
    created: s.day,
    loan: -1,
    stalledDays: 0,
    label,
  };
  s.projects.push(p);
  return p;
}

export function newShipment(
  s: SimState,
  owner: Ref,
  from: TownId,
  to: TownId,
  good: number,
  qty: number,
  basis: number,
  depart: number,
  arrive: number,
  wagons: number,
): Shipment {
  const sh: Shipment = { id: s.ids.shipment++, owner, from, to, good, qty, basis, depart, arrive, wagons };
  s.shipments.push(sh);
  return sh;
}

export function newMarket(town: TownId, good: number, price: number): MarketState {
  return {
    town,
    good,
    price,
    gross: price,
    net: price,
    ema: price,
    volume: 0,
    volEma: 0,
    shortage: 0,
    surplus: 0,
    traded: false,
    bestBid: -1,
    bestAsk: -1,
    hist: [],
    volHist: [],
    curve: null,
  };
}

export function newTown(id: TownId, name: string, kind: TownKind, x: number, y: number, radius: number): Town {
  return {
    id,
    name,
    kind,
    x,
    y,
    radius,
    market: -1,
    hasPort: kind === 'harbor',
    pop: 0,
    employed: 0,
    unemployed: 0,
    vacancies: 0,
    homeless: 0,
    vacantSlots: 0,
    avgWage: 0,
    avgRent: 0,
    cpi: 100,
    contentment: 0.6,
    health: 0.9,
    strikeDays: 0,
    unrestDays: 0,
    droughtDays: 0,
  };
}

export function newBank(owner: number): Bank {
  return {
    owner,
    reserves: 0,
    windowDebt: 0,
    iou: 0,
    iouBook: 0,
    equity: 0,
    baseRate: INIT_RESERVE_RATE + 0.025,
    depositRate: Math.max(0, INIT_RESERVE_RATE - 0.01),
    requests: [],
    approved: 0,
    rejected: 0,
    defaultEma: 0,
    writeoffs: 0,
    stance: 0.3,
    failed: false,
    failedDays: 0,
    profitMonth: 0,
    interestIn: 0,
    interestOut: 0,
  };
}

export function newTreasury(nTowns: number): Treasury {
  return {
    purse: 0,
    minted: 0,
    burned: 0,
    goods: Array.from({ length: nTowns }, () => emptyGoods()),
    gold: 0,
    iouOutstanding: 0,
    reserveRate: INIT_RESERVE_RATE,
    lendRate: INIT_LEND_RATE,
    autoMint: false,
    givesSuspended: false,
    flows: {},
    flowsMonth: {},
    flowsLastMonth: {},
  };
}

export function newForeign(): Foreign {
  return {
    world: emptyGoods(),
    world0: emptyGoods(),
    shipCap: emptyGoods(),
    goldPrice: INIT_GOLD_PRICE,
    goldEma: INIT_GOLD_PRICE,
    dealerValue: INIT_GOLD_PRICE,
    ppp: INIT_GOLD_PRICE,
    coin: 0,
    importsQty: emptyGoods(),
    exportsQty: emptyGoods(),
    importValue: 0,
    exportValue: 0,
    shocks: [],
    piers: 0,
  };
}

export function newStats(): Stats {
  return {
    daily: {},
    monthly: {},
    dailyStart: 0,
    monthlyStart: 0,
    latest: {},
    basket: emptyGoods(),
    basketRent: 0,
    basePrices: emptyGoods(),
    baseCost: 1,
    baseWage: 1,
    baseRent: 1,
    baseFreight: 1,
    acc: {},
    macc: {},
  };
}

/** An empty state shell (no map content, towns, people, firms). World init fills it. */
export function newSimState(seed: number, map: MapData): SimState {
  return {
    version: SIM_VERSION,
    seed,
    rng: seedRng(seed ^ 0x5eed),
    day: 0,
    startDay: 0,
    map,
    towns: [],
    buildings: [],
    people: [],
    firms: [],
    loans: [],
    shipments: [],
    projects: [],
    markets: [],
    iouMarket: newMarket(-1, IOU_GOOD, IOU_PAR),
    goldMarket: newMarket(-1, GOLD_GOOD, INIT_GOLD_PRICE),
    bank: newBank(-1),
    treasury: newTreasury(0),
    foreign: newForeign(),
    policy: { levies: [], limits: [], orders: [] },
    stats: newStats(),
    news: [],
    ids: { person: 0, firm: 0, building: 0, loan: 0, shipment: 0, project: 0, policy: 1 },
    settings: { events: true, scenario: 'founding', realmName: 'The Realm' },
  };
}
