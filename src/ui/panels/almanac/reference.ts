// ============================================================================
// Almanac reference tables, generated from the game's own data (goods.ts):
//   Goods     — made by, inputs per unit, what it is used for, spoilage, abroad
//   Workshops — output & recipe, workers per level, tools per worker, where it
//               can be built, what a new one takes to build
// ============================================================================
import { GOODS, PRODUCER_OF, SECTORS, type SectorDef, type SiteKind } from '../../../sim/goods';
import type { Sector } from '../../../sim/types';
import { h, type Child } from '../../dom';
import { fmtInt, fmtNum } from '../../format';
import { goodColor, swatch } from '../../widgets';
import { inline, type Highlight } from './markup';

const HOUSEHOLD_USE: Record<string, string> = {
  fish: 'food',
  bread: 'food',
  coal: 'heating',
  ale: 'drink',
  furniture: 'comfort at home',
};

const SITE: Record<SiteKind, [string, string]> = {
  grass: ['grassland', 'Open grassland; richer soil gives bigger harvests'],
  coast: ['coast', 'On the coast, next to fishing water; richer water, bigger catches'],
  forest: ['forest', 'In forest; denser timber, more wood'],
  hills: ['hills', 'In the hills, on a coal seam; richer seams, more coal'],
  mountain: ['mountains', 'On the mountain slopes, on an ore vein'],
  marsh: ['marsh', 'On a marsh oil seep'],
  town: ['any town', 'Inside any town'],
};

/** "Bakery" → "bakeries", "Toolworks" → "toolworks". */
function pluralName(name: string): string {
  const n = name.toLowerCase();
  if (/works$/.test(n)) return n;
  if (/[^aeiou]y$/.test(n)) return n.slice(0, -1) + 'ies';
  if (/(?:s|x|z|ch|sh)$/.test(n)) return n + 'es';
  return n + 's';
}

const SERVICE_NOTE: Partial<Record<Sector, string>> = {
  builder: 'Builds houses, workshops, roads and piers from labour, wood, iron and tools.',
  trader: 'Carries goods between towns by wagon; each wagon needs a carter and burns oil.',
  stateworks: 'The Treasury’s own workforce in each town: hired through the labour market, they work on Treasury projects for free.',
};

function unitPlural(u: string, n: number): string {
  if (Math.abs(n - 1) < 1e-9) return u;
  if (/(?:f|fe)$/.test(u)) return u.replace(/fe?$/, 'ves');
  if (/(?:s|x|z|ch|sh)$/.test(u)) return u + 'es';
  return u + 's';
}

/** "2 ore + 1 coal" for a sector's inputs. */
export function recipeText(d: SectorDef): string {
  if (!d.inputs.length) return 'labour and tools only';
  return d.inputs.map(([g, q]) => `${fmtNum(q)} ${GOODS[g].name.toLowerCase()}`).join(' + ');
}

function usedBy(g: number): string[] {
  const out: string[] = [];
  const hh = HOUSEHOLD_USE[GOODS[g].key];
  if (hh) out.push(`households (${hh})`);
  for (const k of Object.keys(SECTORS) as Sector[]) {
    const d = SECTORS[k];
    if (d.inputs.some(([x]) => x === g)) out.push(pluralName(d.name));
  }
  if (g === 7) out.push('every workshop, as equipment');
  if (g === 4) out.push('wagons, as fuel');
  if (g === 2 || g === 6 || g === 7) out.push('builders');
  return out;
}

export interface RefRow {
  kind: 'good' | 'sector';
  id: string;
  name: string;
  text: string;
}

/** Search index for the reference tables. */
export function referenceIndex(): RefRow[] {
  const rows: RefRow[] = GOODS.map((g) => {
    const sec = PRODUCER_OF[g.id];
    return { kind: 'good', id: g.key, name: g.name, text: [g.name, g.blurb, sec ? SECTORS[sec].name : '', usedBy(g.id).join(' ')].join(' ').toLowerCase() };
  });
  for (const k of Object.keys(SECTORS) as Sector[]) {
    const d = SECTORS[k];
    rows.push({ kind: 'sector', id: k, name: d.name, text: [d.name, d.worker, d.out >= 0 ? GOODS[d.out].name : '', SERVICE_NOTE[k] ?? ''].join(' ').toLowerCase() });
  }
  return rows;
}

function cell2(main: Child, sub: Child, cls = ''): HTMLElement {
  return h('div', { class: 'alm-c2 ' + cls }, h('div', { class: 'alm-c2a' }, main), sub ? h('div', { class: 'alm-c2b' }, sub) : null);
}

