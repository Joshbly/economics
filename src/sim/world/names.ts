// Name generation (people, firms, towns). OWNER: world agent.
import type { RngHolder } from '../rng';

export function personName(h: RngHolder): string {
  // TODO(world)
  return 'Someone';
}

export function townName(h: RngHolder, kind: string): string {
  // TODO(world)
  return kind;
}

export function firmName(h: RngHolder, sectorName: string, townName: string): string {
  // TODO(world)
  return sectorName;
}
