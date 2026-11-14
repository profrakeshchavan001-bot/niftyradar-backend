'use strict';
// Shared candle cache wiring (paperbot/index.js createCachedCrypto, CC3 overnight EXTRA item): the main crypto bot, the scalp bots and
// the src/paper/bots/ plugins all ask the same crypto source for the same symbol's candles; this makes sure they share ONE Binance
// fetch instead of one each, without ever serving a cached answer to a call that asked for something different (a custom range/limit).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCachedCrypto, create15mCrypto } = require('../paperbot/index');
const { createCandleCache } = require('../src/paper/lib/candleCache');

function fakeRaw() {
  const calls = { candles: [], hourly: [] };
  return {
    calls,
    async candles(symbol, limit, range) { calls.candles.push({ symbol, limit, range }); return [{ t: calls.candles.length }]; },
    async hourly(symbol, limit) { calls.hourly.push({ symbol, limit }); return [{ t: calls.hourly.length }]; },
    async price(symbol) { return 100; }, // passed through unchanged
  };
}

test('two bots asking for the same symbol within the TTL share ONE fetch', async () => {
  const raw = fakeRaw();
  const cached = createCachedCrypto(raw);
  const [a, b] = await Promise.all([cached.candles('BTCUSDT'), cached.candles('BTCUSDT')]);
  assert.deepEqual(a, b); // same cached answer
  assert.equal(raw.calls.candles.length, 1, 'only one real network call for both callers');
});

test('different symbols are fetched independently, each once', async () => {
  const raw = fakeRaw();
  const cached = createCachedCrypto(raw);
  await Promise.all([cached.candles('BTCUSDT'), cached.candles('ETHUSDT')]);
  assert.equal(raw.calls.candles.length, 2);
});

test('a custom range (the report page chart) is never served a cached answer, and never pollutes the shared cache', async () => {
  const raw = fakeRaw();
  const cached = createCachedCrypto(raw);
  await cached.candles('BTCUSDT'); // warms the shared cache
  await cached.candles('BTCUSDT', 500, { startMs: 1, endMs: 2 }); // a specific window: must hit the network, not the cache
  await cached.candles('BTCUSDT'); // the plain call afterwards still reads the ORIGINAL cached answer, not the ranged one
  assert.equal(raw.calls.candles.length, 2, 'one for the shared cache, one for the ranged call; the second plain call was served from cache');
});

test('hourly candles are cached the same way, separately from 5-minute candles', async () => {
  const raw = fakeRaw();
  const cached = createCachedCrypto(raw);
  await Promise.all([cached.hourly('BTCUSDT'), cached.hourly('BTCUSDT'), cached.candles('BTCUSDT')]);
  assert.equal(raw.calls.hourly.length, 1); assert.equal(raw.calls.candles.length, 1);
});

test('price() and every other method pass straight through, uncached', async () => {
  const raw = fakeRaw();
  const cached = createCachedCrypto(raw);
  assert.equal(await cached.price('BTCUSDT'), 100);
});

// CC3 round 3 item 3: one shared cache across 5m/1h/15m, so the 15-minute source (trend_smc) and the 5m/1h source (everyone
// else) can never both hold their own separate copy of the same symbol+timeframe fetch.
test('create15mCrypto shares the SAME cache instance as createCachedCrypto: a 5m fetch and a 15m fetch of the same symbol are independent (different keys), but each is fetched once no matter how many bots ask', async () => {
  const cache = createCandleCache({ ttlMs: 50000 });
  const raw5m = fakeRaw();
  const raw15m = { calls: [], async candles15(symbol) { this.calls.push(symbol); return [{ t: 1 }]; } };
  const cached5m = createCachedCrypto(raw5m, cache);
  const cached15m = create15mCrypto(raw15m, cache);
  await Promise.all([cached5m.candles('BTCUSDT'), cached5m.candles('BTCUSDT'), cached15m.candles15('BTCUSDT'), cached15m.candles15('BTCUSDT')]);
  assert.equal(raw5m.calls.candles.length, 1, 'one 5m fetch for both callers');
  assert.equal(raw15m.calls.length, 1, 'one 15m fetch for both callers, not mixed up with the 5m one');
  assert.equal(cache.stats().size, 2, 'exactly two cache entries (5m, 15m) for this one symbol, on the one shared cache');
});

test('create15mCrypto: a non-default limit bypasses the cache, same convention as the 5m/1h source', async () => {
  const cache = createCandleCache({ ttlMs: 50000 });
  const raw15m = { calls: [], async candles15(symbol, limit) { this.calls.push({ symbol, limit }); return []; } };
  const cached15m = create15mCrypto(raw15m, cache);
  await cached15m.candles15('BTCUSDT');
  await cached15m.candles15('BTCUSDT', 50);
  await cached15m.candles15('BTCUSDT');
  assert.equal(raw15m.calls.length, 2, 'one cached call warms the cache, the custom-limit call bypasses it, the final plain call is served from cache');
});
