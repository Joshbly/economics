// ============================================================================
// Sidebar panel registry. Tab order = array order.
//
// PANEL ENGINEERS: replace a placeholder with your panel by importing it and
// swapping the entry, e.g.
//     import { leversPanel } from './levers';
//     …
//     leversPanel,
// Keep the ids (they are TabIds used by setTab / keyboard shortcuts) and the
// order. See ../panel.ts for the contract and ../widgets/* for building blocks.
// ============================================================================
import type { Panel } from '../panel';
import type { TabId } from '../uiState';
import { placeholderPanel } from './placeholder';

export const PANELS: Panel[] = [
  placeholderPanel('levers', 'Levers', {
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
  }),
  placeholderPanel('markets', 'Markets', {
    kicker: 'Daily call auctions',
    heading: 'Every town, every good',
    lead: 'Each town clears one auction per good at midday. This tab will show the demand and supply curves behind every price.',
    bullets: ['Price & volume history per market', 'Today’s demand and supply curves, the levy wedge and any legal limit', 'Shortages, surpluses and your own standing orders'],
  }),
  placeholderPanel('ledger', 'Ledger', {
    kicker: 'The books',
    heading: 'Where the money went',
    lead: 'The Treasury’s own accounts, the bank’s balance sheet and the realm’s national accounts.',
    bullets: ['Purse income and outgoings by category', 'The bank: reserves, loans, deposits, equity', 'Output, spending, trade with the outside world'],
  }),
  placeholderPanel('charts', 'Charts', {
    kicker: 'Time series',
    heading: 'The realm over time',
    lead: 'Every indicator the realm keeps, day by day and month by month.',
    bullets: ['Prices, inflation, wages and output', 'Money, credit and interest rates', 'Population, health and contentment'],
  }),
  placeholderPanel('people', 'People', {
    kicker: 'Households',
    heading: 'Who lives here, and how',
    lead: 'The realm’s households: jobs, wealth, health and homes.',
    bullets: ['Distributions of wealth, income and health', 'Jobless, hungry and homeless by town', 'Search and inspect any household'],
  }),
  placeholderPanel('almanac', 'Almanac', {
    kicker: 'How the realm works',
    heading: 'The Almanac',
    lead: 'Plain-language notes on markets, money, the bank, work and the outside world.',
    bullets: ['You, the Treasury', 'Markets and prices', 'Money and the bank', 'Work, wages and people'],
  }),
  placeholderPanel('inspect', 'Inspect', {
    kicker: 'Inspector',
    heading: 'Look closer',
    lead: 'Click anything on the map — a building, a person, a town — to see its books here.',
    bullets: ['Workshops: workers, output, prices, cash, loans', 'Households: job, pantry, health, savings', 'Towns: prices, jobs, housing'],
  }),
];

/** Find a panel by tab id. */
export function panelById(id: TabId): Panel | undefined {
  return PANELS.find((p) => p.id === id);
}
