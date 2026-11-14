# Bot interface (CC2, overnight item 1c)

A goal for every new strategy under `src/paper/bots/`: the same code that
trades live can be replayed by `src/paper/replay/` against recorded candles,
with no change. That only works if the strategy's decision logic is a pure
function with no clock and no network inside it.

## The contract

```js
// candles: closed candles only, oldest first, { t, o, h, l, c, v }
//          (t = open time in ms; never pass the still-forming candle)
// context: whatever the bot needs beyond price (see below)
// returns: a decision object, always with `take` and `direction` (null-safe
//          on skip) so a caller never has to guess which fields exist.
function decide(candles, context) {
  return {
    take: true,            // or false - this candle is not a trade
    direction: 'up',        // 'up' | 'down' | null when take is false
    entry: 123.45,          // the price the trade would be taken at
    stop: 121.00,           // the stop price
    target: 128.00,         // the target price
    basis: 'order block retest + EMA9>21 cross, R 2.1',
                             // one plain-word line: why (for judge_basis / the report)
  };
}
```

Rules for `decide`:

- **Pure.** No `Date.now()`, no `fetch`/`axios`, no reading `process.env`, no
  database call, no `console.log` side effects that change behaviour. Every
  input it needs (candles, higher-timeframe trend, ATR, levels, news score,
  "now" in IST, …) comes in through `context`, not from the environment.
- **No look-ahead.** `candles` must never include the candle that has not
  closed yet. A bot that peeks at the current, still-forming candle to decide
  on it is cheating in its own backtest - this is exactly what the nightly
  VERIFY loop checks for.
- **Deterministic.** Same `candles` + same `context` -> same decision, every
  time. That is the only way `src/paper/replay/` can re-run history and get a
  result worth trusting.
- **take=false still explains itself.** Use `context`/the caller's own
  logging for *why* a setup was skipped (shadow tracking, item 8) - `decide`
  itself just returns `{ take: false, direction: null }` plus whatever extra
  fields the bot wants to report (e.g. `reason`).

## `context`

Shaped by the caller (the live engine or the replay engine), not by the bot.
Suggested shape, so bots can share it:

```js
{
  symbol: 'RELIANCE',
  timeframe: '15m',
  now: 1700000000000,          // ms, IST-derived by the caller - never Date.now() inside decide()
  higherTf: { c15: [...], c1h: [...] },  // other timeframes' closed candles, if the bot needs them
  levels: { swingHighs, swingLows, previousDay, previousWeek, orderBlocks, fvgs },
  indicators: { emaFast, emaSlow, atr14, vwap },
  trend15m: 'up' | 'down' | 'flat' | 'unknown',
  sector: { score } | null,    // null when the helper does not apply / is unavailable
  news: { score, eventBlock } | null,
  session: 'asia' | 'london' | 'new_york' | 'open_drive' | 'lunch' | 'close' | null,
}
```

A bot only reads the keys it needs; a caller only fills in what it can. A
helper that does not apply (e.g. `sector` for crypto) is `null`, never a
made-up number - this is the same rule the Judge (`src/paper/decision/judge.js`,
`docs/JUDGE.md`) already uses for its own inputs.

## Where the pieces live

- Shared indicators, levels and the per-cycle candle cache: `src/paper/lib/`
  (re-exported from `paperbot/patterns.js` and `paperbot/rfactor.js` /
  `paperbot/cryptoLevels.js` - same functions, one place to require them
  from). See `src/paper/lib/index.js`.
- Auto-loaded plugins: any folder with a `register.js` directly under
  `src/paper/bots/`, `src/paper/ops/` or `src/paper/replay/` - see
  `src/paper/pluginLoader.js` for the exact contract (routes, cron, its own
  idempotent `schema.sql`). A bot built this way can keep `decide()` pure
  while `register.js` does the clock/network/wiring part.
- The Judge takes a decision plus context and scores it
  (`src/paper/decision/judge.js`, `docs/JUDGE.md`); it does not replace
  `decide()`, it sits after it.
