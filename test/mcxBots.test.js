'use strict';
// MCX gold/crude bots (docs/BOTS.md, src/paper/bots/mcx_gold, mcx_crude + their mirrors): market-hours
// gating, lot-size position sizing, plugin auto-discovery, and alert-format wiring. The pattern-detection
// and exit/settle math themselves are NOT re-tested here - this bot reuses analyseWide()/evaluateExit()/
// settle() from src/paper/scalp/engine.js UNCHANGED, and that engine already has its own hand-verified
// tests in test/paperScalp.test.js. Numbers below are worked out by hand (see the comments next to each).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { mcxSession } = require('../paperbot/time');
const { sizeNse } = require('../paperbot/engine');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { MCX_GOLD_DEFAULTS, loadMcxGoldConfig } = require('../src/paper/bots/mcx_gold/config');
const { MCX_CRUDE_DEFAULTS, loadMcxCrudeConfig } = require('../src/paper/bots/mcx_crude/config');
const { createMemoryMcxStore } = require('../src/paper/lib/mcxStore');
const { createMcxBot } = require('../src/paper/lib/mcxBot');
const { goldUsdOzToInrPerGram, crudeUsdBblToInrPerBbl, TROY_OZ_TO_GRAM } = require('../src/paper/lib/yahooFutures');
const { sceneWide } = require('./scalpFixtures');
const { createMemoryStore } = require('../paperbot/store');

const MIN = 60000;

// ---------- mcxSession (paperbot/time.js) ----------

test('mcxSession: Mon-Fri 09:00-23:30 IST, not a weekend, not a holiday', () => {
  // Wed 11 Nov 2026, 10:00 IST = 04:30 UTC
  const wedMorning = Date.UTC(2026, 10, 11, 4, 30);
  assert.deepEqual(mcxSession(wedMorning), { open: true, reason: '' });
  // same day, 23:31 IST = 18:01 UTC -> just past close
  const wedLate = Date.UTC(2026, 10, 11, 18, 1);
  assert.equal(mcxSession(wedLate).open, false);
  assert.match(mcxSession(wedLate).reason, /outside 09:00-23:30/);
  // same day, 08:59 IST = 03:29 UTC -> just before open
  const wedEarly = Date.UTC(2026, 10, 11, 3, 29);
  assert.equal(mcxSession(wedEarly).open, false);
});

test('mcxSession: weekend is closed regardless of time', () => {
  // Sat 14 Nov 2026, 12:00 IST
  const sat = Date.UTC(2026, 10, 14, 6, 30);
  assert.deepEqual(mcxSession(sat), { open: false, reason: 'weekend' });
});

test('mcxSession: a listed MCX holiday is closed even on a weekday during session hours', () => {
  const diwali = Date.UTC(2026, 10, 24, 6, 30); // Tue 24 Nov 2026, 12:00 IST - a weekday
  assert.deepEqual(mcxSession(diwali, ['2026-11-24']), { open: false, reason: 'MCX holiday' });
});

// ---------- config: lot size, capital, symbol ----------

test('mcx_gold config: symbol GOLDM, lot 100 grams (MCX contract spec), own capital_inr, own holiday list', () => {
  assert.equal(MCX_GOLD_DEFAULTS.symbol, 'GOLDM');
  assert.equal(MCX_GOLD_DEFAULTS.lot_size_grams, 100);
  assert.equal(MCX_GOLD_DEFAULTS.capital_inr, 100000);
  assert.ok(Array.isArray(MCX_GOLD_DEFAULTS.holidays) && MCX_GOLD_DEFAULTS.holidays.length > 0);
});

test('mcx_crude config: symbol CRUDEOIL, lot 100 barrels (MCX contract spec), own capital_inr', () => {
  assert.equal(MCX_CRUDE_DEFAULTS.symbol, 'CRUDEOIL');
  assert.equal(MCX_CRUDE_DEFAULTS.lot_size_barrels, 100);
  assert.equal(MCX_CRUDE_DEFAULTS.capital_inr, 100000);
});

