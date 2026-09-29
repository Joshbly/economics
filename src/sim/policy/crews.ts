// ============================================================================
// The Treasury's workforce, town by town (read-only; for the Works panel).
//
// Treasury workers in a town are one employer (the town's stateworks crew) with two
// kinds of place in it:
//   posts     — the drivers of the freight lines based there: named people posted to
//               each line (FreightLine.staff, lines.staffLines), who only drive for it;
//   the works — everyone else: on the Treasury's building sites in the town, all at
//               once (construction.ts records each project's share: Project.crewToday /
//               crewHeads), or idle, still paid, when there is nothing to do.
// treasuryCrew() names the people in each place — each line's drivers, then each site
// (in the order the projects were commissioned, so a person stays on the same site
// while the shares hold), then the idle — so the panel can say who is where.
// ============================================================================
import { treasuryCrewWanted } from '../agents/construction';
import type { Firm, FreightLine, PlayerOrder, Project, SimState, TownId } from '../types';
import { STATE } from '../types';
import { stateworksIn } from './lines';

export interface CrewSite {
  project: Project;
  /** People on it today (a share of the pool, rounded). */
  people: number[];
  /** Labour-days they put in today. */
  labour: number;
}

export interface TownCrew {
  town: TownId;
  firm: Firm | null;
  /** Everyone the Treasury employs in the town (person ids). */
  workers: number[];
  /** Headcount the Treasury wants there today (labour orders + drivers). */
  wanted: number;
  /** Daily wage paid to each. */
  wage: number;
  /** Everyone posted to a line (all lines together). */
  drivers: number[];
  /** Each line based in the town with the people posted to it. */
  lines: { line: FreightLine; crew: number; people: number[] }[];
  sites: CrewSite[];
  idle: number[];
  /** Unfinished Treasury projects in the town (under way first). */
  projects: Project[];
  /** People those projects could use today (what an order that staffs them would hire). */
  canUse: number;
  /** The Treasury's labour orders in the town. */
  orders: PlayerOrder[];
}

const LIVE = new Set(['queued', 'active', 'stalled']);

export function treasuryCrew(s: SimState, town: TownId): TownCrew {
  let firm: Firm | null = null;
  for (const f of s.firms) if (f && f.alive && f.sector === 'stateworks' && f.town === town) firm = f;
  const workers = firm ? firm.workers.slice() : [];
  const projects = s.projects
    .filter((p) => p && p.owner === STATE && p.town === town && LIVE.has(p.status))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || a.created - b.created);
  const onCrew = new Set(workers);
  const sw = stateworksIn(s, town);
  const lines = (s.policy.lines ?? [])
    .filter((L) => L && L.a === town)
    .map((line) => {
      const people = sw ? (line.staff ?? []).filter((pid) => onCrew.has(pid)) : [];
      return { line, crew: people.length, people };
    });
  const posted = new Set<number>();
  for (const l of lines) for (const pid of l.people) posted.add(pid);
  const drivers = workers.filter((pid) => posted.has(pid));
  let rest = workers.filter((pid) => !posted.has(pid));
  // sites: today's shares, rounded by largest remainder, never more people than are left;
  // in the order the projects were commissioned, so people stay on their site
  const worked = projects.filter((p) => (p.crewHeads ?? 0) > 1e-6).sort((a, b) => a.created - b.created || a.id - b.id);
  const want = worked.map((p) => Math.max(0, p.crewHeads ?? 0));
  const total = Math.min(rest.length, Math.round(want.reduce((a, b) => a + b, 0)));
  const base = want.map((x) => Math.floor(x));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = want.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    base[i]++;
    left--;
  }
  const sites: CrewSite[] = [];
  let over = base.reduce((a, b) => a + b, 0) - rest.length;
  for (let i = worked.length - 1; i >= 0 && over > 0; i--) {
    const cut = Math.min(over, base[i]);
    base[i] -= cut;
    over -= cut;
  }
  worked.forEach((p, i) => {
    const n = base[i];
    sites.push({ project: p, people: rest.slice(0, n), labour: p.crewToday ?? 0 });
    rest = rest.slice(n);
  });
  const orders = s.policy.orders.filter((o) => o.market.kind === 'labor' && o.market.town === town);
  return {
    town,
    firm,
    workers,
    wanted: firm ? Math.max(0, Math.round(firm.target)) : 0,
    wage: firm && firm.wage > 0 ? firm.wage : 0,
    drivers,
    lines,
    sites,
    idle: rest,
    projects,
    canUse: treasuryCrewWanted(s, town),
    orders,
  };
}
