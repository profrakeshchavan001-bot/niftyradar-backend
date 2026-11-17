'use strict';
// scalp_wide-REVERSE (src/paper/bots/scalp_wide_reverse/register.js): same convention as
// intraday-REVERSE (test/paperIntradayReverse.test.js), but for the scalp_wide market only - plain scalp
// has no REVERSE bot, as asked.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const register = require('../src/paper/bots/scalp_wide_reverse/register');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { createMemoryStore } = require('../paperbot/store');

function fakeApp() { const routes = {}; return { routes, get: (p, h) => { routes[p] = h; } }; }
function fakeCron() { const jobs = {}; return { jobs, schedule: (expr, fn) => { jobs[expr] = fn; } }; }

function baseCtx(overrides = {}) {
  const app = fakeApp();
  const cron = fakeCron();
  const store = createMemoryStore();
  const cachedCrypto = { candles: async () => [] };
  return { app, cron, store, cachedCrypto, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, guarded: (name, fn) => fn, tz: 'Asia/Kolkata', pool: null, ...overrides };
}

test('plugin: scalp_wide_reverse is auto-discovered under bots/', () => {
  const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'scalp_wide_reverse'));
});

test('default on: registers, schedules its own sync/monitor on unused second-offsets', async () => {
  const ctx = baseCtx();
  await register.register(ctx);
  assert.ok(ctx.scalpWideReverseMemoryStore);
  assert.ok(ctx.cron.jobs['24 */5 * * * *'], 'sync tick scheduled');
  assert.ok(ctx.cron.jobs['54 * * * * *'], 'monitor tick scheduled');
});

test('switch follows PAPER_SCALP_ENABLED when PAPER_SCALP_WIDE_REVERSE_ENABLED is unset', async () => {
  const ctx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', PAPER_SCALP_ENABLED: 'false' } });
  await register.register(ctx);
  assert.equal(ctx.cron.jobs['24 */5 * * * *'], undefined);
});

test('sync: reverses ONLY crypto_wide_scalp (never crypto_scalp/crypto), own 1x/2x levels, same direction as the mirror', async () => {
  const ctx = baseCtx();
  await ctx.store.insertTrade({ market: 'crypto_wide_scalp', symbol: 'SOLUSDT', trade_date: '2026-11-15', status: 'open', direction: 'SHORT', entry_price: 50, entry_time: '2026-11-15T05:00:00Z', qty: 10, sl_price: 51, target_price: 48, trigger_t: 1 });
  await ctx.store.insertTrade({ market: 'crypto_scalp', symbol: 'BTCUSDT', trade_date: '2026-11-15', status: 'open', direction: 'LONG', entry_price: 100, entry_time: '2026-11-15T05:00:00Z', qty: 1, sl_price: 99, target_price: 101, trigger_t: 3 });
  await register.register(ctx);
  await ctx.cron.jobs['24 */5 * * * *']();

  const open = await ctx.scalpWideReverseMemoryStore.allOpenTrades();
  assert.equal(open.length, 1, 'only the scalp_wide trade gets a reverse, not crypto_scalp');
  assert.equal(open[0].symbol, 'SOLUSDT');
  assert.equal(open[0].direction, 'LONG'); // same as the mirror, opposite of the original's SHORT
  assert.equal(open[0].sl_price, 49); // 1x the original stop distance (1), losing side of a LONG
  assert.equal(open[0].target_price, 52); // 2x that distance, winning side
});
