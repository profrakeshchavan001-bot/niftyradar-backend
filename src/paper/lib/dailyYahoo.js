'use strict';
// FREE daily-bar source for the research-strategy demo bots (research_usdinr_trend, research_btc_momentum,
// research_nifty200_52whigh - docs/RESEARCH-STRATEGIES-REPORT.md). Reuses the same public, no-key Yahoo
// Finance chart endpoint every other paper-trading source in this repo already calls
// (paperbot/yahoo.js, src/paper/lib/currencyFx.js), just with interval=1d/range=2y instead of their
// 5m/15m intraday ranges - those two files' own STEP_MS table only covers 5m/15m, so this is a small,
// separate parser rather than a change to either of them. One request at a time, a short in-memory
// cache per ticker, a failed ticker is cached as an error for the rest of that window (never retried
// every call) - same spirit as paperbot/yahoo.js's own rules.
const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const USER_AGENT = 'niftyradar-paperbot/1.0 (paper trading demo, read-only; about 1 request per second)';

function parseDailyChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'chart response has no result');
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q || !Array.isArray(q.close)) throw new Error('chart response has no candles');
  const closes = [];
  ts.forEach((sec, i) => {
    const c = q.close[i];
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) closes.push({ date: new Date(sec * 1000).toISOString().slice(0, 10), close: c });
  });
  const m = r.meta || {};
  return { closes, livePrice: typeof m.regularMarketPrice === 'number' ? m.regularMarketPrice : null };
}

// One source shared by every research bot (own cache, own request queue), mirrors createCurrencyFxSource's
// shape (src/paper/lib/currencyFx.js) but for long daily history instead of short intraday candles.
function createDailyYahooSource({ axios, log = console.log, now = Date.now, windowMs = 6 * 3600000, timeoutMs = 10000, gapMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cache = new Map(); // ticker -> { closes, livePrice, fetchedAt } | { error, fetchedAt }
  let queue = Promise.resolve();
  let lastStart = -Infinity;

  function get(ticker, range = '3y') {
    const hit = cache.get(ticker);
    if (hit && now() - hit.fetchedAt < windowMs) {
      if (hit.error) throw new Error(hit.error);
      return Promise.resolve(hit);
    }
    const p = queue.then(async () => {
      const wait = lastStart + gapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      try {
        const res = await axios.get(`${BASE}${encodeURIComponent(ticker)}`, {
          params: { interval: '1d', range },
          timeout: timeoutMs,
          headers: { 'User-Agent': USER_AGENT },
        });
        const parsed = parseDailyChart(res.data);
        if (!parsed.closes.length) throw new Error('chart response has no usable daily closes');
        const entry = { ...parsed, fetchedAt: now() };
        cache.set(ticker, entry);
        return entry;
      } catch (e) {
        const error = `Yahoo daily chart for ${ticker} failed: ${e.response?.status ? `HTTP ${e.response.status}` : e.message}`;
        cache.set(ticker, { error, fetchedAt: now() });
        log(`[daily-yahoo] ${error}`);
        throw new Error(error);
      }
    });
    queue = p.catch(() => {});
    return p;
  }

  return {
    // -> [{ date: 'YYYY-MM-DD', close }], oldest first, up to `range` of history (default 3y).
    dailyCloses: async (ticker, range) => (await get(ticker, range)).closes,
    // -> latest live/last-traded price for `ticker`, or null if unavailable.
    livePrice: async (ticker, range) => (await get(ticker, range)).livePrice,
  };
}

module.exports = { createDailyYahooSource, parseDailyChart };
