'use strict';
// CC2 demo bots (research_usdinr_trend / research_btc_momentum / research_nifty200_52whigh,
// docs/RESEARCH-STRATEGIES-REPORT.md): rebalance idempotency, pnl math, and the one-time
// "I am live now" Telegram message never repeating. Every expected number below is hand-worked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryResearchStore } = require('../src/paper/lib/researchStore');
const { announceLiveOnce } = require('../src/paper/lib/liveAnnounce');

function fakeYahoo({ closes, live }) {
  return {
    dailyCloses: async () => closes,
    livePrice: async () => live,
  };
}

test('research_usdinr_trend: 12m return > 0 opens LONG; a second scan in the same month is a no-op', async () => {
  const { runRebalanceForTest } = require('../src/paper/bots/research_usdinr_trend/register');
  const store = createMemoryResearchStore();
  // 13 months of closes, last/first = 83/80 - 1 = +3.75% (>0 -> LONG)
  const closes = [];
  for (let m = 0; m < 13; m += 1) closes.push({ date: `2025-${String(m + 1).padStart(2, '0')}-28`, close: 80 + m / 4 });
  const yahoo = fakeYahoo({ closes, live: 83.3 });
  const now = () => Date.UTC(2026, 0, 15); // 2026-01, a month after the last close
  const r1 = await runRebalanceForTest({ store, yahoo, log: () => {}, now });
  assert.equal(r1.opened, 'LONG');
  const open = await store.allOpenTrades();
  assert.equal(open.length, 1);
  assert.equal(open[0].direction, 'LONG');
  assert.equal(open[0].rebalance_period, '2026-01');

  const r2 = await runRebalanceForTest({ store, yahoo, log: () => {}, now });
  assert.ok(r2.skipped, 'second scan in the same month must not open a second position');
  assert.equal((await store.allOpenTrades()).length, 1);
});

test('research_usdinr_trend: next month, the old LONG is closed with the right pnl before a new signal opens', async () => {
  const { runRebalanceForTest } = require('../src/paper/bots/research_usdinr_trend/register');
  const store = createMemoryResearchStore();
  await store.insertTrade({
    symbol: 'USDINR', direction: 'LONG', rebalance_period: '2026-01', entry_price: 80,
    entry_time: '2026-01-15T00:00:00.000Z', qty: 1250, basis: 'test fixture',
  });
  const closes = [];
  for (let m = 0; m < 13; m += 1) closes.push({ date: `2025-${String(m + 1).padStart(2, '0')}-28`, close: 80 });
  const yahoo = fakeYahoo({ closes, live: 82 }); // flat 12m signal (ret12m === 0) -> no new position opened
  const now = () => Date.UTC(2026, 1, 15); // February
  const r = await runRebalanceForTest({ store, yahoo, log: () => {}, now });
  assert.ok(r.skipped);
  const closed = await store.closedTrades();
  assert.equal(closed.length, 1);
  // LONG: (82 - 80) * 1250 = 2500
  assert.equal(closed[0].pnl_inr, 2500);
  assert.equal((await store.allOpenTrades()).length, 0);
});

test('research_btc_momentum: positive 7d return opens LONG; non-positive stays in cash', async () => {
  const { runRebalanceForTest } = require('../src/paper/bots/research_btc_momentum/register');
  const store = createMemoryResearchStore();
  const closes = [];
  for (let d = 0; d < 8; d += 1) closes.push({ date: `2026-01-0${d + 1}`, close: 100 + d }); // 107/100-1 = +7%
  const yahoo = fakeYahoo({ closes, live: 108 });
  const now = () => Date.UTC(2026, 0, 12); // a Monday
  const r = await runRebalanceForTest({ store, yahoo, log: () => {}, now });
  assert.equal(r.opened, 'LONG');

  const store2 = createMemoryResearchStore();
  const flatCloses = closes.map((c) => ({ ...c, close: 100 })); // 0% 7d return -> cash
  const r2 = await runRebalanceForTest({ store: store2, yahoo: fakeYahoo({ closes: flatCloses, live: 100 }), log: () => {}, now });
  assert.ok(r2.skipped);
  assert.equal((await store2.allOpenTrades()).length, 0);
});

test('announceLiveOnce: sends the exact one-time message, never a second time, and logs (not throws) on Telegram failure', async () => {
  const store = createMemoryResearchStore();
  const sent = [];
  const okAxios = { post: async (url, body) => { sent.push(body); return {}; } };
  const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' };
  await announceLiveOnce({ store, axios: okAxios, env, log: () => {}, botName: 'research_btc_momentum', strategyLine: 'weekly BTC momentum', market: 'BTC', capitalInr: 100000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Hello, I am research_btc_momentum. Strategy: weekly BTC momentum. Market: BTC. Capital: Rs 1,00,000. I am live now.');

  await announceLiveOnce({ store, axios: okAxios, env, log: () => {}, botName: 'research_btc_momentum', strategyLine: 'weekly BTC momentum', market: 'BTC', capitalInr: 100000 });
  assert.equal(sent.length, 1, 'must never send the hello message twice');

  const store2 = createMemoryResearchStore();
  const failingAxios = { post: async () => { throw new Error('network down'); } };
  const logs = [];
  await announceLiveOnce({ store: store2, axios: failingAxios, env, log: (m) => logs.push(m), botName: 'x', strategyLine: 's', market: 'm', capitalInr: 1 });
  assert.ok(logs.some((l) => l.includes('send failed')));
  assert.equal(await store2.getMeta('live_announced'), null, 'a failed send must not be marked as sent, so it retries next start');
});
