'use strict';
// intraday-REVERSE (src/paper/bots/intraday_reverse/register.js): mirrors ONLY the main crypto bot's
// 'crypto' market, same wiring convention as intraday_mirror (test/paperIntradayMirror.test.js), but with
// its OWN levels/monitor instead of a patch on the original's close.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const register = require('../src/paper/bots/intraday_reverse/register');
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

test('plugin: intraday_reverse is auto-discovered by src/paper/pluginLoader.js under bots/', () => {
  const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'intraday_reverse'));
});

test('default on: registers, schedules its own sync/monitor ticks on unused second-offsets', async () => {
  const ctx = baseCtx();
  await register.register(ctx);
  assert.ok(ctx.intradayReverseMemoryStore, 'ctx.intradayReverseMemoryStore must be set so telegram-alerts/the daily report can read it');
  assert.ok(ctx.cron.jobs['17 * * * * *'], 'sync tick scheduled');
  assert.ok(ctx.cron.jobs['47 * * * * *'], 'monitor tick scheduled');
});

test('switch follows PAPER_BOT_ENABLED when PAPER_INTRADAY_REVERSE_ENABLED is unset; its own var overrides either way', async () => {
  const offCtx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', PAPER_BOT_ENABLED: 'false' } });
  await register.register(offCtx);
  assert.equal(offCtx.cron.jobs['17 * * * * *'], undefined);

  const onCtx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', PAPER_BOT_ENABLED: 'false', PAPER_INTRADAY_REVERSE_ENABLED: 'true' } });
  await register.register(onCtx);
  assert.ok(onCtx.cron.jobs['17 * * * * *']);
});

test('sync: reverses ONLY the crypto market (never nse/crypto_scalp), same direction as the mirror, own 1x/2x levels', async () => {
  const ctx = baseCtx();
  await ctx.store.insertTrade({ market: 'crypto', symbol: 'ETHUSDT', trade_date: '2026-11-15', status: 'open', direction: 'LONG', entry_price: 100, entry_time: '2026-11-15T05:00:00Z', qty: 2, sl_price: 95, target_price: 110, trigger_t: 1 });
  await ctx.store.insertTrade({ market: 'crypto_scalp', symbol: 'BTCUSDT', trade_date: '2026-11-15', status: 'open', direction: 'LONG', entry_price: 100, entry_time: '2026-11-15T05:00:00Z', qty: 1, sl_price: 99, target_price: 101, trigger_t: 3 });
  await register.register(ctx);
  await ctx.cron.jobs['17 * * * * *']();

  const open = await ctx.intradayReverseMemoryStore.allOpenTrades();
  assert.equal(open.length, 1, 'only the ONE crypto-market trade gets a reverse, not crypto_scalp');
  assert.equal(open[0].symbol, 'ETHUSDT');
  assert.equal(open[0].direction, 'SHORT'); // same as the mirror, opposite of the original's LONG
  assert.equal(open[0].sl_price, 105); // 1x the original stop distance (5), losing side of a SHORT
  assert.equal(open[0].target_price, 90); // 2x that distance, winning side
  assert.match(open[0].basis, /REVERSE of trade #/);
});

test('the full signal: original + MIRROR + REVERSE all alert through telegram-alerts for the SAME original trade', async () => {
  const mirrorRegister = require('../src/paper/bots/intraday_mirror/register');
  const alertsRegister = require('../src/paper/ops/telegramAlerts/register');

  const ctx = baseCtx({ env: { PAPER_ADMIN_SECRET: 's3cret', TELEGRAM_TRADE_ALERTS: 'on', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' } });
  ctx.state = { telegramStats: null, store: ctx.store };
  const sent = [];
  ctx.axios = { post: async (url, body) => { sent.push(body.text); return {}; } };

  await ctx.store.insertTrade({ market: 'crypto', symbol: 'ETHUSDT', trade_date: '2026-11-15', status: 'open', direction: 'LONG', entry_price: 100, entry_time: '2026-11-15T05:00:00Z', qty: 2, sl_price: 95, target_price: 110, trigger_t: 1 });
  await register.register(ctx); // intraday_reverse
  await mirrorRegister.register(ctx); // intraday_mirror
  await ctx.cron.jobs['17 * * * * *'](); // reverse sync
  await ctx.cron.jobs['33 * * * * *'](); // mirror sync

  const alerts = alertsRegister.register(ctx);
  await alerts.check();

  assert.equal(sent.length, 3, 'exactly 3 Telegram messages: original, MIRROR, REVERSE');
  const original = sent.find((t) => t.includes('| intraday\n'));
  const mirror = sent.find((t) => t.includes('intraday-MIRROR'));
  const reverse = sent.find((t) => t.includes('intraday-REVERSE'));
  assert.ok(original, 'original alert sent');
  assert.ok(mirror, 'MIRROR alert sent');
  assert.ok(reverse, 'REVERSE alert sent');
  assert.match(mirror, /Kyu: MIRROR of trade #1/);
  assert.match(reverse, /Kyu: REVERSE of trade #1/);
});