export function goodsTable(hl: Highlight): HTMLElement {
  const rows = GOODS.map((g) => {
    const sec = PRODUCER_OF[g.id];
    const d = sec ? SECTORS[sec] : undefined;
    const uses = usedBy(g.id);
    return h(
      'tr',
      { id: 'alm-good-' + g.key, dataset: { ref: 'good:' + g.key } },
      h('td', null, cell2(h('span', { class: 'alm-good' }, swatch(goodColor(g.id), 'dot'), inline(h('span'), g.name, hl)), d ? inline(h('span'), `${d.name} · per ${g.unit}`, hl) : '')),
      h(
        'td',
        null,
        h('div', { class: 'alm-flow' }, h('span', { class: 'alm-flow-k' }, 'from'), d ? inline(h('span'), recipeText(d), hl) : h('span', null, '—')),
        h('div', { class: 'alm-flow' }, h('span', { class: 'alm-flow-k' }, 'for'), uses.length ? inline(h('span'), uses.join(', '), hl) : h('span', { class: 'faint' }, 'trade only')),
      ),
      h(
        'td',
        { class: 'al-right' },
        h('div', { class: 'nowrap' + (g.spoil >= 0.03 ? ' warn' : g.spoil > 0 ? '' : ' faint') }, g.spoil > 0 ? `${fmtNum(g.spoil * 100)}% a day` : 'keeps'),
        h('div', { class: 'alm-c2b nowrap' + (g.tradable ? ' gold' : '') }, g.tradable ? 'ships carry it' : 'home only'),
      ),
    );
  });
  return h(
    'div',
    { class: 'alm-ref-wrap' },
    h(
      'table',
      { class: 'alm-ref' },
      h('colgroup', null, h('col', { style: { width: '29%' } }), h('col'), h('col', { style: { width: '25%' } })),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { class: 'al-left' }, 'Good'),
          h('th', { class: 'al-left', title: 'Materials used up per unit made, and who uses the good' }, 'Made from · used for'),
          h('th', { class: 'al-right', title: 'Share lost each day wherever it is stored · whether foreign ships trade it at the port' }, 'Spoils · abroad'),
        ),
      ),
      h('tbody', null, rows),
    ),
  );
}

export function workshopsTable(hl: Highlight): HTMLElement {
  const keys = Object.keys(SECTORS) as Sector[];
  const rows = keys.flatMap((k) => {
    const d = SECTORS[k];
    const b = d.buildCost;
    const build = k === 'stateworks' ? 'Hired through the labour market, not built.' : `To build: ${fmtInt(b.labor)} worker-days, ${fmtInt(b.wood)} wood, ${fmtInt(b.iron)} iron, ${fmtInt(b.tools)} tools.`;
    const rate = d.out >= 0 ? `A worker makes about ${fmtNum(d.prodPerWorker)} ${unitPlural(GOODS[d.out].unit, d.prodPerWorker)} a day with full tools. ` : (SERVICE_NOTE[k] ?? '') + ' ';
    const [where, whereHint] = SITE[d.site] ?? [d.site, ''];
    return [
      h(
        'tr',
        { class: 'alm-ws-main', id: 'alm-sector-' + k, dataset: { ref: 'sector:' + k } },
        h('td', null, cell2(inline(h('span', { class: 'strong' }), d.name, hl), `${d.worker}s`)),
        h(
          'td',
          null,
          cell2(
            d.out >= 0 ? h('span', { class: 'alm-good' }, swatch(goodColor(d.out), 'dot'), inline(h('span'), GOODS[d.out].name, hl)) : h('span', { class: 'muted' }, 'a service'),
            d.out >= 0 && d.inputs.length ? inline(h('span'), 'from ' + recipeText(d), hl) : null,
            'alm-makes',
          ),
        ),
        h(
          'td',
          { class: 'al-right' },
          h('div', { class: 'nowrap' }, k === 'stateworks' ? 'any number' : `${fmtInt(d.capacityPerLevel)} a level`),
          h('div', { class: 'alm-c2b nowrap' }, d.toolsPerWorker > 0 ? `${fmtNum(d.toolsPerWorker)} ${d.toolsPerWorker === 1 ? 'tool' : 'tools'} each` : 'no tools'),
        ),
        h('td', { class: 'alm-where', title: whereHint }, inline(h('span'), where, hl)),
      ),
      h('tr', { class: 'alm-ws-sub', dataset: { ref: 'sector:' + k + ':sub' } }, h('td', { colSpan: 4 }, inline(h('span'), rate + build, hl))),
    ];
  });
  return h(
    'div',
    { class: 'alm-ref-wrap' },
    h(
      'table',
      { class: 'alm-ref alm-ref-ws' },
      h('colgroup', null, h('col', { style: { width: '27%' } }), h('col'), h('col', { style: { width: '22%' } }), h('col', { style: { width: '22%' } })),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { class: 'al-left' }, 'Workshop'),
          h('th', { class: 'al-left' }, 'Makes'),
          h('th', { class: 'al-right', title: 'Workers each building level can hold · tools each worker needs to work at full pace' }, 'Crew · tools'),
          h('th', { class: 'al-left', title: 'Where it can be built' }, 'Where'),
        ),
      ),
      h('tbody', null, rows),
    ),
  );
}
