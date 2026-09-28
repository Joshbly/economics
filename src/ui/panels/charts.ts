// charts panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const chartsPanel: Panel = placeholderPanel('charts', 'Charts', {
    kicker: 'Time series',
    heading: 'The realm over time',
    lead: 'Every indicator the realm keeps, day by day and month by month.',
    bullets: ['Prices, inflation, wages and output', 'Money, credit and interest rates', 'Population, health and contentment'],
  });
