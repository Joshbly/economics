// inspect panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const inspectorPanel: Panel = placeholderPanel('inspect', 'Inspect', {
    kicker: 'Inspector',
    heading: 'Look closer',
    lead: 'Click anything on the map — a building, a person, a town — to see its books here.',
    bullets: ['Workshops: workers, output, prices, cash, loans', 'Households: job, pantry, health, savings', 'Towns: prices, jobs, housing'],
  });
