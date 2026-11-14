'use strict';
// History loader: paginated Binance public klines for the replay engine. PAPER ONLY, read-only, no key.
// Resumable (per symbol+interval progress in replay_history_progress), polite to Binance (one page in flight,
// a small pause between pages), small memory (each page is written to the store and dropped, never held in full).
//
// Binance /api/v3/klines: max 1000 rows per call; startTime/endTime select a window; rows are ms-epoch open times.
// Same two public hosts the live scalp/crypto sources use (src/paper/scalp/source.js): data-api.binance.vision first,
// api.binance.com as a fallback. No API key anywhere.
const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 };
const PAGE_LIMIT = 1000;
const DEFAULT_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

function toCandle(row) {
  return { t: row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], v: +row[5] };
}

function createHistoryClient({ axios, hosts = DEFAULT_HOSTS, log = () => {} }) {
  async function klines(symbol, interval, { startTime, endTime, limit = PAGE_LIMIT } = {}) {
    let lastErr;
    for (const h of hosts) {
      try {
        const { data } = await axios.get(`${h}/api/v3/klines`, { params: { symbol, interval, startTime, endTime, limit }, timeout: 15000 });
        return data.map(toCandle).filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite));
      } catch (e) { lastErr = e; log(`[replay] history ${symbol} ${interval} host ${h} failed: ${e.response?.status || e.message}`); }
    }
    throw lastErr;
  }
  return { klines };
}

// Loads `days` of history for one symbol+interval, resuming from the store's own progress marker.
// Writes each page as it arrives (never holds more than one page in memory) and sleeps `pauseMs`
// between pages so a 30-day backfill of several symbols never bursts Binance's free, keyless limit.
async function loadOne({ client, store, symbol, interval, days, now = Date.now(), pauseMs = 350, log = () => {} }) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`unknown interval ${interval}`);
  const windowStart = now - days * 86400000;
  const lastClosedOpenT = now - stepMs; // the newest candle that has fully closed by `now`
  const resumeFrom = await store.lastCandleT(symbol, interval);
  let startTime = resumeFrom != null ? resumeFrom + stepMs : windowStart;
  if (startTime < windowStart) startTime = windowStart;
  let pages = 0; let rows = 0;
  for (;;) {
    if (startTime > lastClosedOpenT) break;
    const endTime = Math.min(startTime + (PAGE_LIMIT - 1) * stepMs, lastClosedOpenT);
    // eslint-disable-next-line no-await-in-loop
    const page = await client.klines(symbol, interval, { startTime, endTime, limit: PAGE_LIMIT });
    if (!page.length) break;
    // eslint-disable-next-line no-await-in-loop
    await store.upsertCandles(symbol, interval, page);
    const lastT = page[page.length - 1].t;
    // eslint-disable-next-line no-await-in-loop
    await store.setLastCandleT(symbol, interval, lastT);
    rows += page.length; pages += 1;
    log(`[replay] history ${symbol} ${interval}: +${page.length} candles (page ${pages}, up to ${new Date(lastT).toISOString()})`);
    if (page.length < 2) break; // feed has nothing more right now
    startTime = lastT + stepMs;
    if (startTime > lastClosedOpenT) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { symbol, interval, pages, rows };
}

// Loads every symbol x interval in series (never in parallel: stays polite to the rate limit and keeps peak
// memory to one page). Never throws on a single symbol/interval failure (a bad night must not stop the rest);
// failures are returned in `errors` and logged, so the job can be scheduled unattended.
async function loadHistory({ client, store, symbols, intervals, days, now = Date.now(), pauseMs = 350, log = () => {} }) {
  const results = []; const errors = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await loadOne({ client, store, symbol, interval, days, now, pauseMs, log });
        results.push(r);
      } catch (e) {
        log(`[replay] history ${symbol} ${interval} FAILED: ${e.response?.status || e.message}`);
        errors.push({ symbol, interval, error: e.response?.status ? `HTTP ${e.response.status}` : e.message });
      }
    }
  }
  return { results, errors };
}

module.exports = { createHistoryClient, loadHistory, loadOne, INTERVAL_MS, DEFAULT_HOSTS };
