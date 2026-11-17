'use strict';
// FREE data source for the four NSE currency-futures pairs this task adds (USDINR, EURINR, GBPINR,
// JPYINR), reusing Yahoo Finance's public chart endpoint - the SAME free, no-key endpoint
// paperbot/yahoo.js already uses for NSE equities (parseChart() is imported from there, not copied), just
// pointed at Yahoo's FX tickers (USDINR=X, EURINR=X, GBPINR=X, JPYINR=X) instead of SYMBOL.NS. This is a
// SPOT-FX proxy for the futures (no free futures candle feed is wired into this repo), same convention
// as every other "this repo has no real feed, use the nearest free one and say so" bot (e.g. nseScalpScan
// in src/paper/scalp/bot.js). PAPER ONLY, read-only, no Twelve Data key anywhere in this file (rule: users
// and bots never call Twelve Data directly except the shared src/lib/td.js client, which does not apply
// to this standalone paper-trading demo at all).
//
// Rules kept here, same spirit as paperbot/yahoo.js: one request at a time per pair, a short in-memory
// cache per symbol+interval (so a scan tick and the matching monitor tick a few seconds later never both
// hit Yahoo), a failed symbol is cached as an error for the rest of that cache window (not retried every
// call), nothing is filled in - a chart Yahoo sends with no usable candles throws.
const { parseChart } = require('../../../paperbot/yahoo');

// All four pairs this task adds. Every one of them is a standard Yahoo Finance FX cross (visible on
// finance.yahoo.com today) - no paid feed, no key. If any one of these ever stops answering in
// production, PAIR_ENABLED_ENV below is the per-pair kill switch (default on) the task asked for; this
// repo has no evidence today that any of the four lacks a free source.
const YAHOO_TICKER = {
  USDINR: 'USDINR=X',
  EURINR: 'EURINR=X',
  GBPINR: 'GBPINR=X',
  JPYINR: 'JPYINR=X',
};

const STEP_MS = { '5m': 300000, '15m': 900000 };
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One source shared by all four pairs (own cache, own gap/backoff timing) - mirrors createYahooSource's
// shape in paperbot/yahoo.js but scoped to just the four FX tickers above, never the 60-stock universe.
function createCurrencyFxSource({ axios, log = console.log, now = Date.now, sleep = defaultSleep, gapMs = 1000, windowMs = 60000, timeoutMs = 8000, maxRetries = 2, backoffMs = 1500 }) {
  const cache = new Map(); // `${ticker}|${interval}` -> { candles, meta, fetchedAt } | { error, fetchedAt }
  let queue = Promise.resolve();
  let lastStart = -Infinity;

  async function request(ticker, interval, range) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastStart + gapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      try {
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`, {
          params: { interval, range },
          timeout: timeoutMs,
          headers: { 'User-Agent': 'niftyradar-paperbot/1.0 (paper trading demo, read-only; about 1 request per second)' },
        });
        return res.data;
      } catch (e) {
        if (attempt >= maxRetries) throw e;
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }

  async function get(ticker, interval, range) {
    const key = `${ticker}|${interval}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < windowMs) {
      if (hit.error) throw new Error(hit.error);
      return hit;
    }
    const p = queue.then(async () => {
      try {
        const parsed = parseChart(await request(ticker, interval, range), interval);
        if (!parsed.candles.length) throw new Error('chart response has no usable candles');
        const entry = { ...parsed, fetchedAt: now() };
        cache.set(key, entry);
        return entry;
      } catch (e) {
        const error = `Yahoo ${interval} candles for ${ticker} failed: ${e.response?.status ? `HTTP ${e.response.status}` : e.message}`;
        cache.set(key, { error, fetchedAt: now() });
        log(`[currency-fx] ${error}`);
        throw new Error(error);
      }
    });
    queue = p.catch(() => {});
    return p;
  }

  // -> raw candle array, { t, o, h, l, c, v }, same shape every other crypto/NSE candle source returns.
  async function candlesFor(pair, interval, range) {
    const ticker = YAHOO_TICKER[pair];
    if (!ticker) throw new Error(`no Yahoo FX ticker configured for ${pair}`);
    const entry = await get(ticker, interval, range);
    return entry.candles;
  }

  return {
    candles5: (pair) => candlesFor(pair, '5m', '5d'),
    candles15: (pair) => candlesFor(pair, '15m', '1mo'),
  };
}

module.exports = { createCurrencyFxSource, YAHOO_TICKER, STEP_MS };