test('config loaders: the table wins when a row exists, defaults otherwise (same convention as loadScalpWideConfig)', async () => {
  const store = createMemoryStore();
  const gold = await loadMcxGoldConfig(store);
  assert.deepEqual(gold, MCX_GOLD_DEFAULTS);
  await store.setConfig('mcx_gold', { capital_inr: 50000 });
  const gold2 = await loadMcxGoldConfig(store);
  assert.equal(gold2.capital_inr, 50000);
  assert.equal(gold2.lot_size_grams, 100); // untouched keys still come from the default
});

// ---------- position sizing (sizeNse, lots not fractional units) ----------

// capital 100000, risk 2% = 2000 INR risk budget. stop 1% of entry. entry (premium) 6000 INR/gram, lot 100 g.
//   value = min(2000 / (1/100), freeCash) = min(200000, 100000) = 100000 -> lots = floor(100000 / (6000 x 100)) = floor(0.1667) = 0 -> null (too little capital for even 1 lot)
test('sizing: sizeNse (lot-based, like the NSE option bot) returns null when capital cannot buy even 1 lot', () => {
  const size = sizeNse({ capital: 100000, riskPct: 2, stopPct: 1, freeCash: 100000, premium: 6000, lot: 100 });
  assert.equal(size, null);
});

// Larger capital: 2,000,000 INR, same 2% risk, stop 1%, premium 6000 INR/gram, lot 100g.
//   value = min(40000 / 0.01, 2000000) = min(4000000, 2000000) = 2000000 -> lots = floor(2000000 / 600000) = 3
//   qty = 300 grams, value = 300 x 6000 = 1,800,000, riskInr = 1,800,000 x 1% = 18,000
test('sizing: with enough capital, sizeNse gives whole lots (never a fractional lot)', () => {
  const size = sizeNse({ capital: 2000000, riskPct: 2, stopPct: 1, freeCash: 2000000, premium: 6000, lot: 100 });
  assert.deepEqual(size, { lots: 3, qty: 300, value: 1800000, riskInr: 18000 });
});

// ---------- unit conversion (Yahoo USD proxy -> INR) ----------

// Gold: Yahoo GC=F quotes USD per troy ounce. 2000 USD/oz x 88 USDINR = 176000; / 31.1034768 g/oz = 5658.5314 INR/gram (long division).
test('goldUsdOzToInrPerGram: USD/troy-oz -> INR/gram, worked by hand', () => {
  const inrPerGram = goldUsdOzToInrPerGram(2000, 88);
  assert.ok(Math.abs(inrPerGram - 5658.5314) < 0.001);
});

// Crude: Yahoo CL=F quotes USD per barrel directly - just multiply by the USDINR rate. 75 USD/bbl x 88 = 6600 INR/bbl.
test('crudeUsdBblToInrPerBbl: USD/barrel -> INR/barrel, worked by hand', () => {
  assert.equal(crudeUsdBblToInrPerBbl(75, 88), 6600);
});

// ---------- bot.js: market-hours gate, no alert spam outside hours, reused scalp_wide engine ----------

function fakeSource(candles) {
  return { candles5m: async () => candles };
}

// sceneWide()'s candles are timestamped relative to an arbitrary epoch-0 origin (see test/scalpFixtures.js);
// analyseWide()'s freshness check compares `now` to the LAST candle's own t, so "now" must stay exactly
// `now` ms after that candle to count as fresh. mcxSession(), on the other hand, needs a real wall-clock
// time that falls inside 09:00-23:30 IST on a weekday. This shifts every candle's t by a constant offset
// so the two line up: same relative freshness, but landing on a real in-session wall-clock moment.
function shiftIntoSession(c5raw, wallNowMs) {
  const last = c5raw[c5raw.length - 1];
  const originalNow = last.t + 5 * MIN + 5000;
  const offset = wallNowMs - originalNow;
  return c5raw.map((k) => ({ ...k, t: k.t + offset }));
}

