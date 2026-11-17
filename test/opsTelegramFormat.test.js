'use strict';
// Add-on v2 items 1-2: Telegram entry/exit message formatting + INR math (src/paper/ops/telegramAlerts/format.js).
// Every number is hand-worked in the comment right above its assertion - never copied from the function's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEntry, formatExit, estimateMove, fxInfo, capitalLine } = require('../src/paper/ops/telegramAlerts/format');

const LONG = { direction: 'LONG', symbol: 'BTCUSDT', entry_price: 100, target_price: 110, sl_price: 95, target_type: 'swing high 1h', stop_type: 'pattern low + 1xATR', qty: 10, basis: 'order_block retest.\n15m trend up, VWAP reclaim.\nextra line never shown.', fx_rate: 90, fx_source: 'coingecko' };

test('estimateMove: distance x qty minus cost%, in USD and INR (hand-checked, costPct=0)', () => {
  // target: |110-100|*10 = 100 gross, cost 0 -> net 100usd; inr = 100*90 = 9000
  assert.deepEqual(estimateMove(100, 110, 10, 0, { rate: 90 }), { usd: 100, inr: 9000 });
  // stop: |95-100|*10 = 50 gross -> net 50usd; inr = 50*90 = 4500
  assert.deepEqual(estimateMove(100, 95, 10, 0, { rate: 90 }), { usd: 50, inr: 4500 });
});

test('estimateMove: default cost% applied (0.1%/side x2 + 0.03% slippage = 0.23%), hand-checked', () => {
  // cost = entry*qty*0.0023 = 100*10*0.0023 = 2.3usd; target net = 100-2.3 = 97.7 -> inr = 97.7*90 = 8793
  assert.deepEqual(estimateMove(100, 110, 10, 0.0023, { rate: 90 }), { usd: 97.7, inr: 8793 });
});

test('estimateMove: no fx -> inr is null (never guessed), usd still computed', () => {
  assert.deepEqual(estimateMove(100, 110, 10, 0, null), { usd: 100, inr: null });
});

test('fxInfo: trade row fx_rate wins; else env fallback; else null', () => {
  assert.deepEqual(fxInfo({ fx_rate: 88, fx_source: 'coingecko' }, 90), { rate: 88, source: 'coingecko' });
  assert.deepEqual(fxInfo({ fx_rate: null }, 90), { rate: 90, source: 'USDINR_FALLBACK' });
  assert.equal(fxInfo({ fx_rate: null }, undefined), null);
  assert.equal(fxInfo({ fx_rate: 0 }, undefined), null); // a zero/invalid rate is never trusted
});

test('formatEntry: exact layout, level types in brackets, hand-checked INR, Reward:Risk, Kyu first 2 lines only', () => {
  const text = formatEntry(LONG, 'intraday', { costPct: 0 });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Trade | intraday'); // LONG fixture has no id
  assert.equal(lines[1], '🟢 LONG BTCUSDT');
  assert.equal(lines[2], 'Entry time: n/a'); // fixture has no entry_time
  assert.equal(lines[3], 'Entry: 100');
  assert.equal(lines[4], 'Target: 110 (swing high 1h)');
  assert.equal(lines[5], 'Stop: 95 (pattern low + 1xATR)');
  assert.equal(lines[6], 'Target lagne par ≈ +₹9,000'); // 100usd x 90 = 9000
  assert.equal(lines[7], 'Stop lagne par ≈ -₹4,500'); // 50usd x 90 = 4500
  assert.equal(lines[8], 'Reward:Risk 2.00'); // 100/50
  assert.equal(lines[9], '');
  assert.equal(lines[10], 'Kyu: order_block retest. 15m trend up, VWAP reclaim.'); // only first 2 lines, "extra line" dropped
});

test('formatEntry: SHORT direction emoji; missing level type falls back to "fixed %" (legacy rule)', () => {
  const t = { ...LONG, direction: 'SHORT', target_type: null, stop_type: null };
  const text = formatEntry(t, 'scalp', { costPct: 0 });
  assert.match(text, /^Trade \| scalp\n🔴 SHORT BTCUSDT/);
  assert.match(text, /Target: 110 \(fixed %\)/);
  assert.match(text, /Stop: 95 \(fixed %\)/);
});

test('formatEntry: no fx anywhere -> shows USD and says "rate n/a", never a silently invented rate', () => {
  const t = { ...LONG, fx_rate: null };
  const text = formatEntry(t, 'intraday', { costPct: 0 });
  assert.match(text, /Target lagne par ≈ \+\$100 \(rate n\/a\)/);
  assert.match(text, /Stop lagne par ≈ -\$50 \(rate n\/a\)/);
});

test('formatEntry: nativeInr (Task Group C - NSE bots) shows rupees directly, no FX line, no "rate n/a"', () => {
  // NSE option premium + lot-sized qty, already in rupees; paperbot/bot.js models no round-trip cost, so costPct: 0.
  const nse = { direction: 'CALL', symbol: 'RELIANCE', entry_price: 101, target_price: 106, sl_price: 97, target_type: 'order block', stop_type: 'swing low / 1x ATR', qty: 500, basis: 'order block retest' };
  const text = formatEntry(nse, 'nse', { costPct: 0, nativeInr: true });
  assert.match(text, /Entry: 101/);
  assert.match(text, /Target: 106 \(order block\)/);
  assert.match(text, /Stop: 97 \(swing low \/ 1x ATR\)/);
  // target: |106-101|*500 = 2500, no cost -> Rs 2,500; stop: |97-101|*500 = 2000 -> Rs 2,000
  assert.match(text, /Target lagne par ≈ \+₹2,500/);
  assert.match(text, /Stop lagne par ≈ -₹2,000/);
  assert.doesNotMatch(text, /\$|rate n\/a/);
});

