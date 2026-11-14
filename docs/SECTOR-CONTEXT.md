# Sector context (CC4)

**Problem it solves:** the paper-trading bot can now ask "how strong is this stock's sector right now?" and so avoid trading against the sector.

Code: `src/paper/context/sector.js`. Sector list: `data/nse-sectors.json`. Tests: `test/sectorContext.test.js`.
It is a stand-alone module. Nothing in the bot calls it yet (CC6 is editing the bot); wiring it in is one line, shown below.

## How to use

```js
const { sector } = require('./src/paper/context');

await sector.stockSectorView('TCS');
// { sector: 'IT', score: 75, label: 'STRONG', vsNifty: 0.6 }

await sector.sectorScore('IT');
// same, plus changePct, niftyPct, breadthPct, trend3Pct, basis, missing, asOf
```

Both answer `null` when the stock is not in the sector list, when the data source is down, or when a needed number is missing. The bot must treat `null` as "sector not known", never as weak or strong.

## The score (0 to 100)

Four parts. Each part is first turned into a 0 to 100 number, then mixed by weight.

| Part | What it measures | How it becomes 0 to 100 | Weight |
|---|---|---|---|
| Change today | Sector index % change from yesterday's close | -2 % or worse = 0, flat = 50, +2 % or better = 100 | 30 |
| Versus Nifty | Sector % change minus Nifty 50 % change (`vsNifty`) | -1.5 points = 0, equal = 50, +1.5 points = 100 | 30 |
| Breadth | % of the sector's stocks above their VWAP; if no VWAP is given, above yesterday's close | used as it is | 20 |
| 3-day trend | Sector index now against its close 3 sessions ago | -4 % = 0, flat = 50, +4 % = 100 | 20 |

`score = (30 x change + 30 x versusNifty + 20 x breadth + 20 x trend) / 100`, rounded.

Label: **STRONG** at 65 or more, **WEAK** at 35 or less, **AVERAGE** in between.

Worked example (the IT test): index +1 % gives 75; Nifty +0.4 % so versus Nifty is +0.6, gives 70; 4 of 5 stocks up gives 80; 3-day trend +2 % gives 75. Score = (2250 + 2100 + 1600 + 1500) / 100 = 74.5, rounded 75, STRONG.

## When data is missing

- No Nifty number, or no sector move: answer is `null`.
- Sector without an index ticker (Power, Telecom, Insurance, NBFC, Consumer): the sector move is the plain average of its stocks (`basis: 'stocks_average'`). There is no 3-day trend for these; its weight is shared over the other parts and `missing` says `['trend']`.
- Breadth needs data for at least half of the sector's stocks, else it is left out the same way.

## Where the data comes from

The module talks to an adapter with one function, `getSectorQuotes()`.

| Adapter | Use |
|---|---|
| `createFixtureAdapter(data)` | tests |
| `createYahooAdapter()` | free, no key: Yahoo Finance public chart endpoint for `^NSEI`, the sector indices (`^CNXIT`, `^NSEBANK`, `^CNXAUTO`, `^CNXPHARMA`, `^CNXFMCG`, `^CNXMETAL`, `^CNXENERGY`, `^CNXPSUBANK`, `^CNXREALTY`, `^CNXINFRA`, `^CNXMEDIA`) and each stock as `SYMBOL.NS` |

Dhan is not used. Yahoo gives no VWAP, so with this adapter breadth means "above yesterday's close". Another adapter can pass `vwap` per stock and it is used automatically.

Answers are kept for 5 minutes. A failed fetch is retried after 1 minute. One refresh is about 87 small requests, 6 at a time.

## Wiring into the bot (later, one line)

Before an entry: `const view = await sector.stockSectorView(symbol);` then skip a LONG when `view?.label === 'WEAK'` and a SHORT when `view?.label === 'STRONG'`. That rule is the owner's to switch on.

Open points: `docs/DECISIONS-PENDING-CC4.md`.
