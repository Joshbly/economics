// ============================================================================
// Demography: births, deaths (estates), immigration, emigration (capital
// flight), internal migration. OWNER: households agent. See DESIGN §3.1.
// ============================================================================
import type { Person, SimState, TownId } from '../types';

/**
 * Daily: births (BIRTH_RATE/360 per healthy housed person), deaths (DEATH_RATE/360
 * + HUNGER_DEATH_DAY when health < STARVING_HEALTH), emigration
 * (EMIGRATE_PROB_DAY for long unemployed / miserable), internal migration
 * (MIGRATE_PROB_DAY for unemployed > 30 days toward towns with vacancies & housing).
 * Monthly: immigration when vacancies > unemployed and vacant slots exist
 * (≤ IMMIGRATION_MAX_SHARE × town pop), arriving with small savings (minted? NO —
 * immigrants bring coin from abroad: pay(FOREIGN → person) capped by foreign.coin).
 * Accumulates stats.acc births/deaths/immigrants/emigrants.
 */
export function demographyStep(s: SimState): void {
  // TODO(households)
}

/** Create a new living person in a town (not yet housed/employed). Uses s.ids.person. */
export function createPerson(s: SimState, town: TownId, opts?: { cash?: number; age?: number; skill?: number; name?: string }): Person {
  // TODO(households)
  return null as unknown as Person;
}

/**
 * A person dies: leave job and home; estate = cash, IOUs, gold, owned firms and
 * houses. Charge 'estate' levies (payer 'receiver' on the estate value), then pass
 * everything to an heir (a random living person in the same town, preferring
 * non-owners with low wealth? → no: preferring a random adult) via ledger.pay
 * (flow 'estate'); ownership refs updated (firm.owner, building.owner, person.owns/houses).
 */
export function killPerson(s: SimState, p: Person, cause: 'age' | 'hunger' | 'other'): void {
  // TODO(households)
}

/** A person leaves the realm: cash → FOREIGN (pay flow 'migrate'), assets sold/transferred like an estate. */
export function emigrate(s: SimState, p: Person): void {
  // TODO(households)
}
