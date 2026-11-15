'use strict';
// How many candles to fetch so a stop/target/time-stop walk (src/paper/lib/exitSim.js and each bot's own
// evaluateExit) covers the WHOLE time a trade has been open, not just a fixed recent window.
//
// This is the gap that left paper_trades id=2 (crypto_wide_scalp, ETHUSDT) open long after its 45-minute time
// stop during the 14 Nov outage: once the service came back, every monitor asked for a fixed, recent window of
// candles (scalp's tight 1-minute monitor asked for only 40 x 1-minute candles - 40 minutes - every tick), so a
// trade left open for hours could never again be checked against its own entry candle. Widening the fetch to
// cover from the OLDEST open trade's entry to now (bounded by maxLimit, since Binance's own klines endpoint
// caps a single request at 1000 candles) fixes recovery for every bot without changing normal-case behaviour:
// when every open trade is recent, `needed` is below `defaultLimit` and the same default window (and the same
// cache key, where one exists) is used as before.
function recoveryLimit({ oldestEntryMs, nowMs, intervalMs, defaultLimit, maxLimit = 1000 }) {
  if (oldestEntryMs == null || !Number.isFinite(oldestEntryMs)) return defaultLimit;
  const needed = Math.ceil((nowMs - oldestEntryMs) / intervalMs) + 10; // +10 candles of margin
  return Math.min(Math.max(defaultLimit, needed), maxLimit);
}

module.exports = { recoveryLimit };