test('bot: outside MCX hours, scan() returns ran:false and writes NOTHING (no skip row, no alert) - same "quiet off-hours" convention as nseScalpScan', async () => {
  const store = createMemoryMcxStore();
  const { c5raw } = sceneWide();
  // Sunday - definitely closed
  const sunday = Date.UTC(2026, 10, 15, 6, 30);
  const bot = createMcxBot({
    label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(c5raw),
    loadCfg: async () => MCX_GOLD_DEFAULTS, now: () => sunday,
  });
  const r = await bot.scan();
  assert.equal(r.ran, false);
  assert.match(r.reason, /weekend/);
  assert.deepEqual(store._db.trades, []);
  assert.deepEqual(store._db.skips, []);
});

test('bot: inside MCX hours, scan() reuses analyseWide() unchanged and opens a whole-lot trade sized with sizeNse', async () => {
  const store = createMemoryMcxStore();
  const { c5raw: raw } = sceneWide();
  // force `now` to a weekday inside 09:00-23:30 IST regardless of the fixture's own epoch-relative time
  const wedNoon = Date.UTC(2026, 10, 11, 7, 0); // Wed, 12:30 IST
  const c5raw = shiftIntoSession(raw, wedNoon);
  const cfg = { ...MCX_GOLD_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0, min_candles_15m: 10, capital_inr: 2000000, holidays: [] };
  const bot = createMcxBot({
    label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(c5raw),
    loadCfg: async () => cfg, now: () => wedNoon,
  });
  const r = await bot.scan();
  assert.equal(r.ran, true);
  assert.deepEqual(r.entered, ['GOLDM']);
  const open = await store.allOpenTrades();
  assert.equal(open.length, 1);
  assert.equal(open[0].symbol, 'GOLDM');
  assert.equal(open[0].direction, 'LONG'); // same exhaustion-reversal fixture as test/paperScalp.test.js's scalp_wide test: long, entry 100.44
  assert.equal(open[0].qty % cfg.lot_size_grams, 0); // always a whole number of lots, never a fractional unit
  assert.ok(open[0].qty > 0);
});

test('bot: a second scan while a trade is still open does not open a new one (one open MCX trade at a time)', async () => {
  const store = createMemoryMcxStore();
  const wedNoon = Date.UTC(2026, 10, 11, 7, 0);
  const c5raw = shiftIntoSession(sceneWide().c5raw, wedNoon);
  const cfg = { ...MCX_GOLD_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0, min_candles_15m: 10, capital_inr: 2000000, holidays: [] };
  const bot = createMcxBot({ label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(c5raw), loadCfg: async () => cfg, now: () => wedNoon });
  await bot.scan();
  const r2 = await bot.scan();
  assert.deepEqual(r2.entered, []);
  assert.equal((await store.allOpenTrades()).length, 1);
});

test('bot: monitor() settles with fxRate 1 (price is already INR - no second conversion) and closes on target/stop like scalp_wide', async () => {
  const store = createMemoryMcxStore();
  const wedNoon = Date.UTC(2026, 10, 11, 7, 0);
  const c5raw = shiftIntoSession(sceneWide().c5raw, wedNoon);
  const cfg = { ...MCX_GOLD_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0, min_candles_15m: 10, capital_inr: 2000000, holidays: [] };
  const bot = createMcxBot({ label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(c5raw), loadCfg: async () => cfg, now: () => wedNoon });
  await bot.scan();
  const opened = (await store.allOpenTrades())[0];
  // push candles forward so the target is hit (target = 102.025 per the scalp_wide fixture's own comment)
  const hit = [...c5raw, { t: c5raw[c5raw.length - 1].t + 5 * MIN, o: 100.44, h: 102.1, l: 100.40, c: 102.0, v: 10 }]; // low stays above the stop (~100.334) so only the target is hit, not both
  const nowMs = hit[hit.length - 1].t + 5 * MIN + 5000; // still 12:40 IST on the same Wednesday - inside the session
  const bot2 = createMcxBot({ label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(hit), loadCfg: async () => cfg, now: () => nowMs });
  const r = await bot2.monitor();
  assert.equal(r.closed, 1);
  const closed = (await store.closedTrades())[0];
  assert.equal(closed.exit_reason, 'target');
  assert.equal(Number(closed.fx_rate), 1);
  assert.equal(closed.fx_source, 'native INR (MCX proxy already converted - src/paper/lib/yahooFutures.js)');
  // settle() is scalp_wide's own unchanged settle(): gross = (exit - entry) x qty, fxRate 1 -> pnl_inr = net exactly
  assert.equal(Math.round(closed.gross_pnl_usdt * 100) / 100, Math.round((closed.exit_price - opened.entry_price) * opened.qty * 100) / 100);
});