test('formatExit: result word, net INR (+/-), time in trade in minutes (hand-checked)', () => {
  const t = { symbol: 'BTCUSDT', exit_reason: 'target', pnl_inr: 4500, entry_time: '2026-11-14T10:00:00Z', exit_time: '2026-11-14T10:37:00Z' };
  const text = formatExit(t, 'intraday');
  assert.equal(text, 'EXIT Trade | intraday\nBTCUSDT closed - TARGET hit\nEntry time: 14-Nov 3:30 PM IST\nExit time: 14-Nov 4:07 PM IST\nNet: +₹4,500\nTime in trade: 37 min');
});

test('formatExit: a loss shows a minus sign; stop/breakeven/other exit reasons worded plainly', () => {
  assert.match(formatExit({ symbol: 'X', exit_reason: 'stop', pnl_inr: -1200 }, 'scalp'), /Net: -₹1,200/);
  assert.match(formatExit({ symbol: 'X', exit_reason: 'stop', pnl_inr: -1200 }, 'scalp'), /STOP hit/);
  assert.match(formatExit({ symbol: 'X', exit_reason: 'breakeven', pnl_inr: 0 }, 'scalp'), /breakeven/);
});

// ---- Capital line (Task: capital line on every trade alert, entry AND exit). Every number hand-worked
// in the comment right above its assertion - never copied from the function's own output.

test('capitalLine: nativeInr (NSE) - total/used/left in rupees, % of total, hand-checked', () => {
  // used = 101 * 500 = 50,500; pct = 50500/100000*100 = 50.5%; left = 100000 - 50500 = 49,500
  const t = { entry_price: 101, qty: 500 };
  assert.equal(capitalLine(t, { capitalTotal: 100000, nativeInr: true }), 'Capital: ₹1,00,000 total | this trade ₹50,500 (50.5%) | ₹49,500 left (per-trade view)');
});

test('capitalLine: crypto with a real fx rate - converts total AND used to rupees, hand-checked', () => {
  // used = 100 * 2 = 200 USDT; pct = 200/1000*100 = 20%; total INR = 1000*90 = 90,000; used INR = 200*90 = 18,000; left = 72,000
  const t = { entry_price: 100, qty: 2, fx_rate: 90, fx_source: 'coingecko' };
  assert.equal(capitalLine(t, { capitalTotal: 1000, nativeInr: false }), 'Capital: ₹90,000 total | this trade ₹18,000 (20%) | ₹72,000 left (per-trade view)');
});

test('capitalLine: crypto with NO fx anywhere - shows USD and says "rate n/a", never an invented rate', () => {
  // used = 100 * 2 = 200 USDT; pct = 20%; left = 1000 - 200 = 800
  const t = { entry_price: 100, qty: 2, fx_rate: null };
  assert.equal(capitalLine(t, { capitalTotal: 1000, nativeInr: false }), 'Capital: $1000 total | this trade $200 (20%) | $800 left (rate n/a, per-trade view)');
});

test('capitalLine: no capitalTotal passed -> null, never a guessed number', () => {
  assert.equal(capitalLine({ entry_price: 100, qty: 2 }, {}), null);
  assert.equal(capitalLine({ entry_price: 100, qty: 2 }, { capitalTotal: 0 }), null);
  assert.equal(capitalLine({ entry_price: 100, qty: 2 }), null); // opts entirely omitted
});

test('formatEntry: capital line appears right after Reward:Risk, before the blank line and Kyu, only when capitalTotal is passed', () => {
  const withCap = formatEntry(LONG, 'intraday', { costPct: 0, capitalTotal: 1000 }).split('\n');
  // used = 100*10 = 1000 USDT = 100% of capitalTotal -> total INR = 1000*90 = 90,000; used INR = 1000*90 = 90,000; left = 0
  assert.equal(withCap[9], 'Capital: ₹90,000 total | this trade ₹90,000 (100%) | ₹0 left (per-trade view)');
  assert.equal(withCap[10], ''); // the blank separator before Kyu is still there, just shifted down one line
  assert.equal(withCap[11], 'Kyu: order_block retest. 15m trend up, VWAP reclaim.');

  // without capitalTotal, the layout is byte-for-byte the same as before this feature (no new blank line, no stray text)
  const withoutCap = formatEntry(LONG, 'intraday', { costPct: 0 });
  assert.ok(!withoutCap.includes('Capital:'));
});

test('formatExit: capital line appears as the last line, only when capitalTotal is passed', () => {
  const t = { symbol: 'BTCUSDT', exit_reason: 'target', pnl_inr: 4500, entry_time: '2026-11-14T10:00:00Z', exit_time: '2026-11-14T10:37:00Z', entry_price: 100, qty: 2 };
  const withCap = formatExit(t, 'intraday', { capitalTotal: 1000, nativeInr: false, usdInrFallback: 90 });
  // used = 100*2 = 200 USDT; pct = 20%; total INR = 1000*90 = 90,000; used INR = 18,000; left = 72,000
  assert.match(withCap, /Capital: ₹90,000 total \| this trade ₹18,000 \(20%\) \| ₹72,000 left \(per-trade view\)$/);

  const withoutCap = formatExit(t, 'intraday');
  assert.ok(!withoutCap.includes('Capital:'));
});
