// ============================================================================
// Almanac markup → DOM (never innerHTML):
//   blank-line separated paragraphs · lines starting with "- " are bullets ·
//   **bold** · `code` · optional highlighting of search terms (<mark>).
// ============================================================================
import { h } from '../../dom';

export type Highlight = RegExp | null;

/** Build a case-insensitive highlighter for the words of a query (null for none). */
export function highlighter(query: string): Highlight {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return null;
  return new RegExp('(' + words.join('|') + ')', 'gi');
}

/** Append text to `el`, wrapping matches of `hl` in <mark>. */
function appendText(el: HTMLElement, text: string, hl: Highlight): void {
  if (!hl || !text) {
    el.appendChild(document.createTextNode(text));
    return;
  }
  hl.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = hl.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    el.appendChild(h('mark', { class: 'alm-mark' }, m[0]));
    last = m.index + m[0].length;
    if (m[0].length === 0) hl.lastIndex++;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

/** Inline markup: **bold** and `code`. */
export function inline(el: HTMLElement, text: string, hl: Highlight): HTMLElement {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) appendText(el, text.slice(last, m.index), hl);
    const tok = m[0];
    if (tok.startsWith('**')) appendText(el.appendChild(h('strong')), tok.slice(2, -2), hl);
    else appendText(el.appendChild(h('code', { class: 'alm-code' })), tok.slice(1, -1), hl);
    last = m.index + tok.length;
  }
  if (last < text.length) appendText(el, text.slice(last), hl);
  return el;
}

/** Render a section body into block nodes. */
export function renderBody(body: string, hl: Highlight): HTMLElement[] {
  const out: HTMLElement[] = [];
  const blocks = body.replace(/\r/g, '').split(/\n\s*\n/);
  for (const raw of blocks) {
    const lines = raw.split('\n').map((l) => l.trimEnd());
    if (!lines.some((l) => l.trim())) continue;
    let para: string[] = [];
    let list: HTMLElement | null = null;
    let item: string[] | null = null;
    const flushPara = () => {
      if (para.length) out.push(inline(h('p', { class: 'alm-p' }), para.join(' ').trim(), hl));
      para = [];
    };
    const flushItem = () => {
      if (item && list) list.appendChild(inline(h('li'), item.join(' ').trim(), hl));
      item = null;
    };
    const flushList = () => {
      flushItem();
      if (list) out.push(list);
      list = null;
    };
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (/^[-•]\s+/.test(t)) {
        flushPara();
        if (!list) list = h('ul', { class: 'alm-ul' });
        flushItem();
        item = [t.replace(/^[-•]\s+/, '')];
      } else if (item) item.push(t);
      else para.push(t);
    }
    flushList();
    flushPara();
  }
  return out;
}

/** Plain text of a body (for search). */
export function plainText(body: string): string {
  return body.replace(/\*\*|`/g, '').replace(/^[-•]\s+/gm, '');
}
