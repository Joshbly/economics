// ============================================================================
// Levers panel — one small stroke glyph per primitive (20×20 grid, currentColor),
// drawn in the same hand as widgets/icons.ts.
// ============================================================================

const NS = 'http://www.w3.org/2000/svg';

/** Path data per glyph; strings starting with 'F:' are filled shapes. */
const GLYPHS: Record<string, string[]> = {
  // a coin with a plus: create money
  mint: ['M10 3.2a6.8 6.8 0 110 13.6 6.8 6.8 0 010-13.6z', 'M10 6.8v6.4', 'M6.8 10h6.4'],
  // two opposed arrows: buy / sell
  trade: ['M4 7h11.5', 'M12.5 4l3 3-3 3', 'M16 13H4.5', 'M7.5 10l-3 3 3 3'],
  // a percent sign: a rate on a flow
  levy: ['M5 15.5L15 4.5', 'M6.4 4.4a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8z', 'M13.6 11.8a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8z'],
  // a line pressed flat under a cap
  limit: ['M3.5 5.2h13', 'M3.5 16l3.8-4.2 2.8 1.8 3.2-4.4 2.2-3.2'],
  // an arched window with a mullion
  window: ['M4.8 16.3V9a5.2 5.2 0 0110.4 0v7.3', 'M3.2 16.3h13.6', 'M10 3.9v12.4', 'M4.8 10.6h10.4'],
  // a house frame: build
  build: ['M3.2 16.4h13.6', 'M5.2 16.4V9.1L10 4.8l4.8 4.3v7.3', 'M8.4 16.4v-4.2h3.2v4.2'],
  // an arrow into a bar: hand over
  transfer: ['M3.5 10h9.5', 'M9.8 6.6L13.2 10l-3.4 3.4', 'M16.3 4.5v11'],
  // a ruled list: what is in force
  inforce: ['M7.5 5.5h9', 'M7.5 10h9', 'M7.5 14.5h6', 'F:M3.6 4.6h1.8v1.8H3.6z', 'F:M3.6 9.1h1.8v1.8H3.6z', 'F:M3.6 13.6h1.8v1.8H3.6z'],
  pin: ['M10 17s-5-4.8-5-8.7a5 5 0 0110 0c0 3.9-5 8.7-5 8.7z', 'M10 6.3a2 2 0 110 4 2 2 0 010-4z'],
  edit: ['M4.5 15.5l1-3.8 7.6-7.6 2.8 2.8-7.6 7.6z', 'M11.6 5.6l2.8 2.8'],
};

/** A lever glyph as an inline SVG (inherits colour from CSS `color`). */
export function glyph(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon lv-glyph-svg');
  for (const d of GLYPHS[name] ?? []) {
    const p = document.createElementNS(NS, 'path');
    if (d.startsWith('F:')) {
      p.setAttribute('d', d.slice(2));
      p.setAttribute('fill', 'currentColor');
    } else {
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.55');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    svg.appendChild(p);
  }
  return svg;
}
