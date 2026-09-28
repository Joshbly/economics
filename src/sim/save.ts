// Save / load. OWNER: stats agent.
import type { SimState } from './types';

/** Serialise the whole state to JSON (compact). */
export function serialize(s: SimState): string {
  return JSON.stringify(s);
}

/** Parse and validate a saved game; throws Error with a readable message if invalid. */
export function deserialize(json: string): SimState {
  // TODO(stats): version check, basic shape validation, migrate if needed.
  return JSON.parse(json) as SimState;
}
