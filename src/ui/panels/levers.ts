// levers panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const leversPanel: Panel = placeholderPanel('levers', 'Levers', {
    kicker: 'The Treasury’s primitives',
    heading: 'Seven levers, no policies',
    lead: 'Everything you can do to the realm, composed from seven primitives. What they add up to is for you to discover.',
    bullets: [
      'Mint or destroy money in the Purse',
      'Trade in any market: goods, labour, IOUs, gold',
      'Attach a levy (or a payment) to any flow',
      'Draw legal limits on prices, wages, rents and rates',
      'Set the rates at the Treasury window',
      'Commission roads, houses, workshops and piers',
      'Make one-off transfers to a group',
    ],
  });
