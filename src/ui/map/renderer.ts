// Map view contract. OWNER: renderer agent.
// The app shell creates exactly one MapView inside the map container and calls
// frame() on every animation frame (after the game loop advanced ui.dayFrac).
import { createMapViewImpl } from './view';

export interface MapView {
  /** Draw one frame. dt = seconds since last frame. */
  frame(dt: number): void;
  /** Container size changed. */
  resize(): void;
  /** Pan the camera to centre on a tile. */
  centerOn(x: number, y: number): void;
  /** Rebuild cached layers (after load / new game). */
  reset(): void;
  destroy(): void;
}

/**
 * Create the map inside `container` (terrain, buildings, people, wagons,
 * smoke, day/night, overlays, labels, pan/zoom/hover/select/placement and a
 * small control strip). Reads the global UI state (uiState.ui) every frame;
 * never mutates the simulation except through ui.game.dispatch (placement).
 */
export function createMapView(container: HTMLElement): MapView {
  return createMapViewImpl(container);
}
