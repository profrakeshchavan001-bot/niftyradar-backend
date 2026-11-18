'use strict';
// confluence_flow (Bot B, src/paper/bots/confluence_flow/bot.js): same as confluence, plus the order-flow
// agreement gate - a disagreeing flow reading skips the idea and logs it to the shadow log with the
// reason; an agreeing flow reading lets the exact same setup through.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfluenceFlowBot } = require('../src/paper/bots/confluence_flow/bot');
const { createMemoryConfluenceFlowStore } = require('../src/paper/bots/confluence_flow/store');
const { createMemoryShadowStore } = require('../src/paper/shadow/store');
const { CONFLUENCE_FLOW_DEFAULTS } = require('../src/paper/bots/confluence_flow/config');
const { istDayStart } = require('../paperbot/time');

const MIN = 60000; const FIVE = 5 * MIN;
const mk = (t, o, h, l, c, v = 10) => ({ t, o, h, l, c, v });

function scene() {
  const dayStart = istDayStart(Date.parse('2026-11-18T10:00:00Z'));
  const sweep = mk(dayStart, 98, 99, 93, 99);
  const prior = []; let t = dayStart - 10 * FIVE;
  for (let i = 0; i < 10; i++) { prior.push(mk(t, 100, 103, 97, 100.5)); t += FIVE; }
  const lead = []; let t2 = dayStart - 15 * FIVE;
  for (let i = 0; i < 5; i++) { lead.push(mk(t2, 100, 101, 99, 100)); t2 += FIVE; }
  lead[2] = mk(lead[2].t, 100, 140, 99, 100);
  return { candles: [...lead, ...prior, sweep], nowMs: sweep.t + FIVE + 1000 };
}

function cryptoStub(s) {
  return { async candles() { return s.candles; }, async hourly() { return []; }, async usdtInr(fb) { return { rate: fb, source: 'test' }; } };
}
const cfgFor = () => ({ ...CONFLUENCE_FLOW_DEFAULTS, min_candles_5m: 10, symbols: ['BTCUSDT'], max_trades_per_day: 6 });

test('order flow agrees (buy) with the LONG setup -> trade taken', async () => {
  const s = scene();
  const store = createMemoryConfluenceFlowStore();
  const orderFlow = { read: async () => ({ direction: 'buy', strength: 0.7, detail: { top5: 0.5, top10: 0.4, cvd30: 1, cvd60: 2, cvd120: 3 } }) };
  const bot = createConfluenceFlowBot({ store, crypto: cryptoStub(s), orderFlow, loadCfg: async () => cfgFor(), shadowStore: createMemoryShadowStore(), now: () => s.nowMs, log: () => {} });
  const r = await bot.scan();
  assert.deepEqual(r.entered, ['BTCUSDT']);
  const open = await store.openTrades('BTCUSDT');
  assert.equal(open.length, 1);
  assert.equal(open[0].flow_direction, 'buy');
});

test('order flow disagrees (sell) with the LONG setup -> skipped and shadow-logged, never a trade', async () => {
  const s = scene();
  const store = createMemoryConfluenceFlowStore();
  const shadowStore = createMemoryShadowStore();
  const orderFlow = { read: async () => ({ direction: 'sell', strength: 0.9, detail: { top5: -0.5, top10: -0.4, cvd30: -1, cvd60: -2, cvd120: -3 } }) };
  const bot = createConfluenceFlowBot({ store, crypto: cryptoStub(s), orderFlow, loadCfg: async () => cfgFor(), shadowStore, now: () => s.nowMs, log: () => {} });
  const r = await bot.scan();
  assert.deepEqual(r.entered, []);
  const open = await store.openTrades('BTCUSDT');
  assert.equal(open.length, 0);
  const shadows = await shadowStore.openShadows('confluence_flow');
  assert.equal(shadows.length, 1);
  assert.match(shadows[0].skip_reason, /order flow disagrees/);
  const samples = await store.flowSamplesSince('1970-01-01');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].took_trade, false);
  assert.equal(samples[0].flow_direction, 'sell');
});

test('max 6 trades/day/bot (Bot B, own cap): refuses a 7th entry once today already holds 6', async () => {
  const s = scene();
  const store = createMemoryConfluenceFlowStore();
  for (let i = 0; i < 6; i++) {
    await store.insertTrade({ symbol: 'BTCUSDT', trade_date: '2026-11-18', status: 'closed', direction: 'LONG', trigger_t: i + 1, entry_price: 100, entry_time: new Date().toISOString(), sl_price: 99, target_price: 102, qty: 1, basis: 'x' });
  }
  const greedyCrypto = { async candles() { throw new Error('must not be called once the daily cap is reached'); }, async hourly() { return []; }, usdtInr: async () => ({ rate: 88 }) };
  const bot = createConfluenceFlowBot({ store, crypto: greedyCrypto, orderFlow: { read: async () => { throw new Error('must not be called either'); } }, loadCfg: async () => cfgFor(), shadowStore: null, now: () => Date.parse('2026-11-18T10:00:00Z'), log: () => {} });
  const r = await bot.scan();
  assert.deepEqual(r.entered, []);
  assert.match(r.reason, /max 6 trades\/day reached/);
});
