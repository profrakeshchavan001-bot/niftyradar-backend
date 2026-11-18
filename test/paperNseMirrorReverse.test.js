'use strict';
// nse-MIRROR / nse-REVERSE (Group 4, 2026-11, src/paper/bots/nse_mirror|nse_reverse/register.js,
// src/paper/lib/nseOptionSide.js). Same test-double conventions as test/paperIntradayMirror.test.js /
// test/paperScalpWideReverse.test.js: a fake Express app/cron, the real register.js, the real memory
// store. The one addition both these plugins need that no crypto/stock mirror does: ctx.state.nse, a
// fake stand-in for the live Dhan option-chain source (paperbot/index.js's state.nse).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mirrorRegister = require('../src/paper/bots/nse_mirror/register');
const reverseRegister = require('../src/paper/bots/nse_reverse/register');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { createMemoryStore } = require('../paperbot/store');

function fakeApp() { const routes = {}; return { routes, get: (p, h) => { routes[p] = h; } }; }
function fakeCron() { const jobs = {}; return { jobs, schedule: (expr, fn) => { jobs[expr] = fn; } }; }

function fakeNse(quoteOf) {
  return { optionQuote: async (symbol, dir, fixed) => quoteOf(symbol, dir, fixed) };
}

const MARKET_HOURS_MS = Date.UTC(2026, 10, 16, 5, 30); // Monday 16 Nov 2026, 11:00 IST - inside the 09:00-15:45 job window

function baseCtx({ nseFake, env = {}, now = () => MARKET_HOURS_MS } = {}) {
  const app = fakeApp();
  const cron = fakeCron();
  const store = createMemoryStore();
  return {
    app, cron, store, state: { nse: nseFake }, env: { PAPER_ADMIN_SECRET: 's3cret', ...env }, now,
    log: () => {}, guarded: (name, fn) => fn, tz: 'Asia/Kolkata', pool: null, axios: { post: async () => { throw new Error('no network in tests'); } },
  };
}

async function insertRealNseTrade(store, overrides = {}) {
  return store.insertTrade({
    market: 'nse', symbol: 'RELIANCE', trade_date: '2026-11-16', status: 'open', direction: 'CALL',
    instrument: 'RELIANCE 2026-11-26 1300 CE', simulated_option: false, price_source: 'dhan_option_chain_ltp',
    entry_price: 20, entry_time: '2026-11-16T05:00:00Z', entry_underlying: 1305, qty: 500,
    sl_price: 19, target_price: 22, patterns: [], trigger_candles: [], basis: 'original',
    ...overrides,
  });
}

test('plugins: nse_mirror and nse_reverse are auto-discovered under bots/', () => {
  const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'nse_mirror'));
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'nse_reverse'));
});

test('nse-MIRROR sync: opens the OPPOSITE option at the real Dhan premium, own target/stop, same qty as the original', async () => {
  const ctx = baseCtx({ nseFake: fakeNse(async (symbol, dir, fixed) => ({ ltp: 15, strike: fixed.strike, expiry: fixed.expiry, spot: 1306 })) });
  await insertRealNseTrade(ctx.store);
  await mirrorRegister.register(ctx);
  await ctx.cron.jobs['20 * * * * *'](); // sync tick

  const open = await ctx.nseMirrorMemoryStore.allOpenTrades();
  assert.equal(open.length, 1);
  const m = open[0];
  assert.equal(m.direction, 'PUT'); // opposite of the original's CALL
  assert.equal(m.instrument, 'RELIANCE 2026-11-26 1300 PUT');
  assert.equal(m.entry_price, 15); // the REAL quote, never derived from the original's own premium
  assert.equal(m.price_source, 'dhan_option_chain_ltp');
  assert.equal(m.qty, 500); // same qty as the original
  // target_pct 10 / stop_pct 5 (paperbot/config.js DEFAULTS.nse), applied to the mirror's OWN entry (15):
  assert.equal(m.target_price, 16.5); // 15 * 1.10
  assert.equal(m.sl_price, 14.25); // 15 * 0.95
});

