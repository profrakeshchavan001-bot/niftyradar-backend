'use strict';
// confluence (Bot A) orchestration (src/paper/bots/confluence/bot.js): max 6 trades/day/bot, and every
// skip whose plan made it all the way to the reward/risk gate is logged to the shadow table.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('../paperbot/engine');
const { createConfluenceBot } = require('../src/paper/bots/confluence/bot');
const { createMemoryConfluenceStore } = require('../src/paper/bots/confluence/store');
const { createMemoryShadowStore } = require('../src/paper/shadow/store');
const { CONFLUENCE_DEFAULTS } = require('../src/paper/bots/confluence/config');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { istDayStart } = require('../paperbot/time');

const MIN = 60000; const FIVE = 5 * MIN;
const mk = (t, o, h, l, c, v = 10) => ({ t, o, h, l, c, v });

// bot.js (unlike the engine-level test) computes "today" from the real istDayStart(now()), not a
// hand-picked dayStartMs - so these fixtures anchor the sweep candle to an actual IST day boundary and
// put the range/lead candles strictly BEFORE it, exactly like the engine-level fixtures do.
function anchoredScene(sweepHigh) {
  const dayStart = istDayStart(Date.parse('2026-11-18T10:00:00Z'));
  const sweep = mk(dayStart, 98, sweepHigh, 93, 99); // first candle of "today"
  const prior = []; let t = dayStart - 10 * FIVE;
  for (let i = 0; i < 10; i++) { prior.push(mk(t, 100, 103, 97, 100.5)); t += FIVE; }
  const lead = []; let t2 = dayStart - 10 * FIVE - 5 * FIVE;
  for (let i = 0; i < 5; i++) { lead.push(mk(t2, 100, 101, 99, 100)); t2 += FIVE; }
  lead[2] = mk(lead[2].t, 100, 140, 99, 100);
  return { candles: [...lead, ...prior, sweep], triggerT: sweep.t, nowMs: sweep.t + FIVE + 1000 };
}
const takeCandles = () => anchoredScene(99);
const shadowSkipCandles = () => anchoredScene(99.3); // upper wick -> "today's high" becomes the nearest obstacle -> R:R too small

function cfgFor(scene) { return { ...CONFLUENCE_DEFAULTS, min_candles_5m: 10, symbols: ['BTCUSDT'], max_trades_per_day: 6 }; }

function cryptoStub(scene) {
  return {
    async candles() { return scene.candles; },
    async hourly() { return []; },
    async usdtInr(fallback) { return { rate: fallback, source: 'test' }; },
  };
}

test('plugin: auto-discovered by src/paper/pluginLoader.js under bots/confluence (no manual wiring needed)', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'confluence'));
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'confluence_flow'));
});

test('scan(): a valid confluence setup opens exactly one trade', async () => {
  const scene = takeCandles();
  const store = createMemoryConfluenceStore();
  const shadowStore = createMemoryShadowStore();
  const bot = createConfluenceBot({ store, crypto: cryptoStub(scene), loadCfg: async () => cfgFor(scene), shadowStore, now: () => scene.nowMs, log: () => {} });
  const r = await bot.scan();
  assert.deepEqual(r.entered, ['BTCUSDT']);
  const open = await store.openTrades('BTCUSDT');
  assert.equal(open.length, 1);
  assert.equal(open[0].direction, 'LONG');
});

test('max 6 trades/day/bot: scan() refuses a 7th entry once today already holds 6, without even reading candles again', async () => {
  const scene = takeCandles();
  const store = createMemoryConfluenceStore();
  for (let i = 0; i < 6; i++) {
    await store.insertTrade({ symbol: 'BTCUSDT', trade_date: '2026-11-18', status: 'closed', direction: 'LONG', trigger_t: i + 1, entry_price: 100, entry_time: new Date().toISOString(), sl_price: 99, target_price: 102, qty: 1, basis: 'x' });
  }
  const greedyCrypto = { async candles() { throw new Error('must not be called once the daily cap is reached'); }, async hourly() { return []; }, usdtInr: async () => ({ rate: 88 }) };
  const bot = createConfluenceBot({ store, crypto: greedyCrypto, loadCfg: async () => cfgFor(scene), shadowStore: null, now: () => Date.parse('2026-11-18T10:00:00Z'), log: () => {} });
  const r = await bot.scan();
  assert.deepEqual(r.entered, []);
  assert.match(r.reason, /max 6 trades\/day reached/);
});

test('shadow logging: a setup whose only failure is the R:R gate is recorded in the shadow log with a full would-be plan, never counted as a trade', async () => {
  const scene = shadowSkipCandles();
  const store = createMemoryConfluenceStore();
  const shadowStore = createMemoryShadowStore();
  const bot = createConfluenceBot({ store, crypto: cryptoStub(scene), loadCfg: async () => cfgFor(scene), shadowStore, now: () => scene.nowMs, log: () => {} });
  const r = await bot.scan();
  assert.deepEqual(r.entered, []);
  const open = await store.openTrades('BTCUSDT');
  assert.equal(open.length, 0, 'the R:R-failed setup must never become a real trade');
  const shadows = await shadowStore.openShadows('confluence');
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].direction, 'LONG');
  assert.equal(shadows[0].symbol, 'BTCUSDT');
  assert.match(shadows[0].skip_reason, /below 1\.5/);
  const skips = await store.skipsSince('1970-01-01');
  assert.equal(skips.length, 1);
});
