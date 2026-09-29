# Realm Ledger

An agent-based economic simulation in which **you are the Treasury** of a small
realm — its mint, its central bank and its fiscal authority in one. Every
household, workshop, farm, mine, trading house and the bank is simulated
individually on a living map: people walk to work in the morning, wagons haul
grain and coal between towns, chimneys smoke when furnaces are busy, and prices
are discovered every day in real call auctions.

You get no ready-made "policies". You get **primitives**, and everything else
is something you discover:

| Lever | What it does, mechanically |
|-------|---------------------------|
| **Mint** | Create (or destroy) money in the Treasury's Purse. |
| **Trade** | Post buy/sell orders in *any* market — any good in any town, the labour market (hire Treasury workers), the IOU market (issue or retire perpetual IOUs), the gold market. Move goods between towns. |
| **Levy** | Attach a signed rate to any flow: sales of a good, wages (paid by worker or employer), profits, money held, goods held, each person, rent, interest, shipments, imports/exports, buildings, estates. Positive = you take. Negative = you pay. |
| **Limit** | Legal bounds: max/min prices, wages and rents; max loan rate; shipment, import and export caps; minimum bank reserve and capital ratios. |
| **Window** | The rate you pay on the bank's reserves and the rate you charge when it borrows from you. |
| **Build** | Commission roads, houses, workshops of any trade (Treasury-owned), piers. |
| **Transfer** | One-off payments to (or seizures from) a group. |

What happens if you pay 10 % of the value of every bread sale? If you buy all
the tools in Kingsbridge at twice the market price? If you cap the price of
bread? If you hire every jobless person to pave the road to Coalridge? If you
charge 15 % at the window? Try it.

## Play on a Mac

**Double-click `EconSim.html`.** It opens in Safari (or your default browser;
if another app grabs it, right-click → Open With → Safari) and runs entirely
offline — no install, no server. Safari 15.4 or newer, or any current Chrome,
Firefox or Edge, will do. The first year is simulated while you watch the
progress bar (a few seconds); then the realm is yours, paused. A short welcome
note explains the premise the first time; reopen it from the menu (☰ →
Welcome & controls). The **Almanac** tab explains how everything works.

Controls: <kbd>Space</kbd> pause / resume · <kbd>1</kbd>–<kbd>5</kbd> speed
(<kbd>0</kbd> pauses) · drag or two-finger scroll to pan · pinch or
<kbd>+</kbd>/<kbd>−</kbd> to zoom · click anything to inspect it ·
<kbd>Esc</kbd> to close or cancel · <kbd>[</kbd> <kbd>]</kbd> to switch tabs ·
<kbd>?</kbd> Almanac · <kbd>⌘S</kbd> save · <kbd>`</kbd> frame-rate overlay.

Saving: the realm autosaves in this browser every month and when you close
the tab; **Save** keeps a second copy you can return to with **Load saved
realm**. Saves live in the browser's storage for this file, so a private
window keeps nothing and clearing website data erases them — use **Export to
file…** to keep a realm as a `.json` file, and **Import from file…** to open
it again (in any browser, on any machine).

## Develop

Requires Node 18+.

```sh
npm install
npm run dev          # http://localhost:8000 with auto-reload
npm run build        # rebuilds the single-file EconSim.html
npm test             # unit + smoke tests
npm run typecheck
npm run sim -- --years 10 --seed 3     # headless run, prints indicators
npm run experiments                    # policy experiments vs a baseline
node scripts/qa/levers.mjs             # drive the built game in Chromium (also
                                       # interact, crawl, prefill, persist, sizes, perf)
```

`DESIGN.md` is the full specification of the economic model: goods and
recipes, production functions, household demand, labour and housing markets,
banking and money creation, shipping, the outside world, the call auction, and
the daily order of operations.

## The model in one breath

Eleven goods (grain, fish, wood, coal, oil, ore, iron, tools, bread, ale,
furniture) are produced by firms whose output depends on labour, tools (which
wear out) and material inputs, with decreasing returns on each site. Four towns
each run a daily uniform-price call auction per good; traders arbitrage price
gaps by wagon, paying drivers and burning oil, so shipping costs are real.
Households follow a buffer-stock savings rule and a linear-expenditure demand
system (bread and fish are substitutes), search for jobs and homes, fall ill
when hungry, have children, and emigrate when miserable — taking their money
with them. One commercial bank creates money by lending, holds reserves at the
Treasury, buys IOUs, and can fail. Foreign ships at the harbour trade at world
prices quoted in gold; the gold price is your exchange rate.
