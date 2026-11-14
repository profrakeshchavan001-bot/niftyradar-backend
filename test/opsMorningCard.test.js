'use strict';
// Round 3 item 3: morning card (src/paper/ops/morningCard.js). Every number hand-checked in the comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMorningCard, sinceYesterday6pmIst } = require('../src/paper/ops/morningCard');
const { createMemoryStore } = require('../paperbot/store');

// Sat 14 Nov 2026 09:30 IST = Date.UTC(2026,10,14,4,0). Yesterday 18:00 IST = Fri 13 Nov 2026 18:00 IST
// = Date.UTC(2026,10,13,12,30).
const NOW = Date.UTC(2026, 10, 14, 4, 0);
const BOUNDARY = Date.UTC(2026, 10, 13, 12, 30);

test('sinceYesterday6pmIst: hand-checked boundary', () => {
  assert.equal(sinceYesterday6pmIst(NOW), BOUNDARY);
});

test('a trade before the boundary is excluded, one after is included (hand-checked net INR)', async () => {
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse', symbol: 'OLD', trade_date: '2026-11-13', status: 'closed', pnl_inr: 999, entry_time: new Date(BOUNDARY - 60000).toISOString(), entry_price: 1, basis: 'b', patterns: [] });
  await store.insertTrade({ market: 'nse', symbol: 'NEW', trade_date: '2026-11-13', status: 'closed', pnl_inr: 1500, entry_time: new Date(BOUNDARY + 60000).toISOString(), entry_price: 1, basis: 'b', patterns: [] });
  await store.insertTrade({ market: 'nse', symbol: 'LOSS', trade_date: '2026-11-14', status: 'closed', pnl_inr: -400, entry_time: new Date(NOW).toISOString(), entry_price: 1, basis: 'b', patterns: [] });
  const card = await buildMorningCard({ store, now: NOW });
  const nse = card.perBot.find((b) => b.bot === 'nse');
  assert.equal(nse.trades, 2); // OLD excluded
  assert.equal(nse.wins, 1);
  assert.equal(nse.losses, 1);
  assert.equal(nse.netInr, 1100); // 1500 - 400
});

test('skips since yesterday grouped, top 3 reasons by count (hand-checked)', async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i++) await store.insertSkip({ market: 'crypto', symbol: 'BTCUSDT', skip_date: '2026-11-14', reason: 'RSI N > N' });
  for (let i = 0; i < 3; i++) await store.insertSkip({ market: 'crypto', symbol: 'ETHUSDT', skip_date: '2026-11-13', reason: 'news filter' });
  await store.insertSkip({ market: 'crypto', symbol: 'SOLUSDT', skip_date: '2026-11-12', reason: 'too old' }); // before yesterday: excluded
  const card = await buildMorningCard({ store, now: NOW });
  const crypto = card.perBot.find((b) => b.bot === 'crypto');
  assert.equal(crypto.skips, 8); // 5 + 3, not the 1 from 11-12
  assert.deepEqual(crypto.topSkipReasons, [{ reason: 'RSI N > N', count: 5 }, { reason: 'news filter', count: 3 }]);
});

test('a bot with nothing since the boundary is left out entirely (never a fake zero row)', async () => {
  const card = await buildMorningCard({ store: createMemoryStore(), now: NOW });
  assert.deepEqual(card.perBot, []);
});

test('only open trades: wins/losses both 0, no net INR counted (open P&L is not realized)', async () => {
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse_scalp', symbol: 'X', trade_date: '2026-11-14', status: 'open', entry_time: new Date(NOW).toISOString(), entry_price: 1, basis: 'b', patterns: [] });
  const card = await buildMorningCard({ store, now: NOW });
  const row = card.perBot.find((b) => b.bot === 'nse_scalp');
  assert.deepEqual([row.trades, row.open, row.wins, row.losses, row.netInr], [1, 1, 0, 0, 0]);
});
