// ledger panel — placeholder until its engineer implements it.
import type { Panel } from '../panel';
import { placeholderPanel } from './placeholder';

export const ledgerPanel: Panel = placeholderPanel('ledger', 'Ledger', {
    kicker: 'The books',
    heading: 'Where the money went',
    lead: 'The Treasury’s own accounts, the bank’s balance sheet and the realm’s national accounts.',
    bullets: ['Purse income and outgoings by category', 'The bank: reserves, loans, deposits, equity', 'Output, spending, trade with the outside world'],
  });
