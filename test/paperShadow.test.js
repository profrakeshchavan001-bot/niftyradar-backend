'use strict';
// Shadow tracking (docs/BOTS.md): a skip whose plan reached the reward/risk gate (full entry/stop/target) is followed on paper to its
// would-be stop or target, in its own table, never counted as a trade. Shared by scalp, scalp_wide and exhaustion_only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryShadowStore } = require('../src/paper/shadow/store');
const { analyse, analyseWide } = require('../src/paper/scalp/engine');
const { SCALP_DEFAULTS, SCALP_WIDE_DEFAULTS } = require('../src/paper/scalp/config');
const { createScalpBot } = require('../src/paper/scalp/bot');
const { createMemoryStore } = require('../paperbot/store');
const { scene, sceneWide, MIN } = require('./scalpFixtures');

// ---------- the store ----------
test('store: the same bot/symbol/candle logged twice is still ONE shadow; different bots/candles are separate', async () => {
  const store = createMemoryShadowStore();
  const row = { bot: 'scalp', symbol: 'BTCUSDT', setup_date: '2026-11-15', trigger_t: 1, direction: 'LONG', entry_price: 100, sl_price: 99, target_price: 102, skip_reason: 'x' };
  const id1 = await store.insertShadow(row);
  const id2 = await store.insertShadow(row); // same bot+symbol+trigger_t
  assert.ok(id1 != null); assert.equal(id2, null);
  await store.insertShadow({ ...row, bot: 'scalp_wide' });
  await store.insertShadow({ ...row, trigger_t: 2 });
  assert.equal((await store.openShadows('scalp')).length, 2);
  assert.equal((await store.openShadows('scalp_wide')).length, 1);
});

test('store: resolveShadow moves it out of openShadows and into shadowsSince', async () => {
  const store = createMemoryShadowStore();
  const id = await store.insertShadow({ bot: 'scalp', symbol: 'BTCUSDT', setup_date: '2026-11-15', trigger_t: 1, direction: 'LONG', entry_price: 100, sl_price: 99, target_price: 102, skip_reason: 'x' });
  await store.resolveShadow(id, { resolved_reason: 'target', resolved_price: 102, resolved_time: new Date().toISOString() });
  assert.equal((await store.openShadows('scalp')).length, 0);
  const since = await store.shadowsSince('scalp', '1970-01-01');
  assert.equal(since[0].status, 'resolved'); assert.equal(since[0].resolved_reason, 'target');
});

// ---------- engine: the skip itself carries a full would-be plan ----------
// Reuses round-1's hand-verified scalp numbers: entry 100.44, stop 100.333929, target 100.9422, skipped at the default 1.0 min_rr (rr 0.8).
test('scalp engine: a reward/risk skip carries entry_price/sl_price/target_price/direction/trigger_t - enough to shadow', () => {
  const a = analyse({ ...scene(), cfg: SCALP_DEFAULTS });
  assert.equal(a.ok, false);
  assert.deepEqual(a.extra.shadowPlan, { direction: 'LONG', entry_price: 100.44, sl_price: 100.333929, target_price: 100.9422, trigger_t: scene().last.t });
});

test('scalp engine: a skip with no plan at all ("not enough candles") carries no shadowPlan - nothing to follow', () => {
  const s = scene();
  const a = analyse({ ...s, c1raw: s.c1raw.slice(-10), cfg: SCALP_DEFAULTS });
  assert.equal(a.ok, false); assert.equal(a.extra, undefined);
});

// scalp_wide: entry 100.44, stop 100.333929, target 102.025 (round-1 numbers), rr 4.02 clears the default min_rr 1.0, so raise it to force a skip
test('scalp_wide engine: same shape, raised min_rr forces a skip that still carries a full shadowPlan', () => {
  const a = analyseWide({ ...sceneWide(), cfg: { ...SCALP_WIDE_DEFAULTS, min_rr: 10, min_candles_15m: 10 } });
  assert.equal(a.ok, false);
  assert.deepEqual(a.extra.shadowPlan, { direction: 'LONG', entry_price: 100.44, sl_price: 100.333929, target_price: 102.025, trigger_t: sceneWide().last.t });
});

// ---------- the bot: wiring end to end ----------
function harness(over = {}) {
  const s = scene();
  const store = createMemoryStore();
  const shadowStore = createMemoryShadowStore();
  const logs = [];
  const clock = { t: s.now };
  const crypto = { candles: async () => s.c5raw, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const source1m = { candles1m: async (sym) => (over.c1 ? over.c1(clock.t) : s.c1raw) };
  const bot = createScalpBot({ store, crypto, source1m, shadowStore, now: () => clock.t, log: (m) => logs.push(m) });
  return { s, store, shadowStore, logs, clock, bot };
}

test('bot: the tight scalp scan records a shadow for every skipped reward/risk setup (default costs skip all 3 coins)', async () => {
  const h = harness();
  await h.bot.cryptoScalpScan();
  const rows = h.shadowStore._db.rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.bot === 'scalp' && r.status === 'open' && r.direction === 'LONG' && r.entry_price === 100.44 && r.target_price === 100.9422));
  // a second scan of the SAME candle does not duplicate the shadow (insertShadow dedupes on bot+symbol+trigger_t)
  await h.bot.cryptoScalpScan();
  assert.equal(h.shadowStore._db.rows.length, 3);
});

test('bot: the monitor resolves an open shadow to its target, candle-accurate, without ever touching paper_trades', async () => {
  const h = harness();
  await h.bot.cryptoScalpScan();
  const shadowCandles = [...h.s.c1raw, { t: h.s.last.t + MIN, o: 100.44, h: 100.99, l: 100.40, c: 100.9, v: 1 }]; // clears the 100.9422 target
  const h2 = harness({ c1: () => shadowCandles });
  h2.shadowStore._db.rows.push(...h.shadowStore._db.rows); // reuse the shadows already recorded above
  h2.clock.t += 130000;
  await h2.bot.cryptoScalpMonitor();
  const row = h2.shadowStore._db.rows[0];
  assert.equal(row.status, 'resolved'); assert.equal(row.resolved_reason, 'target'); assert.equal(row.resolved_price, 100.9422);
  assert.equal(h2.store._db.trades.length, 0, 'a shadow is never counted as a trade');
});

// ---------- schema (verified against a local Postgres by hand during this session; see docs/decisions/CC3.md) ----------
test('schema: shadow_setups has the unique (bot, symbol, trigger_t) index that makes insertShadow idempotent on Postgres too', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'paper', 'shadow', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS shadow_setups_once_idx ON shadow_setups \(bot, symbol, trigger_t\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS shadow_setups/);
});
