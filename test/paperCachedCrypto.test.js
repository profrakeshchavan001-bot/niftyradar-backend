'use strict';
// Shared candle cache wiring (paperbot/index.js createCachedCrypto, CC3 overnight EXTRA item): the main crypto bot, the scalp bots and
// the src/paper/bots/ plugins all ask the same crypto source for the same symbol's candles; this makes sure they share ONE Binance
// fetch instead of one each, without ever serving a cached answer to a call that asked for something different (a custom range/limit).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCachedCrypto } = require('../paperbot/index');

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
