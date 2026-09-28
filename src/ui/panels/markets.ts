// markets panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const marketsPanel: Panel = placeholderPanel('markets', 'Markets', {
    kicker: 'Daily call auctions',
    heading: 'Every town, every good',
    lead: 'Each town clears one auction per good at midday. This tab will show the demand and supply curves behind every price.',
    bullets: ['Price & volume history per market', 'Today’s demand and supply curves, the levy wedge and any legal limit', 'Shortages, surpluses and your own standing orders'],
  });
