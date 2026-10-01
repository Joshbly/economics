# Realm Ledger — project notes for Claude

Agent-based economic simulation game (TypeScript, no runtime deps). The player
is the realm's Treasury/central bank and acts only through primitives
(Mint, Trade, Levy, Limit, Window, Build, Transfer). Full spec: `DESIGN.md`.

## Commands
- `npm run typecheck` — tsc (strict). Must be clean.
- `npm test` — vitest (tests/**/*.test.ts).
- `npm run sim -- --years 5 --seed 1` — headless run printing indicators.
- `npm run experiments` — policy experiments vs baseline (directional checks).
- `npm run build` — single-file `EconSim.html` (double-click to play on a Mac).
- `npm run dev` — dev server with auto-reload on http://localhost:8000.

## Architecture rules
- `src/sim/**` never touches the DOM; `src/ui/**` never mutates sim state except
  via `game.dispatch(action)`.
- `src/sim/types.ts` is the contract. State is plain JSON (no classes/Maps/Sets/
  typed arrays/NaN/Infinity; -1 = none). Rebuildable caches go in `runtime.ts`.
- All randomness via `src/sim/rng.ts` (state in `s.rng`). Never `Math.random()` in sim.
- All money moves via `src/sim/ledger.ts` (`pay`, `disburse`, `repayPrincipal`,
  `writeOff`, `windowBorrow`, ...). Never assign `cash`/`purse`/`reserves` directly
  elsewhere (world init excepted, followed by `reconcileBank`).
- Every tunable constant lives in `src/sim/config.ts`.
- The daily order of operations is fixed in `src/sim/engine.ts`.
- Pure economic math shared by behaviour and calibration: `agents/demandModel.ts`,
  `agents/production.ts`.
- Player-facing text never uses modern policy names (no "subsidy", "tax", "QE",
  "UBI", "tariff", "minimum wage"...). Describe mechanics neutrally.
