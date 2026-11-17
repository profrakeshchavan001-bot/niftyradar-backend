'use strict';
// NSE currency-futures bots (USDINR/EURINR/GBPINR/JPYINR, PAPER ONLY, this task): session gating,
// lot-size defaults, settlement and alert formatting. Numbers are worked out by hand below (plain
// arithmetic, not copied from the function's own output - same convention as test/paperScalp.test.js /
// test/exhaustionOnly.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { ccyJobWindow, ccySession, SESSION_START_MIN, SESSION_END_MIN } = require('../src/paper/lib/currencySession');
const { sizeLots, settleInr, LOT_UNITS } = require('../src/paper/lib/currencyEngine');
const { CCY_WIDE_DEFAULTS } = require('../src/paper/lib/currencyConfig');
const { formatEntry, formatExit } = require('../src/paper/ops/telegramAlerts/format');
const { DEFAULTS: PAPERBOT_DEFAULTS } = require('../paperbot/config');
const { IST_OFFSET_MS } = require('../paperbot/time');
const { createCurrencyBot } = require('../src/paper/lib/currencyBot');
const { createMemoryCurrencyStore } = require('../src/paper/lib/currencyStore');
const { sceneWide } = require('./scalpFixtures');

// Builds the ms timestamp whose IST wall-clock reading is exactly (y, mon 1-12, d, hh, mm).
const ist = (y, mon, d, hh, mm) => Date.UTC(y, mon - 1, d, hh, mm) - IST_OFFSET_MS;

// ---------- plugin discovery ----------
const PAIRS = ['usdinr', 'eurinr', 'gbpinr', 'jpyinr'];

test('plugin: all four ccy_* bots and their _mirror siblings are auto-discovered by src/paper/pluginLoader.js', () => {
  const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
  for (const pair of PAIRS) {
    assert.ok(found.some((p) => p.root === 'bots' && p.name === `ccy_${pair}`), `ccy_${pair} not found`);
    assert.ok(found.some((p) => p.root === 'bots' && p.name === `ccy_${pair}_mirror`), `ccy_${pair}_mirror not found`);
  }
});

// ---------- session gating (09:00-17:00 IST, Mon-Fri, NSE holiday list) ----------
test('ccySession: boundaries are exactly 09:00 and 17:00 IST (inclusive) on a weekday', () => {
  assert.equal(SESSION_START_MIN, 9 * 60);
  assert.equal(SESSION_END_MIN, 17 * 60);
  // Tue 17 Nov 2026, not a holiday
  assert.equal(ccySession(ist(2026, 11, 17, 8, 59)).open, false); // one minute before open
  assert.equal(ccySession(ist(2026, 11, 17, 9, 0)).open, true);   // exactly at open
  assert.equal(ccySession(ist(2026, 11, 17, 12, 30)).open, true); // mid-session
  assert.equal(ccySession(ist(2026, 11, 17, 17, 0)).open, true);  // exactly at close
  assert.equal(ccySession(ist(2026, 11, 17, 17, 1)).open, false); // one minute after close
});

test('ccySession: weekend is closed regardless of time; a weekday on the NSE holiday list is closed', () => {
  const sat = ccySession(ist(2026, 11, 21, 12, 0)); // Saturday
  assert.equal(sat.open, false); assert.equal(sat.reason, 'weekend');
  const sun = ccySession(ist(2026, 11, 22, 12, 0)); // Sunday
  assert.equal(sun.open, false); assert.equal(sun.reason, 'weekend');
  // 24 Nov 2026 is a Tuesday AND is in paperbot/config.js DEFAULTS.nse.holidays - same NSE holiday list reused, not copied.
  assert.ok(PAPERBOT_DEFAULTS.nse.holidays.includes('2026-11-24'));
  const holiday = ccySession(ist(2026, 11, 24, 12, 0), PAPERBOT_DEFAULTS.nse.holidays);
  assert.equal(holiday.open, false); assert.equal(holiday.reason, 'NSE holiday');
  // Same calendar day with NO holiday list passed in (caller forgot to load one) is NOT silently treated as a holiday.
  assert.equal(ccySession(ist(2026, 11, 24, 12, 0)).open, true);
});

