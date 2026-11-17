'use strict';
// intraday-MIRROR (docs/BOTS.md "Mirror bots", src/paper/bots/intraday_mirror/register.js): mirrors ONLY
// the main crypto bot's 'crypto' market inside the SHARED paper_trades table (ctx.store), the same way
// src/paper/bots/scalp_mirror/register.js mirrors 'crypto_scalp'/'crypto_wide_scalp'. Exercises the real
// register.js wiring (route, cron tick, env switch), not just the pure mirror helpers (those are covered,
// with the generic createMirrorBot()/settle() contract, by test/paperMirror.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const register = require('../src/paper/bots/intraday_mirror/register');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { createMemoryStore } = require('../paperbot/store');
const { settle } = require('../paperbot/engine');

function fakeApp() { const routes = {}; return { routes, get: (p, h) => { routes[p] = h; } }; }
function fakeCron() { const jobs = {}; return { jobs, schedule: (expr, fn) => { jobs[expr] = fn; } }; }
async function call(app, p, { query = {}, headers = {} } = {}) {
  const out = { status: 200, headers: {}, body: null, type: null };
  const res = {
    set(h, v) { if (typeof h === 'object') Object.assign(out.headers, h); else out.headers[h] = v; return this; },
    status(n) { out.status = n; return this; }, type(t) { out.type = t; return this; },
    send(b) { out.body = b; return this; }, json(b) { out.type = 'json'; out.body = JSON.stringify(b); return this; },
  };
  await app.routes[p]({ query, get: (h) => headers[h.toLowerCase()] }, res);
  return out;
}

function baseCtx(overrides = {}) {
  const app = fakeApp();
  const cron = fakeCron();
  const store = createMemoryStore();
  return { app, cron, store, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, guarded: (name, fn) => fn, tz: 'Asia/Kolkata', pool: null, ...overrides };
}

test('plugin: intraday_mirror is auto-discovered by src/paper/pluginLoader.js under bots/', () => {
  const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'intraday_mirror'));
});

test('default on: with PAPER_BOT_ENABLED unset, the mirror registers (follows PAPER_BOT_ENABLED default true)', async () => {
  const ctx = baseCtx();
  await register.register(ctx);
  assert.ok(ctx.intradayMirrorMemoryStore, 'ctx.intradayMirrorMemoryStore must be set so telegram-alerts/leaderboard can read it');
  assert.ok(ctx.cron.jobs['33 * * * * *'], 'the sync tick must be scheduled on its own, unused second-offset');
});

test('switch follows PAPER_BOT_ENABLED when PAPER_INTRADAY_MIRROR_ENABLED is unset', async () => {
  const ctx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', PAPER_BOT_ENABLED: 'false' } });
  await register.register(ctx);
  assert.equal(ctx.cron.jobs['33 * * * * *'], undefined, 'disabled: no cron tick scheduled');
});

test('PAPER_INTRADAY_MIRROR_ENABLED overrides PAPER_BOT_ENABLED either way', async () => {
  const onCtx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', PAPER_BOT_ENABLED: 'false', PAPER_INTRADAY_MIRROR_ENABLED: 'true' } });
  await register.register(onCtx);
  assert.ok(onCtx.cron.jobs['33 * * * * *'], 'explicit true must turn it on even if the main bot flag is false');

  const offCtx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', PAPER_INTRADAY_MIRROR_ENABLED: 'false' } });
  await register.register(offCtx);
  assert.equal(offCtx.cron.jobs['33 * * * * *'], undefined, 'explicit false must turn it off even if the main bot flag is on');
});

