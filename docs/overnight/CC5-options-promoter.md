# CC5 overnight log -- hedged option selling + promoter buying (2026-11-18)

New lane: `research/options_promoter/` only, plus this file and
`docs/OPTION-SELLING-AND-PROMOTER-REPORT.md`. No existing bot, filter, alert, table, or other
CC window's file was touched. Branch `claude/eager-knuth-80qw3g` (the session's assigned branch),
rebased on `origin/main` before opening the PR.

## Decisions

1. **Data access check done first, by hand**: `curl` to `www.nseindia.com`, `www1.nseindia.com`,
   `archives.nseindia.com`, `www.bseindia.com` and `query1.finance.yahoo.com` all return a 403 at
   the egress proxy (`CONNECT tunnel failed, response 403`), before any site is reached. Per this
   session's explicit rule ("do not change any network/permission/environment setting"), that
   block is treated as final for tonight, not worked around.
2. **This matches a documented, earlier block in the same repo**:
   `research/strategies/data_loader.py`'s own docstring and `docs/overnight/CC5.md` both record
   "sandbox network policy blocked every market-data host tried: Yahoo Finance, Binance, NSE,
   Stooq" from a previous overnight session. Treated as corroboration, not re-verified host by
   host beyond the five above.
3. **Built the full pipeline anyway, as new, isolated files**: fetchers (log BLOCKED and stop
   cleanly, never fabricate), cost model, three-structure options engine (hedged only -- no code
   path exists to build a naked short), promoter-buying engine, the brief's own train/test/verdict
   rule, and a portfolio-correlation module. All pure functions over pandas DataFrames passed in
   by the caller -- no module here fetches data itself except the two `*_fetcher.py` files.
4. **Validated mechanics only, on small labeled synthetic fixtures** (fixed-seed, documented as
   fake in every test's module docstring): hedging is always present, costs are always
   subtracted, the VIX filter and event-day skip both actually remove entries, all three exit
   rules (expiry / 50% capture / 2x stop) resolve no later than expiry, and the historical
   Nifty/Bank Nifty lot-size table is read correctly across its three change dates. None of these
   numbers are claims about the real market.
5. **Group 6 (demo bots) skipped on purpose**: the brief says demo bots only for PASS variants;
   with Group 1 blocked, nothing could be tested, so nothing qualifies. Left
   `options_engine.build_demo_bot_spec()` as the ready config for whenever a future session with
   data access gets a PASS.
6. **Extra queue (Bank Nifty repeat, data-integrity audit) not reached**: same Group 1 block;
   the options engine already takes `index="BANKNIFTY"` as a parameter (tested in
   `test_2x_stop_exits_no_later_than_expiry`), so repeating Group 2 on Bank Nifty is a config
   change away, not new code, once real data exists.

## Findings (fixtures only -- NOT evidence of a real edge, see test docstrings)

- Engine correctly builds iron condor / hedged strangle / iron fly without ever producing a
  naked leg; attempting to pass an unknown structure name raises rather than silently degrading.
- Cost model confirms STT applies to sell legs only and stamp duty to buy legs only, matching the
  published 2024/2025-era NSE options rate structure, and scales linearly with lot count.
- `honest_split.judge()` reproduces all four required outcomes on synthetic trade lists:
  LOW-DATA (under 30 test trades), FAIL (net negative on either side), FAIL (worst week wipes out
  6 months of average profit even when net is positive), PASS (both conditions met).
- 19/19 new tests pass locally in well under a second; the repo's pre-existing test suites
  (`npm test`, `research/tests/`) were run unchanged to confirm no regression, since this lane
  never imports from or edits them.

## Needs Rakesh

See the "What is needed from Rakesh" section of `docs/OPTION-SELLING-AND-PROMOTER-REPORT.md` --
network access to NSE/BSE/Yahoo for this environment (or a pre-downloaded dataset) is the single
blocker for every remaining group.

## Elapsed time

Real elapsed time for tonight's work is stated in the PR description; no padding against the
180-minute ETA given at the start.
