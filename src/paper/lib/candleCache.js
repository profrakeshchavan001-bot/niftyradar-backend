'use strict';
// One candle cache shared by every bot (CC2, item 1a).
//
// Problem: the scalp bot (src/paper/scalp/) already pulls its own 1-minute
// Binance candles separately from the main crypto bot (paperbot/sources.js),
// and new bots under src/paper/bots/ would otherwise each add their own
// fetch for the same symbol+timeframe. This cache lets any bot ask for
// `${symbol}:${timeframe}` and get candles fetched at most once per cycle,
// even if ten bots ask for the same pair in the same tick.
//
// Nothing existing is wired to this yet - adding it here does not change any
// current bot's behaviour. Other windows opt in by calling get() instead of
// fetching candles directly.
//
// get(key, fetcher, { ttlMs }): returns a Promise<candles>. While a fetch for
// `key` is in flight, every caller gets the SAME promise (no duplicate
// network calls). Once it resolves, the result is kept for `ttlMs` (default
// 60s - one NSE 5-min-candle-adjacent cycle) and served from memory.
function createCandleCache({ ttlMs = 60000, now = Date.now } = {}) {
  const entries = new Map(); // key -> { value, fetchedAt, pending }

  async function get(key, fetcher, opt = {}) {
    const ttl = opt.ttlMs != null ? opt.ttlMs : ttlMs;
    const existing = entries.get(key);
    const t = now();
    if (existing) {
      if (existing.pending) return existing.pending;
      if (t - existing.fetchedAt < ttl) return existing.value;
    }
    const pending = Promise.resolve().then(fetcher);
    entries.set(key, { value: existing ? existing.value : null, fetchedAt: existing ? existing.fetchedAt : 0, pending });
    try {
      const value = await pending;
      entries.set(key, { value, fetchedAt: now(), pending: null });
      return value;
    } catch (e) {
      // keep whatever (possibly stale) value was there before; never cache a failure
      entries.set(key, { value: existing ? existing.value : null, fetchedAt: existing ? existing.fetchedAt : 0, pending: null });
      throw e;
    }
  }

  function clear(key) {
    if (key == null) entries.clear();
    else entries.delete(key);
  }

  function stats() {
    return { size: entries.size, keys: [...entries.keys()] };
  }

  return { get, clear, stats };
}

const keyOf = (symbol, timeframe, source = 'default') => `${source}:${symbol}:${timeframe}`;

module.exports = { createCandleCache, keyOf };
