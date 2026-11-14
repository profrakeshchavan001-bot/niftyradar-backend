'use strict';
// Overnight item 3: real per-source ok/fail recorders for GET /api/paper/health (instead of "unchecked").
// Dhan: paperbot/sources.js's dhanCall() around queueDhanCall(). Binance: paperbot/sources.js's get().
// Yahoo: paperbot/yahoo.js's existing stats object, extended. Unit-tested directly here, independent of
// the fixture-heavy test/paperYahoo.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNseSource, createCryptoSource } = require('../paperbot/sources');
const { createYahooSource } = require('../paperbot/yahoo');
const fs = require('node:fs');
const path = require('node:path');
const YAHOO_CHART_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'yahoo', 'chart-RELIANCE.NS-5m-5d.json'), 'utf8'));

test('Dhan stats: a successful dhanIntraday call increments ok and sets lastSuccessAt', async () => {
  let t = 1000;
  const axios = { post: async () => ({ data: { timestamp: [1700000000], open: [100], high: [101], low: [99], close: [100.5], volume: [10] } }) };
  const nse = createNseSource({ axios, queueDhanCall: (fn) => fn(), DHAN_BASE: 'https://x', DHAN_HEADERS: {}, getSecurityId: () => '1', getMovers: () => null, getLotSize: () => null, fetchNews: async () => [], now: () => t });
  await nse.candles('RELIANCE');
  assert.deepEqual(nse.stats, { ok: 1, fail: 0, lastError: null, lastSuccessAt: 1000, lastErrorAt: null });
});

test('Dhan stats: a failing dhanIntraday call increments fail and records the HTTP status', async () => {
  let t = 2000;
  const err = Object.assign(new Error('boom'), { response: { status: 808 } });
  const axios = { post: async () => { throw err; } };
  const nse = createNseSource({ axios, queueDhanCall: (fn) => fn(), DHAN_BASE: 'https://x', DHAN_HEADERS: {}, getSecurityId: () => '1', getMovers: () => null, getLotSize: () => null, fetchNews: async () => [], now: () => t });
  await nse.candles('RELIANCE'); // falls back to built_from_live_prices; dhanIntraday's own failure is still recorded
  assert.equal(nse.stats.ok, 0);
  assert.equal(nse.stats.fail, 1);
  assert.equal(nse.stats.lastError, 'HTTP 808');
  assert.equal(nse.stats.lastErrorAt, 2000);
});

test('Dhan stats: the option-chain path (chainCall) also counts toward the same stats object', async () => {
  let t = 3000;
  const axios = { post: async (url) => (url.includes('expirylist') ? { data: { data: ['2026-11-27'] } } : { data: { data: { last_price: 100, oc: { 100: { ce: { last_price: 5 } } } } } }) };
  const nse = createNseSource({ axios, queueDhanCall: (fn) => fn(), DHAN_BASE: 'https://x', DHAN_HEADERS: {}, getSecurityId: () => '1', getMovers: () => null, getLotSize: () => null, fetchNews: async () => [], now: () => t });
  const q = await nse.optionQuote('RELIANCE', 'up', {});
  assert.ok(q);
  assert.equal(nse.stats.ok, 2); // expirylist + optionchain, both through dhanCall
});

test('Binance stats: candles() success increments ok once (first host answers)', async () => {
  let t = 4000;
  const crypto = createCryptoSource({ axios: { get: async () => ({ data: [[1700000000000, '100', '101', '99', '100.5', '10']] }) }, now: () => t });
  await crypto.candles('BTCUSDT');
  assert.deepEqual(crypto.stats, { ok: 1, fail: 0, lastError: null, lastSuccessAt: 4000, lastErrorAt: null });
});

test('Binance stats: both hosts failing counts as exactly one failure (not one per host)', async () => {
  let t = 5000;
  const err = Object.assign(new Error('down'), { response: { status: 503 } });
  const crypto = createCryptoSource({ axios: { get: async () => { throw err; } }, now: () => t });
  await assert.rejects(crypto.candles('BTCUSDT'));
  assert.equal(crypto.stats.ok, 0);
  assert.equal(crypto.stats.fail, 1); // 2 hosts tried internally, 1 failure recorded
  assert.equal(crypto.stats.lastError, 'HTTP 503');
});

test('Binance stats: a success on the second host (first host down) still counts as ok', async () => {
  let t = 6000;
  let calls = 0;
  const crypto = createCryptoSource({
    axios: { get: async () => { calls += 1; if (calls === 1) throw new Error('first host down'); return { data: [[1700000000000, '1', '1', '1', '1', '1']] }; } },
    now: () => t,
  });
  await crypto.candles('BTCUSDT');
  assert.equal(crypto.stats.ok, 1);
  assert.equal(crypto.stats.fail, 0);
});

test('Yahoo stats: a successful get() increments ok and sets lastSuccessAt (existing requests/failures fields untouched)', async () => {
  let t = 7000;
  const axios = { get: async () => ({ data: YAHOO_CHART_FIXTURE }) };
  const yahoo = createYahooSource({ axios, now: () => t, sleep: async () => {}, universe: ['RELIANCE'] });
  await yahoo.get('RELIANCE');
  assert.equal(yahoo.stats.ok, 1);
  assert.equal(yahoo.stats.failures, 0);
  assert.equal(yahoo.stats.lastSuccessAt, 7000);
});

test('Yahoo stats: a failure (no usable candles) increments failures and records lastError', async () => {
  let t = 8000;
  const axios = { get: async () => ({ data: { chart: { result: [{ timestamp: [], indicators: { quote: [{ open: [], high: [], low: [], close: [], volume: [] }] }, meta: {} }] } } }) };
  const yahoo = createYahooSource({ axios, now: () => t, sleep: async () => {}, universe: ['RELIANCE'] });
  await assert.rejects(yahoo.get('RELIANCE'));
  assert.equal(yahoo.stats.ok, 0);
  assert.equal(yahoo.stats.failures, 1);
  assert.match(yahoo.stats.lastError, /RELIANCE failed/);
  assert.equal(yahoo.stats.lastErrorAt, 8000);
});