test('nse-MIRROR sync: never opens a mirror for a SIMULATED original (pre-Group-2 legacy row)', async () => {
  const ctx = baseCtx({ nseFake: fakeNse(async () => ({ ltp: 15, strike: 1300, expiry: '2026-11-26', spot: 1306 })) });
  await insertRealNseTrade(ctx.store, { simulated_option: true, price_source: 'simulated: premium 2.5% of spot, delta 0.5', instrument: 'RELIANCE ATM CE (simulated)' });
  await mirrorRegister.register(ctx);
  await ctx.cron.jobs['20 * * * * *']();
  assert.equal((await ctx.nseMirrorMemoryStore.allOpenTrades()).length, 0);
});

test('nse-MIRROR sync: no real quote available right now -> not opened this tick, never simulated', async () => {
  const ctx = baseCtx({ nseFake: fakeNse(async () => null) });
  await insertRealNseTrade(ctx.store);
  await mirrorRegister.register(ctx);
  const r = await ctx.cron.jobs['20 * * * * *']();
  assert.equal(r.opened, 0);
  assert.equal((await ctx.nseMirrorMemoryStore.allOpenTrades()).length, 0);
});

test('nse-MIRROR monitor: closes on its own target, reusing E.evaluateExit (never a different exit rule)', async () => {
  let price = 15;
  const ctx = baseCtx({ nseFake: fakeNse(async (symbol, dir, fixed) => ({ ltp: price, strike: fixed.strike, expiry: fixed.expiry, spot: 1306 })) });
  await insertRealNseTrade(ctx.store);
  await mirrorRegister.register(ctx);
  await ctx.cron.jobs['20 * * * * *']();
  price = 16.5; // the mirror's own target computed above
  const r = await ctx.cron.jobs['50 * * * * *']();
  assert.equal(r.closed, 1);
  const [closed] = await ctx.nseMirrorMemoryStore.closedTrades();
  assert.equal(closed.exit_reason, 'target');
  assert.equal(closed.exit_price, 16.5);
  assert.equal(closed.pnl_inr, (16.5 - 15) * 500);
});

test('nse-REVERSE sync: same direction as nse-MIRROR, own 2:1 reward:risk from the original\'s own stop distance', async () => {
  const ctx = baseCtx({ nseFake: fakeNse(async (symbol, dir, fixed) => ({ ltp: 15, strike: fixed.strike, expiry: fixed.expiry, spot: 1306 })) });
  // original: entry 20, sl 19 -> stop distance 1
  await insertRealNseTrade(ctx.store);
  await reverseRegister.register(ctx);
  await ctx.cron.jobs['25 * * * * *']();

  const open = await ctx.nseReverseMemoryStore.allOpenTrades();
  assert.equal(open.length, 1);
  const r = open[0];
  assert.equal(r.direction, 'PUT');
  assert.equal(r.entry_price, 15);
  assert.equal(r.sl_price, 14); // 15 - 1 (the original's own stop distance)
  assert.equal(r.target_price, 17); // 15 + 2x1 (reward:risk 2.0 by construction)
  assert.equal(r.qty, 500);
});

test('nse-REVERSE monitor: closes on its own stop (1x distance), reusing E.evaluateExit', async () => {
  let price = 15;
  const ctx = baseCtx({ nseFake: fakeNse(async (symbol, dir, fixed) => ({ ltp: price, strike: fixed.strike, expiry: fixed.expiry, spot: 1306 })) });
  await insertRealNseTrade(ctx.store);
  await reverseRegister.register(ctx);
  await ctx.cron.jobs['25 * * * * *']();
  price = 14; // the reverse's own stop computed above
  const r = await ctx.cron.jobs['55 * * * * *']();
  assert.equal(r.closed, 1);
  const [closed] = await ctx.nseReverseMemoryStore.closedTrades();
  assert.equal(closed.exit_reason, 'stop');
  assert.equal(closed.exit_price, 14);
  assert.equal(closed.pnl_inr, (14 - 15) * 500);
});

test('both switches follow PAPER_BOT_ENABLED when their own *_ENABLED is unset', async () => {
  const ctx = baseCtx({ nseFake: fakeNse(async () => null), env: { PAPER_BOT_ENABLED: 'false' } });
  await mirrorRegister.register(ctx);
  assert.equal(ctx.cron.jobs['20 * * * * *'], undefined);
  const ctx2 = baseCtx({ nseFake: fakeNse(async () => null), env: { PAPER_BOT_ENABLED: 'false' } });
  await reverseRegister.register(ctx2);
  assert.equal(ctx2.cron.jobs['25 * * * * *'], undefined);
});