test('ccyJobWindow: cheap weekday/time-only gate is wider than the real session on both sides, and is NOT holiday-aware', () => {
  assert.equal(ccyJobWindow(ist(2026, 11, 17, 8, 44)).open, false); // before the 08:45 buffer
  assert.equal(ccyJobWindow(ist(2026, 11, 17, 8, 45)).open, true);  // buffer opens 15 min before the real 09:00 session
  assert.equal(ccyJobWindow(ist(2026, 11, 17, 17, 15)).open, true); // buffer closes 15 min after the real 17:00 session
  assert.equal(ccyJobWindow(ist(2026, 11, 17, 17, 16)).open, false);
  assert.equal(ccyJobWindow(ist(2026, 11, 21, 12, 0)).open, false); // Saturday
  // 24 Nov 2026 (NSE holiday) is NOT in the job-window's own concern - it opens fine at a normal time;
  // the real holiday check only happens inside ccySession(), same two-step convention as nseJobWindow()/nseSession().
  assert.equal(ccyJobWindow(ist(2026, 11, 24, 12, 0)).open, true);
});

// ---------- lot-size defaults ----------
test('defaults: 1 lot = 1000 units of the base currency (USD/EUR/GBP/JPY, uniform default for all four pairs); own INR capital per pair', () => {
  assert.equal(LOT_UNITS, 1000);
  assert.equal(CCY_WIDE_DEFAULTS.lot_units, 1000);
  assert.equal(CCY_WIDE_DEFAULTS.capital_inr, 100000);
});

// Hand arithmetic: capital 100000, risk 2%, stop 0.5%, price 83.25 (USDINR-style), 1 lot = 1000 units.
//   notionalCap = min(100000 x 2/100 / (0.5/100), 100000/1, 100000) = min(2000/0.005, 100000, 100000) = min(400000, 100000, 100000) = 100000
//   lotValue = 83.25 x 1000 = 83250 -> lots = floor(100000 / 83250) = floor(1.2012...) = 1
test('sizeLots: risk-capped notional floored to whole lots (a futures contract is never fractional)', () => {
  const s = sizeLots({ capitalInr: 100000, riskPct: 2, stopPct: 0.5, freeCashInr: 100000, price: 83.25, pairs: 1, lotUnits: 1000 });
  assert.deepEqual(s, { lots: 1, qty: 1000, value: 83250 });
});

// Hand arithmetic: same inputs but stop 0.05% (tighter) -> notionalCap = min(2000/0.0005, 100000, 100000) = min(4000000, 100000, 100000) = 100000
// -> same lotValue 83250 -> still 1 lot (the stop% only widens the room, never beyond the 100000 capital/free-cash cap).
test('sizeLots: a tighter stop widens the risk-based cap, but the capital/free-cash cap still binds', () => {
  const s = sizeLots({ capitalInr: 100000, riskPct: 2, stopPct: 0.05, freeCashInr: 100000, price: 83.25, pairs: 1, lotUnits: 1000 });
  assert.equal(s.lots, 1);
});

// Hand arithmetic: free cash only 50000 (one trade already open and holding the rest) -> notionalCap = min(400000, 100000, 50000) = 50000
// -> lots = floor(50000 / 83250) = 0 -> below 1 lot -> null (no free virtual balance for a second lot).
test('sizeLots: returns null when even 1 lot does not fit the free cash left', () => {
  assert.equal(sizeLots({ capitalInr: 100000, riskPct: 2, stopPct: 0.5, freeCashInr: 50000, price: 83.25, pairs: 1, lotUnits: 1000 }), null);
});

test('sizeLots: a non-positive price or stop refuses cleanly instead of dividing by zero', () => {
  assert.equal(sizeLots({ capitalInr: 100000, riskPct: 2, stopPct: 0, freeCashInr: 100000, price: 83.25, pairs: 1 }), null);
  assert.equal(sizeLots({ capitalInr: 100000, riskPct: 2, stopPct: 0.5, freeCashInr: 100000, price: 0, pairs: 1 }), null);
});

// ---------- settlement (straight rupees, no fx step) ----------
// Hand arithmetic: LONG, entry 83.00, exit 83.50, qty 1000 units -> gross = (83.50 - 83.00) x 1000 = 500.
// fee_pct_per_side/slippage_pct 0 (default) -> costPct(cfg) = 0 -> cost 0, net 500.
test('settleInr: LONG net P&L with no cost model (default) is exactly the price move x qty, in rupees', () => {
  const trade = { direction: 'LONG', entry_price: 83.0, qty: 1000 };
  const s = settleInr({ trade, exitPrice: 83.5, cfg: { fee_pct_per_side: 0, slippage_pct: 0 } });
  assert.deepEqual(s, { gross_pnl_inr: 500, cost_inr: 0, net_pnl_inr: 500, pnl_inr: 500 });
});

