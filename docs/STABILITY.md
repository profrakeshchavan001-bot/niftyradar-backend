# Stability (Render Free: 512 MB RAM, DB pool 2)

CC3 round 3. Measured with `tools/stability-check.js`: fixtures (the same hand-built candles the test suite uses, no Binance/Yahoo
call), a real throwaway Postgres 16 (`PAPER_DATABASE_URL`), one full scan+monitor cycle of every bot this session owns (scalp,
scalp_wide, exhaustion_only, trend_smc, shadow resolution), run back to back as a Render Free instance would run them.
**Not verified live** - Binance/Yahoo are unreachable from this sandbox.

## Measured (one full cycle, 3 symbols each: BTCUSDT, ETHUSDT, SOLUSDT)

| Job | ms | DB queries | RSS delta (MB) |
|---|---|---|---|
| scalp scan | 21 | 11 | 0.50 |
| scalp monitor | 5 | 3 | 0.56 |
| scalp_wide scan | 10 | 7 | 0.38 |
| scalp_wide monitor | 2 | 2 | 0.00 |
| exhaustion_only scan | 9 | 8 | 0.00 |
| exhaustion_only monitor | 2 | 2 | 0.00 |
| trend_smc scan | 7 | 5 | 0.86 |
| trend_smc monitor | 2 | 2 | 0.13 |
| shadow: `openShadows` x4 bots (idle check) | 1 | 4 | 0.00 |
| **Total (one full cycle, all of the above)** | **59 ms** | **44 queries** | - |

Process RSS at the end of the run (bare Node + `pg` + this session's bot code, no Express, no other windows' bots loaded): **60.5 MB**.

## Plainly: is anything too heavy for 512 MB?

**No, not from what this measures.** 59 ms of work and 44 queries per full cycle is not close to a problem on its own, and these jobs
are already staggered across different seconds (item 2) rather than firing at once, so the 512 MB limit is not being pushed by this
session's bots in isolation.

**What this does NOT measure, and should be checked before calling the WHOLE app safe:**
- The **main intraday bot** (`paperbot/bot.js`, NSE + crypto, the Judge, EMA-cross confirmation, Judge2, news/sector context) and the
  **replay engine** (`src/paper/replay/`) were not wired into this benchmark - building fixtures for their full pipeline (Dhan
  option chain, the Judge's several helpers, replay's own candle history) was judged too large an addition for the time left
  tonight. They are the oldest, most complex code paths and the most likely to actually matter for memory; this is a real gap, not
  an "all clear" for the whole app. Flagging rather than claiming more than was measured.
- This is **one process's RSS with no HTTP server loaded** (no `express`, `helmet`, `cors`, no `server.js`). The real Render process
  also holds the whole web app, every report route, and (per `docs/REPLAY.md`) the replay engine's own candle history in memory.
  60.5 MB is the marginal cost of this session's bot logic alone, not the whole app's footprint.
- Real Binance/Yahoo payload sizes were not measured (fixtures are tiny, hand-built candle arrays; a real `/api/v3/klines` response
  for 330 five-minute candles is bigger, though still well under a megabyte).

## Fixes made this round (item 2)

- **Staggered cron seconds**: two real collisions were found and fixed - `trend_smc monitor` was `:50 * * * * *`, the same second
  `nse monitor` already used during market hours (now `:58`); `shadow monitor` was `:40 */5 * * * *`, landing on the same second as
  `scalp_wide monitor`'s every-minute `:40` every 5th minute (now `:42`). `trend_smc scan` was also `:20 */5 * * * *`, the same
  second `nse scan` uses during market hours (now `:22`). No two jobs now share a second.
- **Overlap guard, per job**: already in place for every job this session's bots use (`paperbot/index.js`'s `guarded()` - a `busy`
  flag skips a run if the previous one of that SAME job has not finished) and for the main bot's own jobs. Checked, not re-added.
- **Error isolation**: also already in place in the same `guarded()` wrapper - one job throwing is caught and logged with the job's
  own name, and never stops another job's own cron tick. Checked, not re-added.
- **8 s timeout + one backoff pass** on every Binance fetch (`paperbot/sources.js` `createCryptoSource`, was a 15 s timeout with no
  backoff - one pass across both hosts, then a 400 ms sleep, then one more pass across both hosts before giving up) and the
  CoinGecko USDT/INR fetch (same timeout). Yahoo (`paperbot/yahoo.js`) already had `maxRetries`/`backoffMs` built in; only its
  default timeout changed, 15 s -> 8 s. `trend_smc`'s own 15-minute Binance source got the same 8 s timeout + backoff pass.
- **No job holds a DB connection while it waits on the network**: checked, not changed - every store call in every bot uses
  `pool.query(...)` directly (never `pool.connect()` + a held client), so `pg`'s pool checks a connection out and returns it before
  the next line runs; nothing is held across an `await` on a Binance/Yahoo call. Grepped the whole repo for `.connect()` /
  `client.release` to confirm: none.

## Item 3: one shared candle cache

`trend_smc`'s own native 15-minute Binance source and the 5-minute/1-hour source every other bot uses were, until this round, two
separate `createCandleCache()` instances - each could, in principle, hold its own entry for the same symbol+timeframe fetched by a
different bot (never happened in practice for 15m, since only trend_smc asked for it, but the two caches were genuinely separate
objects). `paperbot/index.js` now builds ONE `candleCache` and passes it into both `createCachedCrypto()` (5m/1h) and the new
`create15mCrypto()` (15m) wrapper around `trend_smc`'s source; the plugin loader hands the wrapped 15m source to `trend_smc` as
`ctx.cached15mCrypto`, the same pattern `ctx.cachedCrypto` already used for the 5m/1h source. Confirmed each symbol+timeframe is
fetched once per cycle across bots with `test/paperCachedCrypto.test.js`'s new cases (one shared cache, two timeframes, each
deduped independently; a non-default range/limit still always bypasses the cache, same convention as before).

## Item 4: restart safety

Added a real **unique index** - not just the application-level "already traded this candle" check every bot already had - on
`(market, symbol, trigger_t)` for the shared `paper_trades` table and `(symbol, trigger_t)` for `exhaustion_only_trades` and
`trend_smc_trades` (idempotent `CREATE UNIQUE INDEX IF NOT EXISTS`; `trigger_t` is nullable for older rows that never set it, and
Postgres never treats two NULLs as a conflict, so this changes nothing for them). Every `insertTrade()` (Postgres and the in-memory
store, so tests exercise the same behaviour) now does `ON CONFLICT (...) DO NOTHING` and returns `null` instead of a real id when
the row already exists; every bot's `scan()` checks for `null` and simply does not log a new entry - the trade that is already
there stays exactly as it was. `shadow_setups` already had this exact protection from round 2 (`(bot, symbol, trigger_t)`),
unchanged this round.

**Simulated a kill mid-cycle**, both in the test suite (`test/paperRestartSafety.test.js`: a brand-new bot instance, same store,
re-scans the exact candle an earlier instance already decided on - no double entry, the open trade's id is unchanged) and by hand
against a local Postgres 16 (same insert run twice with `ON CONFLICT ... DO NOTHING RETURNING id`: the second run returns 0 rows,
the row count stays at 1 - see `docs/decisions/CC3.md`).
