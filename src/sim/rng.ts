// Deterministic RNG (xoshiro128**). State lives in `holder.rng` (4 uint32 words)
// so it is saved with the game. Never use Math.random() inside src/sim.

export interface RngHolder {
  rng: number[];
}

function splitmix32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Fresh RNG state from an integer seed. */
export function seedRng(seed: number): number[] {
  const sm = splitmix32(seed >>> 0);
  const st = [sm(), sm(), sm(), sm()];
  if ((st[0] | st[1] | st[2] | st[3]) === 0) st[0] = 1;
  return st;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Uniform float in [0, 1). */
export function rand(h: RngHolder): number {
  const s = h.rng;
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result / 4294967296;
}

/** Integer in [0, n). */
export function randInt(h: RngHolder, n: number): number {
  return Math.floor(rand(h) * n);
}

/** Float in [a, b). */
export function randRange(h: RngHolder, a: number, b: number): number {
  return a + (b - a) * rand(h);
}

export function chance(h: RngHolder, p: number): boolean {
  return rand(h) < p;
}

export function pick<T>(h: RngHolder, arr: readonly T[]): T {
  return arr[Math.floor(rand(h) * arr.length)];
}

/** Standard normal (Box–Muller). */
export function normal(h: RngHolder): number {
  let u = rand(h);
  if (u < 1e-12) u = 1e-12;
  const v = rand(h);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lognormal with median `median` and log-sd `sigma`. */
export function lognormal(h: RngHolder, median: number, sigma: number): number {
  return median * Math.exp(sigma * normal(h));
}

/** In-place Fisher–Yates shuffle. */
export function shuffle<T>(h: RngHolder, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(h) * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * A draw for one decision, from the realm's seed and what is being decided (`keys`: the day, the
 * town, the trade, the firm…) — not from the running stream, so the same decision draws the same
 * number however the day got there. The investors' discrete choices use it (whether a venture goes
 * ahead, who joins a syndicate, which firms come up for sale, which loss-maker gives up): two runs
 * of a realm that differ only in a policy then make the same draws for the same decisions and
 * differ only where the policy changes the odds (common random numbers). Uniform in [0, 1).
 */
/** The seed decision draws start from: the realm's, salted for an experiment's replica (SimState.drawSalt). */
export function decisionSeed(s: { seed: number; drawSalt?: number }): number {
  const k = s.drawSalt ?? 0;
  return k ? (s.seed ^ Math.imul(k | 0, 0x9e3779b1)) >>> 0 : s.seed;
}

export function decisionRand(seed: number, ...keys: number[]): number {
  let h = (seed ^ 0x2545f491) >>> 0;
  for (const k of keys) {
    h = Math.imul(h ^ (k | 0), 0x9e3779b1) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h / 4294967296;
}
