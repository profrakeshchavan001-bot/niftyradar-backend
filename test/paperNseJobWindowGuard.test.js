'use strict';
// Overnight/weekend false-alert fix, root cause side: nseScan/nseMonitor must do NO work at all -
// no config load, no database read, no candle/quote fetch - outside the buffered 09:00-15:45 IST job
// window (paperbot/time.js's nseJobWindow), weekday, weekend and holiday alike. This is what actually
// stops the Neon compute waste (item 2 of the brief); src/paper/ops/alerts/register.js (opsAlerts.test.js)
// covers the matching alert-silencing side.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');

// Monday 2026-01-05, 10:30 IST (inside both the job window and the real market session).
const IN_HOURS = Date.UTC(2026, 0, 5, 5, 0, 0);
// Same Monday, 20:00 IST (well outside the 09:00-15:45 job window).
const OUT_OF_HOURS = Date.UTC(2026, 0, 5, 14, 30, 0);
// Saturday 2026-01-10, 10:30 IST (weekend: closed at every hour).
const WEEKEND = Date.UTC(2026, 0, 10, 5, 0, 0);

// A store/source pair that throws on any call the job-window guard should have prevented, and a
// memory store wrapped to count real calls, so "no work happened" is a real assertion, not a guess.
function countingStore() {
  const inner = createMemoryStore();
  const calls = { openTrades: 0, tradesForDay: 0, getConfig: 0 };
  return {
    inner,
    calls,
    getConfig: async (...a) => { calls.getConfig += 1; return inner.getConfig(...a); },
    setConfigIfMissing: (...a) => inner.setConfigIfMissing(...a),
    openTrades: async (...a) => { calls.openTrades += 1; return inner.openTrades(...a); },
    tradesForDay: async (...a) => { calls.tradesForDay += 1; return inner.tradesForDay(...a); },
    insertTrade: (...a) => inner.insertTrade(...a),
    insertSkip: (...a) => inner.insertSkip(...a),
    updateTrade: (...a) => inner.updateTrade(...a),
    noteTrade: (...a) => inner.noteTrade(...a),
    get _db() { return inner._db; },
  };
}

function throwingNse() {
  return {
    prepare: async () => { throw new Error('nse.prepare must not be called outside the job window'); },
    ranking: () => { throw new Error('nse.ranking must not be called outside the job window'); },
    candles: async () => { throw new Error('nse.candles must not be called outside the job window'); },
    spot: () => { throw new Error('nse.spot must not be called outside the job window'); },
    refreshSpot: async () => { throw new Error('nse.refreshSpot must not be called outside the job window'); },
    optionQuote: async () => { throw new Error('nse.optionQuote must not be called outside the job window'); },
    lotSize: () => { throw new Error('nse.lotSize must not be called outside the job window'); },
    news: async () => { throw new Error('nse.news must not be called outside the job window'); },
  };
}

test('nseScan outside the job window (night): returns ran:false immediately, no config load, no quote/candle calls', async () => {
  const store = countingStore();
  const clock = { t: OUT_OF_HOURS };
  const bot = createBot({ store, nse: throwingNse(), crypto: null, now: () => clock.t, log: () => {} });
  const result = await bot.nseScan();
  assert.equal(result.ran, false);
  assert.match(result.reason, /job window/);
  assert.equal(store.calls.getConfig, 0, 'loadConfig must not touch the database outside the job window');
});

test('nseScan on a weekend: same early return, no database read', async () => {
  const store = countingStore();
  const clock = { t: WEEKEND };
  const bot = createBot({ store, nse: throwingNse(), crypto: null, now: () => clock.t, log: () => {} });
  const result = await bot.nseScan();
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'weekend');
  assert.equal(store.calls.getConfig, 0);
});

test('nseScan inside the job window: runs normally (config loaded, quotes asked for)', async () => {
  const store = countingStore();
  const clock = { t: IN_HOURS };
  const nse = { ...throwingNse(), prepare: async () => {}, ranking: () => null }; // no live quotes: scan still runs, just finds nothing to rank
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log: () => {} });
  const result = await bot.nseScan();
  assert.equal(result.ran, false); // "no live quotes" - but it DID get past the job-window gate
  assert.equal(result.reason, 'no live quotes');
  assert.equal(store.calls.getConfig, 1, 'loadConfig runs once the job window is open');
});

test('nseMonitor outside the job window: returns immediately, never reads open trades from the database', async () => {
  const store = countingStore();
  const clock = { t: OUT_OF_HOURS };
  const bot = createBot({ store, nse: throwingNse(), crypto: null, now: () => clock.t, log: () => {} });
  const result = await bot.nseMonitor();
  assert.equal(result.checked, 0);
  assert.equal(result.ran, false);
  assert.equal(store.calls.openTrades, 0, 'store.openTrades must not be called outside the job window');
});

test('nseMonitor on a weekend: same early return, no database read', async () => {
  const store = countingStore();
  const clock = { t: WEEKEND };
  const bot = createBot({ store, nse: throwingNse(), crypto: null, now: () => clock.t, log: () => {} });
  const result = await bot.nseMonitor();
  assert.equal(result.checked, 0);
  assert.equal(store.calls.openTrades, 0);
});

test('nseMonitor inside the job window: does read open trades from the database', async () => {
  const store = countingStore();
  const clock = { t: IN_HOURS };
  const bot = createBot({ store, nse: throwingNse(), crypto: null, now: () => clock.t, log: () => {} });
  const result = await bot.nseMonitor();
  assert.equal(result.checked, 0); // no open trades in this fresh store, but it DID check
  assert.equal(store.calls.openTrades, 1);
});
