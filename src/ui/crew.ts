// ============================================================================
// "Staff it with Treasury workers": after a Treasury project is commissioned (Build
// lever or a site chosen on the map), give its town an order for workers that staffs
// the Treasury's projects there automatically — unless the town already has one.
// The choice is remembered per viewer (a convenience, not game state).
// ============================================================================
import { AUTO_CREW_MAX } from '../sim/config';
import type { ActionResult, SimState, TownId } from '../sim/types';
import { act } from './uiState';

const KEY = 'realmLedger.autoCrew';

export function autoCrewOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoCrew(v: boolean): void {
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts this session only */
  }
}

/** Make sure the town's Treasury projects will be staffed (no-op if it already has an order for workers). */
export function ensureCrew(s: SimState, town: TownId): ActionResult | null {
  if (!autoCrewOn() || !(town >= 0 && town < s.towns.length)) return null;
  if (s.policy.orders.some((o) => o.market.kind === 'labor' && o.market.town === town && o.enabled)) return null;
  return act({ type: 'placeOrder', market: { kind: 'labor', town }, side: 'buy', price: 0, qty: AUTO_CREW_MAX, priceMode: 'follow', band: 0.1, staff: 'projects' });
}
