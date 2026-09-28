// almanac panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const almanacPanel: Panel = placeholderPanel('almanac', 'Almanac', {
    kicker: 'How the realm works',
    heading: 'The Almanac',
    lead: 'Plain-language notes on markets, money, the bank, work and the outside world.',
    bullets: ['You, the Treasury', 'Markets and prices', 'Money and the bank', 'Work, wages and people'],
  });
