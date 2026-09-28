// Map view contract. OWNER: renderer agent.
// The app shell creates exactly one MapView inside the map container and calls
// frame() on every animation frame (after the game loop advanced ui.dayFrac).
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

export function createMapView(container: HTMLElement): MapView {
  // TODO(renderer)
  const c = document.createElement('canvas');
  container.appendChild(c);
  return { frame() {}, resize() {}, centerOn() {}, reset() {}, destroy() { c.remove(); } };
}
