# Option-chain engine (fixture-driven)

Computes, from one option-chain snapshot (and optionally the previous day's):
support/resistance from OI, volume and OI change; the reversal price (where CE(K) = PE(K-1)); SFT/SFB shift flags;
the Triple S/R, Power, Oi2Oi, Big Bull and Big Bear screeners; an 8-signal market overview score; FII and Pro pulse;
an MMI-style mood meter; and one 0-100 **derivatives** score for the Signal Box.

All formulas, thresholds and weights are in `engine.js` only. The JSON from `runChain()` reports results (levels, flags, tilts, scores), never the working.

## Run on fixtures
```bash
node tools/india_edge/chain/run.js tools/india_edge/chain/fixtures/chain_cur.json tools/india_edge/chain/fixtures/chain_prev.json
node --test test/indiaChain.test.js
```

## How CC8 runs it on real F&O bhavcopy
1. Download the day's F&O bhavcopy CSV (and the previous trading day's) outside the cloud sandbox. Parse rows to objects (e.g. csv-parse, already a dependency).
2. `fromBhavcopy(rows, { symbol, expiry, spot, date, vix, vixPrev, adv, dec, fii, pro })` in `adapter.js` builds the snapshot. It accepts UDiFF names (`TckrSymb, XpryDt, StrkPric, OptnTp, OpnIntrst, ChngInOpnIntrst, TtlTradgVol, ClsPric`) and legacy names (`SYMBOL, EXPIRY_DT, STRIKE_PR, OPTION_TYP, OPEN_INT, CHG_IN_OI, CONTRACTS, CLOSE`). **Column names are unverified against a real file; check them first.**
3. Build yesterday's snapshot the same way (strikes only) and call `runChain(today, yesterday)`.
4. Extra inputs not in bhavcopy: `spot` (underlying close), `vix`/`vixPrev`, `adv`/`dec` (breadth), `fii`/`pro` = `{ long, short, prevLong, prevShort }` index-futures positions from the participant-wise OI file. Any missing input is skipped, and the scores adapt.
5. Store `signal_group` (`{ id: 'derivatives', score, label }`) as the Signal Box entry; keep the rest of the JSON for the screener pages.

Assumptions to confirm: SFT = both OI-based support and resistance moved up vs previous day, SFB = both moved down. Use the nearest weekly or monthly expiry per index.
Fixtures are synthetic. Educational and statistical output only, not advice.

## Assumptions for CC8 to verify on a real F&O file
- SFT / SFB meaning (both OI-based S and R moved up / down vs previous day) is an assumption.
- Bhavcopy column names (UDiFF and legacy) are unverified against a real file.
- Reversal price rule CE(K) = PE(K-1) and the screener thresholds are assumptions.
- Fixtures are synthetic; scores are untested on live data.
- Tests use ES-module imports; the package.json has no `"type": "module"`, so they rely on Node 22 module detection (node >= 22.7).
