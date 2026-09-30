// ============================================================================
// The Almanac: how the realm works, written for the player. Mechanics only —
// never named policies. Each chapter is a list of sections with simple markup:
//   paragraphs separated by blank lines; lines starting with "- " are bullets;
//   **bold** and `code` are supported by the Almanac renderer.
// ============================================================================
import { BANK_MIN_CAPITAL, BANK_OWN_MIN_CAPITAL } from '../../sim/config';

/** 0.08 → "8%" (the Almanac quotes the realm's standing rules from the sim's own constants). */
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

export interface AlmanacSection {
  title: string;
  body: string;
}

export interface AlmanacChapter {
  id: string;
  title: string;
  sections: AlmanacSection[];
}

export const ALMANAC: AlmanacChapter[] = [
  {
    id: 'you',
    title: 'You, the Treasury',
    sections: [
      {
        title: 'What you are',
        body: `You are the Treasury of the realm: the mint, the keeper of the Purse, the bank's banker and the realm's largest possible buyer, seller, employer and builder — all at once.

You cannot command anyone. Households, workshops, the bank and foreign ships each decide for themselves every day. You can only change the world they decide in.

The Purse is the money you hold. Money only enters or leaves the realm's circulation through a handful of doors: you spending or collecting, the bank lending or being repaid, and coin crossing the border at the harbour.`,
      },
      {
        title: 'Your seven levers',
        body: `- **Mint** — create money in the Purse, or destroy money you hold.
- **Trade** — place buy or sell orders in any market: any good in any town, the labour market of a town, the IOU market, the gold market. Orders can be one-off, last a number of days, or stand until cancelled. **Carry** moves the goods you hold from your store in one town to your store in another, once or as a standing rule. Buying in one town and selling in another is simply a buy order there, a carry, and a sell order here — three rules, each listed and changed on its own.
- **Levy** — attach a rate to any flow in the economy. A positive rate means the Treasury takes a share; a negative rate means the Treasury pays out on that flow. A rule on sales of one good can instead aim at a price: its rate re-sets each morning, town by town, so that what buyers pay (or sellers receive) moves toward the price you set.
- **Limit** — make something illegal: a price, wage or rent above or below a line; a price moving more than a set share in a day; a loan rate above or below a line; more than a set quantity crossing between towns or the border; the bank holding too few reserves or too little capital (the standing 8 % rule can be raised or lowered).
- **Window** — set the rate you pay the bank on money it parks with you, and the rate you charge when it borrows from you.
- **Build** — commission roads, houses, workshops of any trade, or piers. A road can join two towns or run anywhere you draw it on the map — paved, or a cheaper dirt track; clearing forest, cutting hills, draining marsh and bridging rivers cost more. You pay the builders; your own workers help for free on your projects (the builders bill only for the rest). With *Staff it with Treasury workers automatically* on, the town then employs as many Treasury workers as its projects can use and lets them go as they finish — the **Works** tab shows who is where. You can also run your own freight line: Treasury wagons carrying the traders' goods between two towns.
- **Transfer** — a one-off payment to (or seizure from) a group of people, the bank, or the town councils; or a one-off handout of goods you hold in a town.

Everything else is up to you to discover.`,
      },
      {
        title: 'Auto-mint',
        body: `If **auto-mint** is on, whenever the Purse cannot cover a payment the Treasury creates the difference. If it is off, payments you promised through levies with negative rates and transfers are suspended while the Purse is empty, and you will be warned.`,
      },
    ],
  },
  {
    id: 'markets',
    title: 'Markets and prices',
    sections: [
      {
        title: 'The daily auction',
        body: `Every town holds a market for each good three times a day — at the **opening**, at **midday** and at the **close**. Buyers bring bids ("I will pay up to ¤5.10 for 3 loaves"), sellers bring asks ("I will sell 40 loaves for at least ¤4.20"). Each session finds the single price at which the most goods change hands, and everyone who trades in it pays or receives that same price.

People and workshops decide in the morning what they want for the day and bring a third of it to each session; whatever one session leaves (unsold, or not bought) goes to the next. Left alone, the three sessions clear at the same price. What makes them differ is what happens between them: your orders aimed at one session, wagons that arrive during the day, goods you bought in the morning and sell in the evening. The day's price is the average of the three, weighed by what each traded.

If more people want to buy at that price than there are goods, the highest bidders are served first. People who needed bread most (because their pantry is empty) bid highest.

The Markets tab shows each auction's demand and supply curves: the clearing point is where they cross.`,
      },
      {
        title: 'What a levy on a sale does',
        body: `A levy on sales of a good opens a gap between what buyers pay and what sellers receive. Buyers see a higher price, sellers a lower one; the Treasury keeps the difference. Who bears most of it depends on who can walk away more easily — not on who hands over the coin.

A negative rate closes the gap the other way: buyers pay less than sellers receive, and the Treasury pays the difference.

The auction curve in the Markets tab draws the gap.`,
      },
      {
        title: 'Levies on some traders only',
        body: `A levy on sales can name who it applies to: only the purchases of one trade's workshops (say, grain bought by bakeries), of every workshop, of households, or of one group of households; or only the sales of one trade's workshops.

Such a rule does not open a gap for the whole market. The auction still finds one price; the named traders pay that price plus the rate when they buy (or receive it less the rate when they sell). With a negative rate they pay less, or receive more, and the Treasury makes up the difference.

Because everyone else still trades at the auction price, a rule aimed at one trade changes what that trade can afford to bid — and through its bids, the price everyone pays.`,
      },
      {
        title: 'Legal price lines',
        body: `A **Limit** on a price overrides the auction. If the price the market would find is above a legal ceiling, trade happens at the ceiling — but sellers bring only what they are willing to sell at that price, so buyers are rationed: everyone who bid at least the ceiling gets the same share of what is available. The unserved demand is reported as a shortage.

A legal floor works the other way round: unsold goods pile up in the sellers' storehouses unless someone buys them.

A Limit can also say how far a price may **move in a day**: each morning the auction's ceiling and floor are set that share above and below the day before's price. Small moves pass untouched; a sudden jump is held back and the pressure shows instead as a shortage (or unsold goods) at the bound, the price creeping toward where the market wants it a step each day. A move of 0% holds the price where it stands. Fixed price lines still apply, and where the two disagree the fixed line prevails.

Price lines and daily moves can also be set for the IOU and gold markets.`,
      },
      {
        title: 'Your orders in the market',
        body: `Your orders are part of the same auction. An order can trade **all day** (a third at each session, like everyone's) or in one session only — all of its day at the opening, at midday or at the close. You never trade with yourself: your own buy and sell orders that would meet in a session cancel first, and only the difference goes to market; a purchase at the opening and a sale at the close are two trades. A large order to buy pushes the price up for everyone; a large order to sell pushes it down. An order to buy an unlimited quantity at a set price means the price can never fall below it while your Purse lasts. An order to sell unlimited quantities at a set price caps it — while your stores last.

Everyone who trades in a market on a day pays the same price — the day's auction price. Your limit is only the most you will pay (or the least you will take); a large order moves the day's price itself, because it takes supply that others would have bought.

An order's **Price** can be fixed, or it can follow the market. Following orders measure the market's **own** going price — what it would have been without your orders — so a big order does not chase the price its own buying raised. With **±10%** you choose how it bids within the band: **As low as it can** opens near the going price and bids higher at midday and at the close only if a session leaves it short — at the close up to +10% if need be, never more — and each day opens a step below what it needed the day before; **Always +10%** bids the band's edge in every session. Both usually get their quantity. Remember that everyone in a session pays the same price: a +10% limit in a market that clears at +3% pays +3%. A lower limit saves money only when your order is the one setting the price — when it is large next to what the market trades. Sell orders mirror this. With **Any**, there is no limit at all: you buy whatever the sellers ask, however high it spikes. Typing a price again makes it fixed.

Goods you hold sit in the town where you bought them. Bread, fish and ale go stale in store.`,
      },
      {
        title: 'Seasons',
        body: `Farms yield far more in summer and autumn than in winter. Homes burn more coal in winter. Grain keeps well, so traders and bakers store it; watch the grain price swing through the year.`,
      },
    ],
  },
  {
    id: 'production',
    title: 'Work and production',
    sections: [
      {
        title: 'Chains of production',
        body: `- Farms grow **grain**. Bakeries turn grain and a little **coal** into **bread**; breweries turn grain and coal into **ale**.
- Fisheries catch **fish**, burning **oil** in their boats.
- Lumber camps fell **wood**; coal mines dig **coal**; ore mines dig **ore**; oil wells pump **oil**.
- Smelters make **iron** from ore and coal. Toolworks make **tools** from iron, wood and coal. Workshops make **furniture** from wood and iron.
- Builders turn labour, wood, iron and tools into houses, workshops, roads and piers.`,
      },
      {
        title: 'Tools',
        body: `Every worker needs tools to work at full strength; without them a worker produces about a third as much. Tools wear out with use, so every workplace keeps buying them. When tools are scarce, every trade in the realm slows down at once.`,
      },
      {
        title: 'How workshops decide',
        body: `Each day every workshop compares what it expects to sell its goods for with what its materials, tools and wages cost. It hires while an extra worker pays for themselves and while it can sell what it makes; it lays people off when sales fall or costs rise.

Each site has limits — a field only grows so much — so each extra worker adds a little less than the one before. That is why higher prices call forth more output, but only gradually.

A workshop raises its wage when it cannot fill its posts, and lowers it only slowly and reluctantly. It prices its goods around what it expects them to fetch, cutting its asks when unsold stock piles up.`,
      },
      {
        title: 'Investors and the market for companies',
        body: `Everyone with money to spare is a would-be investor, and no two think alike: some look three years ahead, others fifteen; some want a good deal more than the bank pays before they risk their money; some see every business through rosy spectacles; some risk most of their savings, others a little.

What a business is worth to someone is the profit they expect from it over the years they look ahead, counted at the rate they would want for their money, plus what it holds less what it owes — and never less than it would fetch broken up. Once a month shares in businesses change hands: when a buyer values one well above what its owners would take, they buy as large a share as they can afford — the whole of it if they can — from all its owners alike, each paid for their part. Owners of a business in trouble take less. Whoever holds the largest share runs the business, so control can pass a share at a time; a business controlled by another becomes part of it.

Owning a rival in the same town lets an owner set their prices together — the bigger their share of the town's trade, the higher the price they can keep (a price limit stops that). Owning a supplier in the same town means the goods come straight across each morning at the going price: the workshop never goes short while its sister has stock.

The realm learns from experience. Every new workshop is judged a year after it opens: did it earn what its investors reckoned? A small learning model — a neural network — keeps track of how far their reckoning tends to be out, by trade, town and circumstance, and the next investors correct for it. It knows nothing at first and learns only from this realm.`,
      },
      {
        title: 'Profits, owners and failure',
        body: `Workshops pay their owners part of their spare coin each month. A workshop that cannot pay its workers or its loans for weeks goes under: its people are laid off, its stock is sold off cheaply, the bank loses what it lent, and the building stands empty until someone reopens it.

When a trade earns much more than borrowing costs, someone with savings — or a loan — builds a new workshop. Borrowing costs therefore decide how fast the realm grows.

A new workshop needs someone to put up a quarter of its cost (the bank lends the rest). When no one person can, several club together: a lead investor, who will run it, and others — people with savings to spare, and profitable firms — each taking a share of the business in proportion to what they put in. Profits are paid to all of them by share; when an owner dies their shares pass to their heir.

Before anyone builds, they reckon with what their workshop will do to the trade: its output lowers the price for everyone (bread little, since people eat what they must, luxuries more), and it must find hands — nobody builds a workshop in a town with no one to work in it.`,
      },
      {
        title: 'Treasury workers',
        body: `The Treasury can employ people itself, in the labour market of any town, at a wage you set — a fixed one, or the town's going wage plus a margin, re-set each morning. They work on the Treasury's own building projects in their town (the builders then bill only for the rest of the labour) or drive its freight lines; with nothing to do they wait idle, still paid, and nobody else can hire them meanwhile.

Your people in a town have two kinds of place:

- **The works crew** builds. It works on all of the Treasury's projects in its town at once — the builders' own hands take three projects at a time, your crew is not held to that — sharing out evenly, and a site that cannot use its share (waiting for wood, say) leaves it to the others. The crew can be sized **as the projects need** (enough to put in each project's remaining labour in about a month, no more than the materials on hand allow, and nobody once the projects are finished) or kept as **a set crew** of so many people, idle when there is nothing to build.
- **Posts** are the drivers of your freight lines: named people posted to one line, who drive only for it and are never sent to a building site. A line keeps them **as needed** (when the wagons stand idle, its spare drivers join the works crew) or **permanently**, one a wagon, kept on even while the line is paused. When the works crew shrinks, drivers are the last to be let go.

The **Works** tab shows each town's crew, each line's drivers by name, who is on which site and who is idle, and what each project is waiting for.`,
      },
    ],
  },
  {
    id: 'people',
    title: 'People',
    sections: [
      {
        title: 'Spending and saving',
        body: `Each household keeps a cushion of savings. The cushion it wants grows when money in the bank earns more than prices are rising, and when jobs are scarce in its town. Above the cushion it spends down its savings; below it, it holds back.

It spends first on enough food (bread or fish — it buys more of whichever is cheaper) and, in cold months, coal. What is left goes to extra food, ale, furniture and warmth. Ale and furniture are the first things people give up when times are hard.`,
      },
      {
        title: 'Health and contentment',
        body: `Hungry or cold people fall ill, and ill workers produce less. Prolonged hunger kills. Contentment follows health, work, a roof, comforts, and whether prices are running away from wages. Towns that stay miserable for long strike, and miserable people leave the realm — taking their money with them.`,
      },
      {
        title: 'Work',
        body: `Jobless people look for posts every day, mostly in their own town. They take the best offer after the cost of walking to work, if it beats what they will settle for. The longer they are out of work, the less they hold out for — unless they receive a regular payment while jobless, which lets them wait longer.`,
      },
      {
        title: 'Homes',
        body: `Houses hold four households. Tenants pay rent to their landlord every day; a landlord raises rents when people are queuing for homes and cuts them when rooms stand empty. People who cannot pay are evicted after ten days. Builders put up new houses when rents pay well compared with the cost of borrowing.`,
      },
      {
        title: 'Births, deaths and migration',
        body: `Healthy, housed people have children; people die of age and of hunger. When a town has more open posts than jobless people and empty rooms to spare, newcomers arrive from abroad with a little coin. When someone dies, their savings, holdings and property pass to an heir.`,
      },
      {
        title: 'Town councils, mayors and land',
        body: `Every town has a council with a purse of its own, kept at the bank like anyone's savings, and a mayor — a resident the town chooses every two years, the more established the likelier. A council plans like its mayor: some look many years ahead, some few; some drive a hard bargain.

The unbuilt land within a town is its council's. Whoever builds there — a venture, a developer, or you — buys the plot when the works start: dearer at the centre and as the town fills up, cheaper toward its edge; beyond the town, land is free to whoever clears it. If the Purse cannot pay for the plot at once, you owe the rest and no work starts until it is paid; if the works are abandoned, the council takes the plot back and refunds what was paid. So a crowded town pushes workshops outward, and grows. A mayor whose town has many out of work asks less for land, to draw workshops in; one whose town is full asks more.

Once a month each council may: buy an empty building that has stood idle a year or more, when its plot is worth more to the council than the owner asks — the two meet somewhere between, by how hard each bargains — then have it cleared and sell the plot again; build houses to let when people have no roof and nobody else is building; and build the road that would save its town's carters most, if it pays over the mayor's horizon. A council never borrows: it spends what its land, its rents and its savings bring in, and whatever you hand it (Transfer → Town councils). The town's view shows its mayor, purse and what it has done this year.`,
      },
    ],
  },
  {
    id: 'money',
    title: 'Money, credit and the bank',
    sections: [
      {
        title: 'Where money lives',
        body: `All the coin people and workshops own is held as deposits at the realm's one bank. The bank in turn keeps its own money — its reserves — with you, the Treasury.

When you pay someone, their deposit grows and so do the bank's reserves. When you collect, both shrink.`,
      },
      {
        title: 'Lending creates money',
        body: `When the bank lends, it simply adds to the borrower's deposit — new money appears. When the loan is repaid, that money disappears again. How much the bank lends depends on what it pays for money (your window rates), on how safe borrowers look, on its own capital, and on how many loans have recently gone bad.

Loans for workshops, houses and new ventures are made at a fixed rate: what the bank charged on the day it lent, for the life of the loan. When your window rates rise, only new loans, credit lines and deposits feel it at once — the old loans keep their rates, so the bank earns the old rates while paying depositors the new one. When rates fall a point or more below what a borrower pays, a borrower in good standing refinances at the new terms. Workshops' short credit lines float: they follow the bank's base rate day by day.`,
      },
      {
        title: "The bank's capital and its rates",
        body: `The bank must keep capital of its own — what it owns beyond what it owes its depositors — of at least **${pct(BANK_MIN_CAPITAL)}** of its loans. That is the realm's standing rule. A **Limit** on the bank's capital replaces it, higher or lower; the bank never lets its capital fall below **${pct(BANK_OWN_MIN_CAPITAL)}** of its loans of its own accord, whatever the Limit allows.

A lower rule lets the bank lend more against the capital it has — but only when its capital has run thin, after losses. A bank with capital to spare lends as much as its borrowers can carry either way.

A Limit can cap the bank's loan rates (it then turns away the borrowers it would charge more) or put a floor under them (every loan then costs at least that much, so even its safest borrowers pay more and borrow less).`,
      },
      {
        title: 'The window',
        body: `You pay the bank a rate on the reserves it keeps with you. If its reserves run short it must borrow from you at your lending rate. The bank's own lending and deposit rates follow these two rates. Higher rates make borrowing dearer and saving more attractive — slowly, and through many channels at once.

Nothing stops at zero. If reserves earn less than nothing, the bank passes it on: depositors pay to keep their money there, and new loans can carry a rate below zero — the bank pays the borrower. A loan keeps the rate it was agreed at: if you raise rates again a few days later, the loans just made stay cheap for their whole life, and the bank carries the loss as its deposits reprice.`,
      },
      {
        title: 'IOUs',
        body: `The Treasury can sell IOUs: each one pays its holder ¤5 a year, forever. Selling them brings coin into the Purse from whoever buys them; buying them back puts coin into the hands of whoever sells.

What an IOU is worth to a holder is ¤5 over the yield it asks of it. That yield is what it expects to earn on its money elsewhere over the years ahead — the reserve rate for the bank, the deposit rate for households — plus a little for tying money up for good, plus more when the realm owes a great deal against what it makes in a year, when coupons have been cut (remembered for years), when the Purse runs short with no new money to fill it, or when prices rise fast. A rate raised for a season moves IOU prices a little; one held for years moves them a lot. Rates held below inflation are expected to rise.

Each holder wants more of its savings in IOUs the further their yield beats what it asks, and moves a step toward that each day. So selling more IOUs lowers their price until savers want them — the bank takes most, since households keep most of their coin for spending — and buying them back raises it until holders let them go. Bid well over what they are worth to holders and they sell at once; bid "at any price" and you pay whatever each asks. When rates rise, the IOUs already held lose value — and the bank, if it holds many, loses capital. The IOU market page shows what holders ask today, part by part.`,
      },
      {
        title: 'When the bank fails',
        body: `If the bank's losses exceed its capital, it stops lending. If nobody puts coin into it within a month, every depositor's balance is cut to make the books whole again.`,
      },
    ],
  },
  {
    id: 'trade',
    title: 'Shipping and the outside world',
    sections: [
      {
        title: 'Towns and their borders',
        body: `Every workshop and house counts as part of one town: it sells in that town's market, and its households shop there. What decides it, in order: a building within a town itself belongs to that town, however its track runs. Further out, closeness counts most, then how quickly its road reaches each town, then where its workers live (for a house, where its people work), then where its owner lives. The rules are looked at again at the turn of every month, so a farm whose workers all come from the next town may come to count as that town's. Towns grow as they build outward, and their borders — the dashed lines on the map — follow their outermost buildings.

Someone opening a farm, a mine, a camp or a fishery looks all around the town for the best ground: richer seams and better fishing yield more, but workers must be paid for a longer walk, and the builders must lay a track to the nearest road — through forest, up hills or over a river it costs more. A capital near the coast can open its own fishery, if the fishing is good enough and the walk short enough. Only ground that would count as the town's own is considered.`,
      },
      {
        title: 'Traders and wagons',
        body: `Every town has a trading house with wagons and carters. When a good is cheap in one town and dear in another by more than it costs to haul it, traders buy, load and ship it. Hauling costs the carters' wages, the oil the wagons burn, and wear on the wagons. Paved roads make wagons faster and hauling cheaper.

The shipping rate on the top bar is what it costs to move one unit ten tiles.

A trading house that carries a lot along one road may pave it, or cut a shorter track, at its own expense, when the freight it saves on its own wagons repays the cost. Its rivals then use the road for nothing — so houses build fewer roads than would pay the realm as a whole, but the busiest ones usually get paved within a year or two.`,
      },
      {
        title: 'Your stores, and carrying goods',
        body: `Whatever the Treasury buys is kept in its **store** in the town where it was bought. A sell order there offers what the store holds; a transfer in kind hands it out; and **Carry** moves it to the store of another town. Goods that spoil go on spoiling in store and on the road.

Unless it runs a freight line (below), the Treasury has no wagons of its own. To carry goods it hires the trading house of the town they leave from: it pays the carters' wages, the oil and the wear for the round trip, plus a little more, for every wagon it needs. A wagon carries 120 units; a half-empty wagon costs as much as a full one.

A carry can be sent **once, now** (an amount, or everything held there), or kept as a **rule**: everything the store holds, as it comes in, or up to an amount a day — for a number of days or until you remove it. A rule loads after each market session, and its wagons leave at noon or after the session that filled them, so bread bought at the opening can be on the road the same day. With **full wagons** it waits until a wagon is nine-tenths full — or until the goods have waited as long as they keep (bread two days, at most a week), or a freight line of yours on that road has room. **Right away** sends what is held after every session: quicker, but a small load pays for a whole wagon.

A carry neither buys nor sells. To keep a town supplied from another, place a buy order in the first, a carry to the second, and a sell order there; the Carry form's *Sell in …* opens that order for you.

A standing carry can also go **where it runs short**. It serves the towns where you have a sell order for the good, and sends each load to the one that needs it most: its shortage over the last 14 days plus what you have been selling there, for the days a load takes to arrive, less what you already hold there or have on the road. When none needs any, the goods wait where they are.

The Carry form shows the good **town by town**: what each town makes and uses a day, its market over the last 14 days, and what you hold there. Mark **from** on one store, or on several: a rule then draws on each of them **equally** (a store that holds less gives what it has, and the others make up the rest). Mark **to** on the town it should go to, or pick *Where it runs short*. Besides *Everything* and *Up to* an amount a day, a carry to one town can take **what it needs**: the same measure as above, for that town alone. Bear in mind what it competes with: the trading houses carry goods to where they fetch more, and your wagons take some of their trade. Each piece stays an ordinary rule: your purchases raise the price where you buy, your offers lower it where you sell, and you can change or pause any one of them without touching the others.

**Stores & wagons** (in Trade, and in the Ledger) shows what you hold in each town (a dot marks goods a carry rule takes on elsewhere), every Treasury wagon on the road with its arrival, and what freight has cost this month.`,
      },
      {
        title: 'Freight lines',
        body: `A **freight line** (in Build) is a carrying service the Treasury runs between two towns, both ways. Nothing about it is make-believe:

- **Wagons** are tools the Treasury owns (three tool sets a wagon). They are kept in the first town you name; the line takes any tools you hold there and buys the rest in that town's market, and replaces them as they wear out on the road.
- **Drivers** are Treasury workers of that town posted to the line, paid a carter's wage from the Purse. Choose **as needed** (as many as the loads call for; spare drivers join the town's works crew) or **permanent, one a wagon** (kept on whatever the loads, even while the line is paused). Either way the same people keep driving it, and a line's drivers are hired before the building crews.
- **Oil** is bought in that town as the wagons use it: every loaded trip burns it, like any wagon's.

The trading houses of both towns use the line whenever it is cheaper than their own wagons, and pay its fare to the Purse. You choose the fare: a **fixed** amount per unit; **cost +** a margin (what the line's recent trips cost per unit carried — part-full wagons cost more a unit, wagons that meet a load coming back cost less — plus your markup; 0 % is at cost); **undercut** (on each leg, what the trading house would pay for its own wagon, less a share you set: they always come out ahead, and the Purse keeps the rest of what the line saves them); or **free**. To earn from a line it must carry more cheaply than the traders' own wagons: where its trips cost what theirs do, even an undercut fare will not pay for drivers waiting for loads. Goods of several traders share a wagon, so a small consignment costs no more a unit than a full wagon.

Cheaper hauling works through the traders: they can now carry more goods between the two towns at a profit, so they buy more where a good is cheap and sell more where it is dear, and the gap between the two prices narrows. The trading houses need fewer wagons and carters of their own. What the fares do not cover — drivers, oil, wear — comes out of the Purse; each line's card (in Build, In force, and Stores & wagons) shows its fares, its costs and its result so far.

Your own goods between the two towns ride the line too, without a fare. Pausing a line stops it taking loads; closing it returns its wagons (as tools) and its oil to your stores in its town.`,
      },
      {
        title: 'Handing out goods',
        body: `A **Transfer** can hand out goods instead of money: so many units of a good you hold in a town to every member of a group there. People put them in their pantries; workshops (of every trade, or of one) put them in their stores, as if they had bought them.

Goods handed out are goods nobody has to buy that day, so the market for them is quieter while they last.`,
      },
      {
        title: 'The port and gold',
        body: `Foreign ships call at the harbour town every day. They sell goods at world prices plus their costs, and buy at world prices less theirs. World prices are quoted in gold, so the gold price in ¤ decides whether foreign goods look cheap or dear.

Foreigners who earn ¤ at the harbour want gold for it; foreigners who want the realm's goods need ¤ first. Those needs meet in the gold market. When the realm buys more abroad than it sells, gold grows dearer. When the realm's savings pay well, foreigners are happier to keep ¤. You can hold gold, buy it and sell it like anyone else.

Households keep a share of their wealth in gold too: a small store always (the cautious more), and more when prices rise faster than the bank pays on deposits, when the bank looks short of capital, or when gold has been climbing for a year and the coin is expected to keep falling. Their gold comes from the foreign dealers, so a rush into gold sends coin abroad and makes gold dearer still — a run on the coin — until deposit rates, a sounder bank or a steadier gold price calm it.`,
      },
    ],
  },
  {
    id: 'reading',
    title: 'Reading the ledgers',
    sections: [
      {
        title: 'Indicators',
        body: `- **Prices** — the cost of a typical household's basket (bread, fish, coal, ale, furniture and rent) at what buyers actually pay, 100 when you took office.
- **Inflation** — how fast Prices are rising, as a yearly rate (over the last 30 days, and over the last year).
- **Output** — everything produced in the realm valued at the prices of your first day, so that it measures quantities, not prices.
- **Jobless** — the share of people without work.
- **Money** — all deposits at the bank.
- **Credit** — all loans the bank has outstanding.
- **Real wage** — the average wage divided by Prices.
- **Gini** — 0 when everyone owns the same, 1 when one person owns everything.`,
      },
      {
        title: 'Made, used and traded',
        body: `Three different numbers, often confused:

- **Made** — what the workshops of a town produced: the farm's grain, the bakery's bread.
- **Used** — what was used up there: eaten, burnt, drunk or worn out at home, worked into other goods (grain into bread), built into houses and works, or burnt by wagons setting out.
- **Traded** — what changed hands in the town's market hall. A loaf baked and sold in the same town is both made and traded there; grain a farm sells to a trader who carts it away is traded where it is sold and used where it lands.

**Net** is made less used: a town with a **+** makes more than it needs and sends the rest out (or stocks it); a **−** town needs more than it makes and brings the rest in, by wagon or from the ships at a port — **In** and **Out**. Markets → a good → *Made, used and moved* lists every town; the grid's *Made & used* view shows, for every good at once, what each town makes a day. All figures are averages over the last 14 days.`,
      },
      {
        title: 'Experiments worth running',
        body: `Pause, change one thing, and watch a year go by. Then undo it and try something else. Some questions to start with:

- What happens to the price of bread — and of fish — if you take a share of every bread sale?
- What if you pay a share of every bread sale instead?
- What if you make it illegal to sell bread above half its price?
- What if you Mint ¤50,000 and Transfer it to everyone? What if you do the same but also sell IOUs?
- What if you hire every jobless person in Coalridge at a good wage to pave the road to Kingsbridge?
- What if you raise the window rates to 15%? To 0%?
- Does it matter whether the worker or the employer hands over a levy on wages?
- What if you buy every tool in Kingsbridge at twice the price, then sell them back cheaply?
- What if you stand ready to buy and sell gold at a fixed price?`,
      },
    ],
  },
];
