// ============================================================================
// Who owns a firm, and in what shares. OWNER: firms agent. See DESIGN §3.2.
//
// A firm has a controlling owner (`Firm.owner`: the holder of the largest share,
// who runs it, tops up its cash and decides on its ventures) and may have other
// part-owners (`Firm.partners`: each a person or a firm with a share of the firm;
// the owner holds the rest). Everything a firm pays its owners — dividends, what is
// left when it winds up, the price when it is sold — is paid to every holder by
// share. A person's `owns` lists every firm they hold any share of. Stakes pass
// with estates like any other property (demography.passAssets). Sales of stakes
// and of whole firms are agents/invest.ts.
// ============================================================================
import { isFirm, isPerson, pay, refId } from '../ledger';
import type { Firm, Ref, SimState } from '../types';
import { STATE } from '../types';
import { fin } from '../util';

/** Shares below this are dropped (dust). */
const DUST = 1e-6;

export interface Holding {
  ref: Ref;
  share: number;
}

/** Every holder of the firm and their share (the controlling owner first), summing to 1. */
export function holders(f: Firm): Holding[] {
  const ps = f.partners ?? [];
  let others = 0;
  for (const p of ps) others += Math.max(0, fin(p.share));
  const out: Holding[] = [{ ref: f.owner, share: Math.max(0, 1 - others) }];
  for (const p of ps) if (p.share > DUST) out.push({ ref: p.ref, share: p.share });
  return out;
}

/** The share of `f` held by `ref` (0 if none). */
export function stakeOf(f: Firm, ref: Ref): number {
  let x = 0;
  for (const h of holders(f)) if (h.ref === ref) x += h.share;
  return x;
}

/** True while `f` runs as a Treasury works (agents/works.ts): open, and flagged as one. */
export function isWorks(f: Firm | undefined): boolean {
  return !!f && !!f.works && f.alive && f.status === 'active';
}

/** True if the Treasury holds all of `f` (no other holder). */
export function whollyTreasury(f: Firm): boolean {
  return f.owner === STATE && !(f.partners && f.partners.some((p) => p.share > DUST));
}

/** True if `ref` holds any share of `f`. */
export function holdsStake(f: Firm, ref: Ref): boolean {
  return stakeOf(f, ref) > DUST;
}

/** Where a payment to a holder can go: a living person, a live firm other than this one, else the Treasury. */
function payee(s: SimState, f: Firm, ref: Ref): Ref {
  if (isPerson(ref)) return s.people[ref]?.alive ? ref : STATE;
  if (isFirm(ref)) {
    const o = s.firms[refId(ref)];
    return o && o.alive && o.id !== f.id ? ref : STATE;
  }
  return ref === STATE ? STATE : STATE;
}

/**
 * Pay `amount` from `from` to the holders of `f` by share (flow `flow`); a person's share counts
 * as earned today, a firm's lowers its other costs (income). Returns ¤ paid.
 */
export function payHolders(s: SimState, f: Firm, from: Ref, amount: number, flow: 'dividend' | 'transfer' | 'asset', earned = true, acc?: { state: number }): number {
  if (!(amount > 0.005)) return 0;
  let paid = 0;
  for (const h of holders(f)) {
    if (!(h.share > DUST)) continue;
    const to = payee(s, f, h.ref);
    const a = pay(s, from, to, amount * h.share, flow);
    paid += a;
    if (acc && to === STATE) acc.state += a;
    if (!earned) continue;
    if (isPerson(to)) s.people[to].earned += a;
    else if (isFirm(to)) s.firms[refId(to)].otherCosts -= a;
  }
  return paid;
}

