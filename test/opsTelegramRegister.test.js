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

// --- Task Group C: coverage extended to every bot that lacked it -------------------------------------

test('NSE main bot ("nse" market) now gets an entry alert too, in native rupees (no FX line, no "rate n/a")', async () => {
  const sent = [];
  const store = createMemoryStore();
  // option premium in Rs, qty = lot size; this is exactly the shape paperbot/bot.js's nseScan() stores.
  await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: '2026-11-14', status: 'open', direction: 'CALL', entry_price: 101, target_price: 106, sl_price: 97, qty: 500, basis: 'order block retest', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /RELIANCE \[nse\]/);
  assert.match(sent[0], /Target: 106 \(fixed %\)/); // NSE exits are not level-based yet (docs/decisions/CC2.md item 4) - honest fallback label
  assert.match(sent[0], /Stop: 97 \(fixed %\)/);
  // target: |106-101|*500 = 2500, no round-trip cost modelled for NSE (paperbot/bot.js has none) -> Rs 2,500
  assert.match(sent[0], /Target lagne par ≈ \+₹2,500/);
  // stop: |97-101|*500 = 2000 -> Rs 2,000
  assert.match(sent[0], /Stop lagne par ≈ -₹2,000/);
  assert.doesNotMatch(sent[0], /rate n\/a|\$/); // native rupees - never shown as a USD/FX estimate
});

test('nse_scalp market also gets an entry alert (same shared table, same native-rupee convention)', async () => {
  const sent = [];
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse_scalp', symbol: 'TCS', trade_date: '2026-11-14', status: 'open', direction: 'PUT', entry_price: 50, target_price: 55, sl_price: 47, qty: 100, basis: 'b', patterns: [] });
  const { check } = register({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(), state: { store }, axios: fakeAxios(sent), cron: cronStub() });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /TCS \[nse_scalp\]/);
});

function fakeOwnTableStore(rows) {
  return { listTrades: async (limit) => rows.slice(0, limit) };
}

test('exhaustion_only (own table, no shared paper_trades row) now gets entry + exit alerts via ctx.exhaustionMemoryStore', async () => {
  const sent = [];
  const rows = [{ id: 1, symbol: 'BTCUSDT', direction: 'LONG', status: 'open', entry_price: 100, target_price: 102.897, sl_price: 99.38, target_type: 'swing high 15m', stop_type: 'pattern low + 1xATR15m', qty: 2, rr: 1.72, basis: 'exhaustion reversal' }];
  const { check } = register({
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(),
    state: { store: createMemoryStore() }, axios: fakeAxios(sent), cron: cronStub(), exhaustionMemoryStore: fakeOwnTableStore(rows),
  });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /BTCUSDT \[exhaustion_only\]/);
  assert.match(sent[0], /Target: 102\.897 \(swing high 15m\)/);
  assert.match(sent[0], /Stop: 99\.38 \(pattern low \+ 1xATR15m\)/);

  rows[0].status = 'closed'; rows[0].exit_reason = 'target'; rows[0].pnl_inr = 500;
  await check();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /BTCUSDT \[exhaustion_only\] closed - TARGET hit/);
});

test('trend_smc (own table) now gets an entry alert via ctx.trendSmcMemoryStore', async () => {
  const sent = [];
  const rows = [{ id: 1, symbol: 'ETHUSDT', direction: 'SHORT', status: 'open', entry_price: 100, target_price: 90, sl_price: 103, target_type: 'prev week low', stop_type: 'order block + 1xATR15m', qty: 1, rr: 3.3, basis: 'order block retest, 15m trend down' }];
  const { check } = register({
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: () => {}, pool: fakePool(),
    state: { store: createMemoryStore() }, axios: fakeAxios(sent), cron: cronStub(), trendSmcMemoryStore: fakeOwnTableStore(rows),
  });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /🔴 SHORT ETHUSDT \[trend_smc\]/);
  assert.match(sent[0], /Target: 90 \(prev week low\)/);
});

test('exhaustion_only/trend_smc disabled or not yet registered: no store on ctx -> skipped, logged once, never a crash', async () => {
  const sent = []; const logs = [];
  const { check } = register({
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on' }, log: (m) => logs.push(m), pool: fakePool(),
    state: { store: createMemoryStore() }, axios: fakeAxios(sent), cron: cronStub(),
    // no exhaustionMemoryStore / trendSmcMemoryStore on ctx at all
  });
  await assert.doesNotReject(check());
  await assert.doesNotReject(check()); // second poll: still safe
  assert.equal(sent.length, 0);
  assert.equal(logs.filter((l) => /exhaustion_only has no store yet/.test(l)).length, 1); // logged once, not every 20s poll
  assert.equal(logs.filter((l) => /trend_smc has no store yet/.test(l)).length, 1);
});

test('TELEGRAM_BOTS also filters the own-table bots by name', async () => {
  const sent = [];
  const rows = [{ id: 1, symbol: 'BTCUSDT', direction: 'LONG', status: 'open', entry_price: 100, target_price: 110, sl_price: 95, qty: 1, basis: 'b' }];
  const { check } = register({
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', TELEGRAM_TRADE_ALERTS: 'on', TELEGRAM_BOTS: 'exhaustion_only' }, log: () => {}, pool: fakePool(),
    state: { store: createMemoryStore() }, axios: fakeAxios(sent), cron: cronStub(),
    exhaustionMemoryStore: fakeOwnTableStore(rows), trendSmcMemoryStore: fakeOwnTableStore(rows),
  });
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[exhaustion_only\]/);
});
