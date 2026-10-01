// ============================================================================
// Small inline SVG icon set (stroke icons on a 20×20 grid, currentColor).
//   icon('pause'), icon('menu', 16)
// ============================================================================

const NS = 'http://www.w3.org/2000/svg';

/** Path data per icon; strings starting with 'F:' are filled shapes. */
const PATHS: Record<string, string[]> = {
  pause: ['F:M6 4.5h2.6v11H6z', 'F:M11.4 4.5H14v11h-2.6z'],
  play: ['F:M6.5 4.2l9 5.8-9 5.8z'],
  menu: ['M3.5 6h13', 'M3.5 10h13', 'M3.5 14h13'],
  close: ['M5 5l10 10', 'M15 5L5 15'],
  chevronDown: ['M5.5 8l4.5 4.5L14.5 8'],
  chevronUp: ['M5.5 12l4.5-4.5 4.5 4.5'],
  chevronRight: ['M8 5.5l4.5 4.5L8 14.5'],
  plus: ['M10 4.5v11', 'M4.5 10h11'],
  save: ['M4.5 4.5h9l2 2v9h-11z', 'M7 4.5v4h6v-4', 'M7 15.5v-4h6v4'],
  load: ['M3.5 6.5v8.5h13V8h-7l-1.5-1.5z'],
  download: ['M10 3.5v9', 'M6.5 9l3.5 3.5L13.5 9', 'M4 16h12'],
  upload: ['M10 12.5v-9', 'M6.5 7L10 3.5 13.5 7', 'M4 16h12'],
  book: ['M4 4.5h5a1.5 1.5 0 011.5 1.5v10a1.5 1.5 0 00-1.5-1.5H4z', 'M16 4.5h-5A1.5 1.5 0 009.5 6v10a1.5 1.5 0 011.5-1.5h5z'],
  warning: ['M10 3.5l7 12.5H3z', 'M10 8.5v3.5', 'F:M9.2 13.4h1.6V15H9.2z'],
  info: ['M10 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z', 'M10 9v4.5', 'F:M9.2 6h1.6v1.6H9.2z'],
  check: ['M4.5 10.5l3.5 3.5 7.5-8'],
  dice: ['M4.5 4.5h11v11h-11z', 'F:M7 7h1.8v1.8H7z', 'F:M11.2 11.2H13V13h-1.8z', 'F:M9.1 9.1h1.8v1.8H9.1z'],
  crown: ['M3.5 14.5l1-8 3.5 3 2-5 2 5 3.5-3 1 8z', 'M4 16.5h12'],
  news: ['M4 5h9.5v10.5H5.5A1.5 1.5 0 014 14z', 'M13.5 8H16v6a1.5 1.5 0 01-1.5 1.5', 'M6.5 8h4.5', 'M6.5 10.5h4.5', 'M6.5 13h3'],
  target: ['M10 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z', 'M10 7a3 3 0 110 6 3 3 0 010-6z'],
  sliders: ['M4 6h7', 'M14 6h2', 'M4 14h2', 'M9 14h7', 'M12.5 4.5v3', 'M7.5 12.5v3'],
  refresh: ['M15.5 9A5.5 5.5 0 105 13.5', 'M15.5 4.5V9H11'],
  copy: ['M7 7h8.5v8.5H7z', 'M13 7V4.5H4.5V13H7'],
  trash: ['M4.5 6h11', 'M8 6V4.5h4V6', 'M6 6l.7 9.5h6.6L14 6'],
};

/** Create an SVG icon element (inherits colour from CSS `color`). */
export function icon(name: keyof typeof PATHS | string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon icon-' + name);
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(NS, 'path');
    if (d.startsWith('F:')) {
      p.setAttribute('d', d.slice(2));
      p.setAttribute('fill', 'currentColor');
    } else {
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    svg.appendChild(p);
  }
  return svg;
}

/** Speed glyph: n small chevrons (1..5), for the speed control. */
export function speedIcon(n: number, size = 18): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  const w = 20;
  svg.setAttribute('viewBox', `0 0 ${w} 20`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon icon-speed');
  const k = Math.max(1, Math.min(5, n));
  const tri = 5.2;
  const gap = k <= 1 ? 0 : Math.min(3.4, (w - 6 - tri) / (k - 1));
  const total = tri + gap * (k - 1);
  const x0 = (w - total) / 2;
  for (let i = 0; i < k; i++) {
    const x = x0 + i * gap;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', `M${x.toFixed(2)} 5.5l${tri} 4.5-${tri} 4.5z`);
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('opacity', String(0.7 + (0.3 * (i + 1)) / k));
    svg.appendChild(p);
  }
  return svg;
}
