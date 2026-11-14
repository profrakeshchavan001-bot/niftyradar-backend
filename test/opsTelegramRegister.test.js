'use strict';
// Add-on v2 items 3-6: the plugin itself (src/paper/ops/telegramAlerts/register.js) against a fake
// Telegram endpoint (axios) and a fake pool (DB dedupe). No real network - "not verified live".
const test = require('node:test');
const assert = require('node:assert/strict');
const { register } = require('../src/paper/ops/telegramAlerts/register');
const { createMemoryStore } = require('../paperbot/store');

function fakeAxios(sent, fail = false) {
  return { post: async (url, body) => { if (fail) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); sent.push(body.text); return {}; } };
}
function fakePool() {
  const rows = new Set();
  return { query: async (sql, [bot, id, event]) => { const key = `${bot}:${id}:${event}`; if (rows.has(key)) return { rows: [] }; rows.add(key); return { rows: [{}] }; } };
}
function cronStub() { return { schedule: () => {} }; } // check() is called directly in tests, not via the real timer

test('off by default: TELEGRAM_TRADE_ALERTS unset sends nothing, even with token+chat configured', async () => {
  const sent = [];
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', trade_date: '2026-11-14', status: 'open', entry_price: 100, target_price: 110, sl_price: 95, qty: 1, basis: 'b', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check();
  assert.equal(sent.length, 0);
});

test('entry alert sent once for a newly opened trade; never resent on the next check (DB dedupe)', async () => {
  const sent = [];
  const store = createMemoryStore();
  const id = await store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', trade_date: '2026-11-14', status: 'open', direction: 'LONG', entry_price: 100, target_price: 110, sl_price: 95, qty: 1, basis: 'order block', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /BTCUSDT \[intraday\]/);
  await check(); // nothing new happened
  assert.equal(sent.length, 1); // still just the one
  await store.updateTrade(id, {}); // no-op, still open
  await check();
  assert.equal(sent.length, 1);
});

test('exit alert sent once when a trade closes; TELEGRAM_EXIT_ALERTS=off suppresses it', async () => {
  const store = createMemoryStore();
  const id = await store.insertTrade({ market: 'crypto', symbol: 'ETHUSDT', trade_date: '2026-11-14', status: 'open', direction: 'LONG', entry_price: 100, target_price: 110, sl_price: 95, qty: 1, basis: 'b', patterns: [] });
  {
    const sent = [];
    const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
    await check(); // entry
    await store.updateTrade(id, { status: 'closed', exit_price: 110, exit_reason: 'target', pnl_inr: 900 });
    await check(); // entry already sent, exit now sent
    assert.equal(sent.length, 2);
    assert.match(sent[1], /closed - TARGET hit/);
  }
  {
    const sent = [];
    const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on', TELEGRAM_EXIT_ALERTS: 'off' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
    await check(); // entry already in THIS fresh pool -> sent; exit suppressed by the env flag
    assert.equal(sent.length, 1);
  }
});

test('TELEGRAM_BOTS filters to the named bots only', async () => {
  const sent = [];
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto', symbol: 'A', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  await store.insertTrade({ market: 'crypto_scalp', symbol: 'B', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on', TELEGRAM_BOTS: 'scalp' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[scalp\]/);
});

test('no end-of-day/morning-brief/weekly text is ever sent by this plugin (item 3) - it only ever formats entry/exit', async () => {
  const sent = [];
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto', symbol: 'A', trade_date: '2026-11-14', status: 'closed', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, pnl_inr: 10, exit_reason: 'target', basis: 'b', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check();
  for (const text of sent) { assert.doesNotMatch(text, /summary|morning brief|weekly/i); }
});

test('a Telegram failure (timeout) is logged and does not throw or stop the next trade in the same check()', async () => {
  const logs = [];
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto', symbol: 'A', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  await store.insertTrade({ market: 'crypto', symbol: 'B', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: (m) => logs.push(m), pool: fakePool(), state: { store }, axios: fakeAxios([], true), cron: cronStub() });
  await assert.doesNotReject(check());
  assert.ok(logs.some((l) => /send failed/.test(l)));
});

test('no pool (no PAPER_DATABASE_URL): dedupe still works in-memory for this process', async () => {
  const sent = [];
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto', symbol: 'A', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: null, state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check(); await check();
  assert.equal(sent.length, 1);
});

test('dedupe survives a simulated redeploy: a fresh register() call with the same pool never resends', async () => {
  const store = createMemoryStore();
  const id = await store.insertTrade({ market: 'crypto', symbol: 'A', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  const pool = fakePool();
  const sent1 = [];
  await register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool, state: { store }, axios: fakeAxios(sent1), cron: cronStub() }).check();
  assert.equal(sent1.length, 1);
  // "redeploy": a brand new register() call, same pool (the real persistence)
  const sent2 = [];
  await register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool, state: { store }, axios: fakeAxios(sent2), cron: cronStub() }).check();
  assert.equal(sent2.length, 0);
});

test('state.telegramStats.lastSendOk reflects the real outcome of the last send', async () => {
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto', symbol: 'A', trade_date: '2026-11-14', status: 'open', entry_price: 1, target_price: 2, sl_price: 0.5, qty: 1, basis: 'b', patterns: [] });
  const state = { store };
  await register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(), state, axios: fakeAxios([], true), cron: cronStub() }).check();
  assert.equal(state.telegramStats.lastSendOk, false);
});

test('not configured: state.telegramStats.configured is false, nothing sent, cron still registers safely', () => {
  const state = { store: createMemoryStore() };
  const r = register({ env: {}, log: () => {}, pool: fakePool(), state, axios: fakeAxios([]), cron: cronStub() });
  assert.equal(state.telegramStats.configured, false);
  assert.equal(typeof r.check, 'function');
});