test('sync: mirrors ONLY the crypto market, never nse/crypto_scalp/crypto_wide_scalp, with real settle() math', async () => {
  const ctx = baseCtx();
  await ctx.store.insertTrade({ market: 'crypto', symbol: 'ETHUSDT', trade_date: '2026-11-15', status: 'open', direction: 'LONG', entry_price: 100, entry_time: '2026-11-15T05:00:00Z', qty: 2, sl_price: 95, target_price: 110, trigger_t: 1 });
  await ctx.store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: '2026-11-15', status: 'open', direction: 'CALL', entry_price: 50, entry_time: '2026-11-15T05:00:00Z', qty: 250, sl_price: 45, target_price: 55, trigger_t: 2 });
  await ctx.store.insertTrade({ market: 'crypto_scalp', symbol: 'BTCUSDT', trade_date: '2026-11-15', status: 'open', direction: 'LONG', entry_price: 100, entry_time: '2026-11-15T05:00:00Z', qty: 1, sl_price: 99, target_price: 101, trigger_t: 3 });
  // register() itself fires one startup sync, but fire-and-forget (not awaited by register() - see its
  // own comment), so we explicitly await one full sync pass ourselves here (idempotent either way) before
  // checking state, rather than racing the startup call's own timing.
  await register.register(ctx);
  await ctx.cron.jobs['33 * * * * *']();

  const open = await ctx.intradayMirrorMemoryStore.allOpenTrades();
  assert.equal(open.length, 1, 'only the ONE crypto-market trade is mirrored, not nse or crypto_scalp');
  assert.equal(open[0].symbol, 'ETHUSDT');
  assert.equal(open[0].direction, 'SHORT'); // opposite of the original's LONG

  // close the original crypto trade at its target (a win for the LONG, price 100 -> 110, qty 2, fx 88):
  // gross = (110-100)*2*1 = 20 USDT; pnl_inr = 20*88 = 1760 (matches cryptoMonitor's own inline formula)
  const originalOpen = await ctx.store.openTrades('crypto');
  await ctx.store.updateTrade(originalOpen[0].id, { status: 'closed', exit_price: 110, exit_time: '2026-11-15T06:00:00Z', exit_reason: 'target', fx_rate: 88 });
  const r2 = await ctx.cron.jobs['33 * * * * *']();
  assert.deepEqual(r2, { opened: 0, closed: 1 });
  const closed = await ctx.intradayMirrorMemoryStore.closedTrades();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exit_reason, 'stop'); // original's target -> mirror's stop
  // the mirror is SHORT and price rose to 110 (the original's target): a loss for the mirror, via settle()
  // hand check: gross = (110-100)*2*(-1) = -20 USDT; pnl_inr = -20*88 = -1760
  assert.equal(closed[0].net_pnl_usdt, -20);
  assert.equal(closed[0].pnl_inr, -1760);
  // confirm this matches calling settle() directly on the mirror's own (already-inverted) row
  const direct = settle({ trade: { direction: 'SHORT', entry_price: 100, qty: 2 }, exitPrice: 110, cfg: {}, fxRate: 88 });
  assert.equal(closed[0].net_pnl_usdt, direct.net_pnl_usdt);
  assert.equal(closed[0].pnl_inr, direct.pnl_inr);

  // the original's own row is completely untouched beyond what we closed it with by hand above
  const originalClosed = await ctx.store.closedTrades('crypto');
  assert.equal(originalClosed.length, 1);
  assert.equal(originalClosed[0].direction, 'LONG');
});

test('report route: behind the secret, empty shape before any trade, never a crash', async () => {
  const ctx = baseCtx();
  await register.register(ctx);
  assert.equal((await call(ctx.app, '/api/paper/intraday-mirror-report')).status, 401);
  assert.equal((await call(ctx.app, '/api/paper/intraday-mirror-report', { query: { key: 'wrong' } })).status, 401);
  const res = await call(ctx.app, '/api/paper/intraday-mirror-report', { query: { key: 's3cret' } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.mirrorOf, 'intraday');
  assert.equal(body.summary.trades, 0);
});

test('report route: no PAPER_ADMIN_SECRET/RENEW_SECRET configured -> 503', async () => {
  const ctx = baseCtx({ env: {} });
  await register.register(ctx);
  assert.equal((await call(ctx.app, '/api/paper/intraday-mirror-report')).status, 503);
});