// Hand arithmetic: SHORT, entry 83.00, exit 82.70, qty 1000 -> gross = (83.00 - 82.70) x 1000 = 300 (short profits on a fall).
// costPct(cfg) = 2 x 0.05 + 0 = 0.1% of entry value (83.00 x 1000 = 83000) -> cost = 83000 x 0.001 = 83. net = 300 - 83 = 217.
test('settleInr: SHORT gross/net with a round-trip cost % (costPct, the SAME function analyseWide used at entry) applied to the entry value', () => {
  const trade = { direction: 'SHORT', entry_price: 83.0, qty: 1000 };
  const s = settleInr({ trade, exitPrice: 82.7, cfg: { fee_pct_per_side: 0.05, slippage_pct: 0 } });
  assert.equal(s.gross_pnl_inr, 300);
  assert.equal(s.cost_inr, 83);
  assert.equal(s.net_pnl_inr, 217);
  assert.equal(s.pnl_inr, 217);
});

test('settleInr: ignores an unrelated extra field (fxRate) passed by buildMirrorExitPatch() without needing one', () => {
  const trade = { direction: 'LONG', entry_price: 100, qty: 1000 };
  const s = settleInr({ trade, exitPrice: 101, cfg: { fee_pct_per_side: 0, slippage_pct: 0 }, fxRate: 88 });
  assert.equal(s.pnl_inr, 1000); // (101-100) x 1000, fxRate completely unused
});

// ---------- alert formatting (reused EXACTLY, never edited - src/paper/ops/telegramAlerts/format.js) ----------
test('formatEntry: a ccy_* trade uses the SAME template as every other bot, with nativeInr -> no FX step, rate 1', () => {
  const trade = {
    id: 42, symbol: 'USDINR', direction: 'LONG', entry_price: 83.0, target_price: 83.5, sl_price: 82.8,
    target_type: 'swing high 5m', stop_type: 'pattern low + ATR', qty: 1000, rr: 2.5,
    entry_time: '2026-11-17T04:00:00Z', basis: 'ccy_usdinr LONG from scalp_wide: engulfing',
  };
  const text = formatEntry(trade, 'ccy_usdinr', { costPct: 0, nativeInr: true, capitalTotal: CCY_WIDE_DEFAULTS.capital_inr });
  assert.match(text, /\| ccy_usdinr/);
  assert.match(text, /USDINR/);
  assert.match(text, /Entry: 83/);
  assert.match(text, /Reward:Risk 2\.50/);
  assert.match(text, /Kyu: ccy_usdinr LONG from scalp_wide/);
  // nativeInr path: the money estimate is a real rupee figure (fx.rate = 1), never "(rate n/a)" the way an
  // un-dated crypto trade with no fx_rate/USDINR_FALLBACK would show.
  assert.doesNotMatch(text, /rate n\/a/);
});

// ---------- end-to-end: createCurrencyBot reuses scalp_wide's analyseWide unchanged, gated to session hours ----------
// sceneWide() is test/scalpFixtures.js's exact scalp_wide fixture, already hand-verified in test/paperScalp.test.js
// ("scalp_wide entry: exhaustion reversal... stop 0.1056 %, target = the level (102.025)"): same bullish exhaustion
// reversal, entry 100.44, stop 100.333929, target 102.025. Its candle timestamps start at epoch 0 (not a real
// calendar time); shifting every timestamp by the SAME delta moves the whole scene onto a real Tue 17 Nov 2026
//10:00 IST "now" (inside the 09:00-17:00 session) without touching a single price - the hand-checked numbers
// above still apply unchanged.
function shiftedWideScene() {
  const s = sceneWide();
  const desiredNow = ist(2026, 11, 17, 10, 0);
  const delta = desiredNow - s.now;
  const c5raw = s.c5raw.map((k) => ({ ...k, t: k.t + delta }));
  return { c5raw, now: desiredNow, lastT: s.last.t + delta };
}

