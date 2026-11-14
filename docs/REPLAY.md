# Replay engine (src/paper/replay/)

**Past data, not proof of future results.** Statistics on historical data, nothing here is advice, and nothing
here ever sends an order (PAPER ONLY, same as the rest of `paperbot/` and `src/paper/`).

## What it does, in plain words

Every real trading decision the live crypto scalp bot makes comes from one function: `analyse()` in
`src/paper/scalp/engine.js`. That function only looks at candles that have already closed — it has no idea what
happens next. The replay engine feeds it **real history, one candle at a time**, exactly the way the live cron
feeds it real time, one minute at a time: same rolling windows (120 one-minute candles, 330 five-minute
candles), same entry rule, same stop/target/breakeven/time-stop exit rule (`evaluateExit()`), same costs and
settlement (`settle()`). None of that logic is copied or reimplemented — the replay engine **imports** the
same three functions the live bot calls. So whatever the replay engine reports is what the live bot would
genuinely have done on those candles, not a guess.

Because a month of history plays through in seconds instead of weeks, we learn in one night what live paper
trading would take weeks to show: does the strategy actually make money after real costs, or not.

## Why it has to run on the real server

Binance's public candle history (`data-api.binance.vision`) is blocked from this sandbox (confirmed once: a
`curl` to it here returns a proxy 403). It is reachable from Render, where the live bot already pulls candles
from the same host. So the history loader and every replay run described here are **not verified live** —
they are tested against fixture candle files in `test/fixtures/replay/`, and must be watched the first time
they actually run on Render.

## Pieces

| File | Job |
|---|---|
| `history.js` | Paginated Binance klines loader (1m/5m/15m/1h, 3 coins, 30 days). Resumable: remembers the last candle it stored per symbol+interval (`replay_history_progress`) and only asks for what is missing. One page in flight, a pause between pages, each page written and dropped (never holds the whole month in memory). |
| `simulator.js` | `scanSignals()` builds the exact rolling window the live bot would have seen at each closed candle and asks the real `analyse()` for a decision — this is the only place that decides what is "closed by now", which is why it is tested directly for look-ahead. `replayScalp()` turns accepted signals into closed trades using the real `evaluateExit()`/`settle()`, one open trade per coin at a time. `replayRandomBaseline()` is the same exit/settle machinery with a fake, randomly-timed entry (direction random, stop%/target% resampled from the real strategy's own trades) — "what would doing nothing in particular have earned with the same risk." |
| `stats.js` | Trades, win rate, net INR, average win/loss, max drawdown, longest losing streak; broken down by coin, by UTC hour, and by a rough UTC session bucket. Any group under 20 trades reports only `"too few trades, no conclusion"` — never a number built on too little data. |
| `filters.js` | The filter study (see "Filter study" below). |
| `lookahead.js` | The look-ahead check (see below). |
| `run.js` | Runs all of the above for every symbol, splits the 30-day window into the first 20 days (in-sample) and the last 10 (out-of-sample), and saves everything. |
| `codeVersion.js` | A hash of the watched decision files, so a run can tell "the bot's code changed since I last ran" without a manual version number. |
| `index.js` | Wiring: the history catch-up cron, the daily 02:00 IST run, a run on startup if the code changed, and the two routes below. |

## In-sample / out-of-sample

The 30-day window is simulated **once, continuously** (so the strategy never gets an artificial fresh start
partway through), and the resulting trades are then split by entry time: the first 20 days are **in-sample**,
the last 10 are **out-of-sample**. Read the out-of-sample numbers as the honest ones — the in-sample ones are
shown for comparison, not because they are more trustworthy.

## Checks against fooling ourselves

- **Look-ahead check** (`lookahead.js`): for a handful of points spread through each symbol's history, every
  candle at or after that point is multiplied into nonsense (×9 and ÷9), and the signals decided *before* that
  point are compared byte-for-byte against the uncorrupted run. If corrupting the future ever changes a past
  decision, the check fails and the whole run is marked `failed`. This runs on every replay run, not just once.
- **Random-entry baseline**: same cost model, same stop/target risk, but the entry itself is meaningless. If
  the real strategy doesn't clearly beat this, the pattern logic isn't adding anything over taking the same
  risk at random times.
- **Doubled-cost run**: fees and slippage doubled. A strategy that only looks profitable because real-world
  costs were underestimated shows it here.

## Filter study (brief item 7) — what is and isn't a true ablation

`min_rr` (the reward/risk gate) is the only filter that is an actual config knob in the live scalp config
(`src/paper/scalp/config.js`), so it is the only one replayed both **with** and **without** the gate.

Everything else the brief asked about — the 5-minute trend/VWAP agreement check, momentum score, EMA cross,
and each pattern/SMC tag — is hard-coded **inside** the real, imported `analyse()`. Turning any of those off
for real would mean forking that function, and the brief (and this file) rule that out: the replay engine must
run the live code, never a copy of it. So for those, the report shows a **descriptive breakdown only** — how
the trades the live rules actually took did, grouped by which pattern fired — clearly labelled as not an
ablation. **Suggestions only; nothing here changes the live bot automatically.**

## Reading the report

`GET /api/paper/replay-report?key=<PAPER_ADMIN_SECRET>` (same secret as the other `/api/paper/` routes):
an HTML summary of the latest stored run — in-sample, out-of-sample, full 30 days, the random baseline and
the doubled-cost run, and whether the look-ahead check passed. Add `&format=json` for the full detail: every
symbol's own numbers, the filter study, and every individual replayed trade.

`GET /api/paper/replay/run?key=...` starts a new run in the background and answers immediately (a full
30-day, 3-coin run can take a while); poll the report route for the result. Automatic runs happen daily at
02:00 IST and once after a restart if the watched decision files changed since the last stored run.

## Limits (read before trusting a number)

- **1-minute candles hide the order of moves inside the candle.** If a 1-minute bar's high and low would both
  have hit the stop and the target, this (and the live bot) assume the stop lost — the worse case — but the
  real order of the wick is not known from a candle alone.
- **No order book.** Fills are simulated at the candle's own high/low/close; there is no real slippage curve,
  no partial fills, no checking that the size would actually have traded at that price.
- A fixed USDT→INR rate (the same fallback the live bot uses when no live rate is available) is used for every
  historical trade — it is not the real rate on that date.
- The random baseline and the filter study answer "does this look different from doing nothing /
  from a config knob" — they are not proof the live strategy is profitable, only evidence either way.
- Every number above is built strictly from the real `analyse()`/`evaluateExit()`/`settle()` run on stored
  Binance history. **Not verified against a real Render run yet** — Binance is blocked from this sandbox (one
  `curl` to `data-api.binance.vision` here returned a proxy 403), so everything was tested against the fixture
  candles in `test/fixtures/replay/`. Watch the first live run's logs and `/api/paper/replay-report` on Render.
