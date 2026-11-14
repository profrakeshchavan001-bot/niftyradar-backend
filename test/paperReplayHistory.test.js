'use strict';
// History loader (src/paper/replay/history.js). Offline: a fake axios stands in for Binance (Binance's public
// klines host is blocked from this sandbox -- confirmed once with curl, see docs/REPLAY.md -- so this is
// "not verified live"). Checks pagination, resumability (second call only asks for what is missing) and
// that a symbol/interval failure never stops the rest of the load.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryClient, loadOne, loadHistory, INTERVAL_MS } = require('../src/paper/replay/history');
const { createMemoryReplayStore } = require('../src/paper/replay/store');

const MIN = INTERVAL_MS['1m'];

// A Binance kline row, in Binance's own array shape: [openTime, open, high, low, close, volume, ...].
const row = (t) => [t, '100.00', '100.10', '99.90', '100.05', '10.0', 0, '0', 0, '0', '0', '0'];

function fakeAxios(pages) {
  const calls = [];
  return {
    calls,
    async get(url, { params }) {
      calls.push({ url, params });
      const { startTime, endTime } = params;
      const rows = [];
      for (let t = startTime; t <= endTime; t += MIN) rows.push(row(t));
      return { data: rows };
    },
  };
}

test('loadOne: pages forward from the window start and records the last candle it stored', async () => {
  const axios = fakeAxios();
  const client = createHistoryClient({ axios, hosts: ['https://fake'] });
  const store = createMemoryReplayStore();
  const now = 10 * MIN; // tiny window: 10 one-minute candles
  const r = await loadOne({ client, store, symbol: 'BTCUSDT', interval: '1m', days: 10 / 1440, now, pauseMs: 0 });
  assert.equal(r.rows, 10); // t = 0, 1*MIN, ..., 9*MIN (10 candles, the 10th at t=9*MIN < now=10*MIN)
  const last = await store.lastCandleT('BTCUSDT', '1m');
  assert.equal(last, 9 * MIN);
  const stored = await store.getCandles('BTCUSDT', '1m', {});
  assert.equal(stored.length, 10);
});

test('loadOne: resumable -- a second call only asks Binance for candles after the stored progress marker', async () => {
  const axios = fakeAxios();
  const client = createHistoryClient({ axios, hosts: ['https://fake'] });
  const store = createMemoryReplayStore();
  const now1 = 5 * MIN;
  await loadOne({ client, store, symbol: 'ETHUSDT', interval: '1m', days: 5 / 1440, now: now1, pauseMs: 0 });
  assert.equal(await store.lastCandleT('ETHUSDT', '1m'), 4 * MIN);

  const callsBefore = axios.calls.length;
  const now2 = 8 * MIN;
  const r2 = await loadOne({ client, store, symbol: 'ETHUSDT', interval: '1m', days: 5 / 1440, now: now2, pauseMs: 0 });
  assert.equal(r2.rows, 3); // only t = 5*MIN, 6*MIN, 7*MIN are new
  const firstNewCallParams = axios.calls[callsBefore].params;
  assert.equal(firstNewCallParams.startTime, 5 * MIN); // resumed right after the last stored candle, not from the window start
  const all = await store.getCandles('ETHUSDT', '1m', {});
  assert.equal(all.length, 8); // 0..7*MIN, no duplicates from the overlap-free resume
});

test('loadHistory: a failing symbol/interval is reported in errors and never stops the others', async () => {
  const store = createMemoryReplayStore();
  let n = 0;
  const client = {
    async klines(symbol) {
      n += 1;
      if (symbol === 'BADCOIN') throw Object.assign(new Error('boom'), { response: { status: 500 } });
      return [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }];
    },
  };
  const { results, errors } = await loadHistory({ client, store, symbols: ['BADCOIN', 'BTCUSDT'], intervals: ['1m'], days: 1, now: MIN, pauseMs: 0 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'BADCOIN');
  assert.equal(results.length, 1);
  assert.equal(results[0].symbol, 'BTCUSDT');
});

test('createHistoryClient: falls back to the second host when the first fails', async () => {
  let firstTried = false;
  const axios = {
    async get(url) {
      if (url.startsWith('https://down')) { firstTried = true; throw new Error('unreachable'); }
      return { data: [row(0)] };
    },
  };
  const client = createHistoryClient({ axios, hosts: ['https://down', 'https://up'] });
  const out = await client.klines('BTCUSDT', '1m', { startTime: 0, endTime: 0, limit: 1 });
  assert.equal(firstTried, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].t, 0);
});