test('bot: monitor() does nothing outside MCX hours even with an open trade (no forced exit just because the clock moved on)', async () => {
  const store = createMemoryMcxStore();
  const wedNoon = Date.UTC(2026, 10, 11, 7, 0);
  const c5raw = shiftIntoSession(sceneWide().c5raw, wedNoon);
  const cfg = { ...MCX_GOLD_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0, min_candles_15m: 10, capital_inr: 2000000, holidays: [] };
  const bot = createMcxBot({ label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(c5raw), loadCfg: async () => cfg, now: () => wedNoon });
  await bot.scan();
  const sunday = Date.UTC(2026, 10, 15, 6, 30);
  const botSunday = createMcxBot({ label: 'mcx_gold', symbol: 'GOLDM', lotKey: 'lot_size_grams', store, source: fakeSource(c5raw), loadCfg: async () => cfg, now: () => sunday });
  const r = await botSunday.monitor();
  assert.deepEqual(r, { checked: 0, closed: 0 });
  assert.equal((await store.allOpenTrades()).length, 1); // still open
});

// ---------- plugin auto-discovery ----------

test('plugin: mcx_gold, mcx_crude and their mirrors are all auto-discovered by src/paper/pluginLoader.js (no manual wiring needed)', () => {
  const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
  for (const name of ['mcx_gold', 'mcx_crude', 'mcx_gold_mirror', 'mcx_crude_mirror']) {
    assert.ok(found.some((p) => p.root === 'bots' && p.name === name), `${name} should be auto-discovered`);
  }
});

// ---------- alert format / leaderboard / mirror backfill wiring ----------

test('telegram-alerts: mcx_gold/mcx_crude and their mirrors are wired into OWN_TABLE_BOTS, nativeInr true, cost modelled', () => {
  const { OWN_TABLE_BOTS } = require('../src/paper/ops/telegramAlerts/register');
  for (const bot of ['mcx_gold', 'mcx_crude', 'mcx_gold_mirror', 'mcx_crude_mirror']) {
    const entry = OWN_TABLE_BOTS[bot];
    assert.ok(entry, `${bot} should be in OWN_TABLE_BOTS`);
    assert.equal(entry.nativeInr, true, `${bot} prices are already INR`);
    assert.ok(entry.costPct > 0, `${bot} does model round-trip costs (unlike nse/nse_scalp)`);
    assert.ok(entry.capitalTotal > 0);
  }
});

test('leaderboard: closedTradesByBot reads mcx_gold/mcx_crude and their mirrors from ctx, empty when not registered', async () => {
  const { closedTradesByBot } = require('../src/paper/bots/leaderboard/register');
  const mainStore = createMemoryStore();
  const closed = await closedTradesByBot({ store: mainStore, pool: null });
  assert.deepEqual(closed.mcx_gold, []);
  assert.deepEqual(closed.mcx_crude, []);
  assert.deepEqual(closed.mcx_gold_mirror, []);
  assert.deepEqual(closed.mcx_crude_mirror, []);
});

test('mirror backfill: buildJobs includes mcx_gold and mcx_crude, nativeInr true (no second FX conversion in the report)', () => {
  const { buildJobs } = require('../scripts/mirrorBackfill');
  const mainStore = createMemoryStore();
  const jobs = buildJobs({ mainStore, pool: { query: async () => ({ rows: [] }) }, usdInrFallback: 88 });
  const gold = jobs.find((j) => j.bot === 'mcx_gold');
  const crude = jobs.find((j) => j.bot === 'mcx_crude');
  assert.ok(gold && crude);
  assert.equal(gold.nativeInr, true);
  assert.equal(crude.nativeInr, true);
  assert.equal(gold.mirrorTable, 'mcx_gold_mirror_trades');
  assert.equal(crude.mirrorTable, 'mcx_crude_mirror_trades');
});
