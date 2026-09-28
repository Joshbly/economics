// ============================================================================
// DPR-aware canvas host shared by every chart widget.
//
//  * Two stacked canvases: `base` (the chart, redrawn when data/size change)
//    and `overlay` (hover crosshair/markers, redrawn on pointer move), so hover
//    never re-renders thousands of points.
//  * Sizes itself from its wrapper via ResizeObserver and redraws synchronously
//    inside the observer callback (no stretched-canvas flash on resize).
//  * Tracks devicePixelRatio changes (moving a window between displays).
//  * Draws in CSS pixels: the context is pre-scaled by DPR. Use snap() to put
//    hairlines on the device-pixel grid so they stay crisp.
//  * Skips drawing while hidden (0×0, e.g. an inactive tab) and catches up the
//    moment it becomes visible.
// ============================================================================
import { h } from '../dom';

export interface CanvasHostOptions {
  /** Fixed CSS height in px. Omit to fill the parent (wrapper gets height:100%). */
  height?: number;
  className?: string;
  /** Draw the static layer. Context is cleared and scaled to CSS px. */
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Draw the hover layer (optional). */
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  onMove?: (x: number, y: number, e: PointerEvent) => void;
  onLeave?: () => void;
  onClick?: (x: number, y: number, e: PointerEvent) => void;
  /** ARIA label for the canvas (charts should also offer a table/text view). */
  label?: string;
}

export interface CanvasHost {
  /** Wrapper element to insert into the page. */
  el: HTMLDivElement;
  base: HTMLCanvasElement;
  over: HTMLCanvasElement;
  /** Current CSS size and device pixel ratio. */
  readonly w: number;
  readonly h: number;
  readonly dpr: number;
  /** Coalesced (next animation frame) redraw of both layers. */
  redraw(): void;
  /** Redraw both layers right now (if visible). */
  redrawNow(): void;
  /** Coalesced redraw of the hover layer only. */
  redrawOverlay(): void;
  setHeight(px: number): void;
  destroy(): void;
}

/** Put a coordinate on the device-pixel grid for a line of `lw` CSS px. */
export function snap(v: number, dpr: number, lw = 1): number {
  const dev = Math.max(1, Math.round(lw * dpr));
  const px = Math.round(v * dpr);
  return (dev % 2 === 1 ? px + 0.5 : px) / dpr;
}

export function createCanvasHost(opts: CanvasHostOptions): CanvasHost {
  const base = h('canvas', { class: 'cv-base', 'aria-label': opts.label ?? null, role: opts.label ? 'img' : null });
  const over = h('canvas', { class: 'cv-over', 'aria-hidden': 'true' });
  const el = h('div', { class: 'cv-host' + (opts.className ? ' ' + opts.className : '') }, base, over);
  if (opts.height !== undefined) el.style.height = opts.height + 'px';
  else el.style.height = '100%';
  const bctx = base.getContext('2d')!;
  const octx = over.getContext('2d')!;

  let w = 0;
  let hgt = 0;
  let dpr = 1;
  let pending = 0;
  let pendingOverlay = 0;
  let destroyed = false;

  function measure(): boolean {
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const d = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (cw <= 0 || ch <= 0) return false;
    if (cw !== w || ch !== hgt || d !== dpr) {
      w = cw;
      hgt = ch;
      dpr = d;
      for (const c of [base, over]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(hgt * dpr);
        c.style.width = w + 'px';
        c.style.height = hgt + 'px';
      }
    }
    return true;
  }

  function paintBase(): void {
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      opts.draw(bctx, w, hgt);
    } catch (e) {
      console.error('[chart] draw failed', e);
    }
  }

  function paintOverlay(): void {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, over.width, over.height);
    if (!opts.overlay) return;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      opts.overlay(octx, w, hgt);
    } catch (e) {
      console.error('[chart] overlay failed', e);
    }
  }

  function redrawNow(): void {
    if (destroyed) return;
    if (!measure()) return; // hidden: the ResizeObserver will call us when shown
    paintBase();
    paintOverlay();
  }

  const ro = new ResizeObserver(() => redrawNow());
  ro.observe(el);

  // DPR changes (window moved to another display, browser zoom).
  let mq: MediaQueryList | null = null;
  const onDpr = () => {
    watchDpr();
    redrawNow();
  };
  function watchDpr(): void {
    mq?.removeEventListener?.('change', onDpr);
    try {
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener?.('change', onDpr);
    } catch {
      mq = null;
    }
  }
  watchDpr();

  const local = (e: PointerEvent): [number, number] => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  if (opts.onMove) el.addEventListener('pointermove', (e) => opts.onMove!(...local(e), e));
  if (opts.onLeave) el.addEventListener('pointerleave', () => opts.onLeave!());
  if (opts.onClick) el.addEventListener('click', (e) => opts.onClick!(...local(e as PointerEvent), e as PointerEvent));

  return {
    el,
    base,
    over,
    get w() {
      return w;
    },
    get h() {
      return hgt;
    },
    get dpr() {
      return dpr;
    },
    redraw() {
      if (pending || destroyed) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        redrawNow();
      });
    },
    redrawNow,
    redrawOverlay() {
      if (pendingOverlay || destroyed) return;
      pendingOverlay = requestAnimationFrame(() => {
        pendingOverlay = 0;
        if (measure()) paintOverlay();
      });
    },
    setHeight(px: number) {
      const v = Math.max(1, Math.round(px)) + 'px';
      if (el.style.height !== v) el.style.height = v;
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
      mq?.removeEventListener?.('change', onDpr);
      if (pending) cancelAnimationFrame(pending);
      if (pendingOverlay) cancelAnimationFrame(pendingOverlay);
      el.remove();
    },
  };
}

/** Draw text with a background pill (for labels sitting on lines). */
export function pillText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { align?: CanvasTextAlign; fill: string; bg: string; padX?: number; h?: number; radius?: number; border?: string },
): number {
  const padX = opts.padX ?? 5;
  const hh = opts.h ?? 16;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  let x0 = x;
  if (opts.align === 'right' || opts.align === 'end') x0 = x - bw;
  else if (opts.align === 'center') x0 = x - bw / 2;
  ctx.fillStyle = opts.bg;
  roundRect(ctx, x0, y - hh / 2, bw, hh, opts.radius ?? 4);
  ctx.fill();
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = opts.fill;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + padX, y + 0.5);
  return bw;
}

/** Path a rounded rectangle (per-corner radii: [tl, tr, br, bl]). */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]): void {
  const [tl, tr, br, bl] = typeof r === 'number' ? [r, r, r, r] : r;
  const m = Math.max(0, Math.min(w / 2, h / 2));
  const c = (v: number) => Math.max(0, Math.min(v, m));
  ctx.beginPath();
  ctx.moveTo(x + c(tl), y);
  ctx.lineTo(x + w - c(tr), y);
  ctx.arcTo(x + w, y, x + w, y + c(tr), c(tr));
  ctx.lineTo(x + w, y + h - c(br));
  ctx.arcTo(x + w, y + h, x + w - c(br), y + h, c(br));
  ctx.lineTo(x + c(bl), y + h);
  ctx.arcTo(x, y + h, x, y + h - c(bl), c(bl));
  ctx.lineTo(x, y + c(tl));
  ctx.arcTo(x, y, x + c(tl), y, c(tl));
  ctx.closePath();
}

/** Truncate text with an ellipsis to fit `maxW` px in the current font. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? '' : text.slice(0, lo) + '…';
}
