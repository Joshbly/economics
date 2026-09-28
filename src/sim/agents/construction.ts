// ============================================================================
// Builders' yards and construction projects. OWNER: firms agent. See DESIGN §3.3.
// ============================================================================
import type { Project, ProjectKind, Ref, Sector, SimState, TownId } from '../types';
import type { Books } from '../market/markets';

export interface ProjectSpec {
  kind: ProjectKind;
  town: TownId;
  owner: Ref;
  sector?: Sector; // firm / reopen
  x?: number; // site (firm/house/pier); found automatically if omitted
  y?: number;
  building?: number; // expand / reopen target building
  tiles?: number[]; // road tiles
  loan?: number;
  label?: string;
}

/**
 * Morning: each builder's target workforce = remaining labour of its active
 * projects / BUILD_TARGET_DAYS (capped by capacity; ≥ 0).
 */
export function constructionPlan(s: SimState): void {
  // TODO(firms)
}

/**
 * Each builder advances up to MAX_ACTIVE_PROJECTS projects in queue order:
 * labour-days = Σ worker productivity (+ stateworks workers of that town on STATE-owned
 * projects); materials drawn from the builder's inv proportionally (labour cannot run
 * more than 10 % ahead of materials). Bill the owner daily (cost × BUILD_MARGIN, flow
 * 'build'); owner unable to pay → stalled (STALL_CANCEL_DAYS → cancelled; building
 * removed or reverted). Completion: building active (new firm via firms.createFirm with
 * owner, houses get slots/rent, roads set map.road = 2 + runtime.invalidateRoutes,
 * piers raise foreign.piers), news item. stats.acc: build_value, build_labor.
 */
export function constructionProgress(s: SimState): void {
  // TODO(firms)
}

/** Builders bid for wood/iron/tools needed by their active projects (+ small buffer). */
export function builderOrders(s: SimState, books: Books): void {
  // TODO(firms)
}

/**
 * Validate and enqueue a project with the town's builder. Creates the target
 * building in 'construction' status for new builds (world/layout.placeBuilding).
 * Returns the project, or an error string.
 */
export function startProject(s: SimState, spec: ProjectSpec): Project | string {
  // TODO(firms)
  return 'not implemented';
}

/** Cancel a project (removes an unfinished new building). */
export function cancelProject(s: SimState, id: number): boolean {
  // TODO(firms)
  return false;
}

/** Estimated total ¤ cost of a project at current prices and wages (for UI & entry decisions). */
export function estimateCost(s: SimState, kind: ProjectKind, town: TownId, sector?: Sector, tiles?: number): number {
  // TODO(firms)
  return 0;
}