test('bot.scan(): PAPER entry during NSE currency hours, reusing scalp_wide analyseWide/evaluateExit unchanged (hand-verified stop/target)', async () => {
  const { c5raw, now, lastT } = shiftedWideScene();
  const store = createMemoryCurrencyStore();
  const cfg = { ...CCY_WIDE_DEFAULTS, min_candles_15m: 10, capital_inr: 200000 }; // 34 candles -> 10 complete 15-min buckets (same override test/paperScalp.test.js uses); capital widened so 1 lot (100,440 INR) fits
  const bot = createCurrencyBot({
    pair: 'USDINR', label: 'ccy_usdinr', store, fx: { candles5: async () => c5raw, candles15: async () => null },
    loadCfg: async () => cfg, loadHolidays: async () => PAPERBOT_DEFAULTS.nse.holidays, now: () => now, log: () => {},
  });
  const r = await bot.scan();
  assert.deepEqual(r, { ran: true, entered: ['USDINR'] });
  const open = await store.allOpenTrades();
  assert.equal(open.length, 1);
  const t = open[0];
  assert.equal(t.symbol, 'USDINR'); assert.equal(t.direction, 'LONG');
  assert.equal(t.entry_price, 100.44); assert.equal(t.sl_price, 100.333929); assert.equal(t.target_price, 102.025);
  assert.equal(t.qty, 1000); assert.equal(t.trigger_t, lastT);

  // monitor(): feed a candle after the trigger whose high reaches the target -> closes at target, net P&L in rupees, no fx step.
  const hitTarget = { t: lastT + 5 * 60000, o: 100.5, h: 102.1, l: 100.4, c: 101.9, v: 100 };
  const bot2 = createCurrencyBot({
    pair: 'USDINR', label: 'ccy_usdinr', store, fx: { candles5: async () => [...c5raw, hitTarget] },
    loadCfg: async () => cfg, loadHolidays: async () => PAPERBOT_DEFAULTS.nse.holidays, now: () => now + 6 * 60000, log: () => {},
  });
  const m = await bot2.monitor();
  assert.equal(m.closed, 1);
  const closed = await store.closedTrades();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exit_reason, 'target');
  assert.equal(closed[0].exit_price, 102.025);
  // gross = (102.025 - 100.44) x 1000 = 1585; no cost model -> net == gross
  assert.equal(closed[0].pnl_inr, 1585);
});

test('bot.scan(): outside NSE currency hours (and on an NSE holiday) is skipped silently - no trade, no "has not scanned" alert', async () => {
  const { c5raw, lastT } = shiftedWideScene();
  const store = createMemoryCurrencyStore();
  const cfg = { ...CCY_WIDE_DEFAULTS, min_candles_15m: 10, capital_inr: 200000 };
  const logs = [];
  // 1) Saturday - cheap ccyJobWindow() alone already refuses, before cfg/holidays are even loaded.
  const weekend = createCurrencyBot({
    pair: 'USDINR', label: 'ccy_usdinr', store, fx: { candles5: async () => c5raw },
    loadCfg: async () => cfg, loadHolidays: async () => PAPERBOT_DEFAULTS.nse.holidays, now: () => ist(2026, 11, 21, 12, 0), log: (m) => logs.push(m),
  });
  assert.deepEqual(await weekend.scan(), { ran: false, reason: 'weekend' });
  // 2) a weekday, inside the wide job-window buffer, but on the NSE holiday list - ccySession() catches this one.
  const holiday = createCurrencyBot({
    pair: 'USDINR', label: 'ccy_usdinr', store, fx: { candles5: async () => c5raw },
    loadCfg: async () => cfg, loadHolidays: async () => PAPERBOT_DEFAULTS.nse.holidays, now: () => ist(2026, 11, 24, 12, 0), log: (m) => logs.push(m),
  });
  assert.deepEqual(await holiday.scan(), { ran: false, reason: 'NSE holiday' });
  assert.equal((await store.allOpenTrades()).length, 0); // never a trade, either way
  assert.equal(logs.filter((m) => /has not scanned/.test(m)).length, 0); // no "has not scanned"-style alert text anywhere
  void lastT;
});

test('formatExit: a ccy_* trade shows net P&L straight in rupees, same template as every other bot', () => {
  const trade = {
    id: 42, symbol: 'USDINR', direction: 'LONG', entry_time: '2026-11-17T04:00:00Z', exit_time: '2026-11-17T04:40:00Z',
    exit_reason: 'target', pnl_inr: 500,
  };
  const text = formatExit(trade, 'ccy_usdinr', { nativeInr: true, capitalTotal: CCY_WIDE_DEFAULTS.capital_inr });
  assert.match(text, /EXIT.*\| ccy_usdinr/);
  assert.match(text, /TARGET hit/);
  assert.match(text, /Net: \+₹500/);
  assert.match(text, /Time in trade: 40 min/);
});