/** Keep `owns` lists right for the people among a firm's holders (after any change of shares). */
function syncOwns(s: SimState, f: Firm, before: readonly Ref[]): void {
  const now = new Set(holders(f).filter((h) => h.share > DUST).map((h) => h.ref));
  for (const r of before) {
    if (now.has(r) || !isPerson(r)) continue;
    const p = s.people[r];
    if (!p) continue;
    const k = p.owns.indexOf(f.id);
    if (k >= 0) p.owns.splice(k, 1);
  }
  for (const r of now) {
    if (!isPerson(r)) continue;
    const p = s.people[r];
    if (p && p.alive && p.owns.indexOf(f.id) < 0) p.owns.push(f.id);
  }
}

/** Rewrite the holdings of `f` from a list (merging duplicates, dropping dust); the largest holder controls it. */
export function setHoldings(s: SimState, f: Firm, list: readonly Holding[]): void {
  const before = holders(f).map((h) => h.ref);
  const merged = new Map<Ref, number>();
  for (const h of list) if (h.share > DUST) merged.set(h.ref, (merged.get(h.ref) ?? 0) + h.share);
  let tot = 0;
  for (const v of merged.values()) tot += v;
  if (!(tot > DUST)) return;
  const arr = [...merged].map(([ref, share]) => ({ ref, share: share / tot }));
  // the largest holder controls it (the present owner keeps control on a tie)
  arr.sort((a, b) => b.share - a.share || (a.ref === f.owner ? -1 : b.ref === f.owner ? 1 : a.ref - b.ref));
  f.owner = arr[0].ref;
  const partners = arr.slice(1).map((h) => ({ ref: h.ref, share: Math.round(h.share * 1e9) / 1e9 }));
  if (partners.length) f.partners = partners;
  else delete f.partners;
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b && b.firm === f.id) b.owner = f.owner;
  syncOwns(s, f, before);
}

/** Move `share` of `f` (a fraction of the whole firm, at most what `from` holds) from `from` to `to`. */
export function transferStake(s: SimState, f: Firm, from: Ref, to: Ref, share: number): number {
  const hs = holders(f);
  const have = hs.filter((h) => h.ref === from).reduce((a, h) => a + h.share, 0);
  const x = Math.min(have, Math.max(0, share));
  if (!(x > DUST)) return 0;
  const list: Holding[] = [];
  for (const h of hs) list.push(h.ref === from ? { ref: from, share: h.share - (x * h.share) / have } : h);
  list.push({ ref: to, share: x });
  setHoldings(s, f, list);
  return x;
}

/** Everything `from` holds in every firm passes to `to` (an estate): stakes merge with any the heir already has. */
export function passStakes(s: SimState, from: Ref, to: Ref): void {
  for (const f of s.firms) {
    if (!f || !f.alive) continue;
    if (!holdsStake(f, from)) continue;
    const list = holders(f).map((h) => (h.ref === from ? { ref: to, share: h.share } : h));
    setHoldings(s, f, list);
  }
}

/** A firm has closed: it drops out of its people-holders' `owns` lists (its holdings stay on record). */
export function releaseHolders(s: SimState, f: Firm): void {
  for (const h of holders(f)) {
    if (!isPerson(h.ref)) continue;
    const p = s.people[h.ref];
    if (!p) continue;
    const k = p.owns.indexOf(f.id);
    if (k >= 0) p.owns.splice(k, 1);
  }
}

/** Firms in which `ref` holds a share, with the share. */
export function stakesOf(s: SimState, ref: Ref): { firm: Firm; share: number }[] {
  const out: { firm: Firm; share: number }[] = [];
  if (isPerson(ref)) {
    const p = s.people[ref];
    if (!p) return out;
    for (const id of p.owns) {
      const f = s.firms[id];
      if (!f || !f.alive) continue;
      const x = stakeOf(f, ref);
      if (x > DUST) out.push({ firm: f, share: x });
    }
    return out;
  }
  for (const f of s.firms) {
    if (!f || !f.alive) continue;
    const x = stakeOf(f, ref);
    if (x > DUST) out.push({ firm: f, share: x });
  }
  return out;
}
