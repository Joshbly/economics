// people panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const peoplePanel: Panel = placeholderPanel('people', 'People', {
    kicker: 'Households',
    heading: 'Who lives here, and how',
    lead: 'The realm’s households: jobs, wealth, health and homes.',
    bullets: ['Distributions of wealth, income and health', 'Jobless, hungry and homeless by town', 'Search and inspect any household'],
  });
