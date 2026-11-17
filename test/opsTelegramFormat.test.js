'use strict';
// Add-on v2 items 1-2: Telegram entry/exit message formatting + INR math (src/paper/ops/telegramAlerts/format.js).
// Every number is hand-worked in the comment right above its assertion - never copied from the function's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEntry, formatExit, estimateMove, fxInfo, capitalLine, computeCapitalState } = require('../src/paper/ops/telegramAlerts/format');

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

// ---- Capital line (Task: live running capital balance on every trade alert, entry AND exit) + the pure
// computeCapitalState() it is built on. Every number hand-worked in the comment right above its assertion
// - never copied from the function's own output.

test('computeCapitalState: nativeInr (NSE) - total + locked (own fx/nativeInr per open trade) + realized net, hand-checked', () => {
  // totalInr = 100000 (nativeInr, fx.rate=1 so total*1=total)
  // realizedNet = 2000 + (-500) = 1500
  // locked = 101*500 (nativeInr, no fx) = 50,500
  // capitalLeft = 100000 + 1500 - 50500 = 51,000
  const state = computeCapitalState({
    capitalTotal: 100000, nativeInr: true, fx: { rate: 1 },
    closedTrades: [{ pnl_inr: 2000 }, { pnl_inr: -500 }],
    openTrades: [{ entry_price: 101, qty: 500 }],
  });
  assert.deepEqual(state, { totalInr: 100000, realizedNetInr: 1500, lockedInr: 50500, capitalLeftInr: 51000 });
});

test('computeCapitalState: crypto - each open trade converted via ITS OWN fx_rate, not the total\'s rate, hand-checked', () => {
  // totalInr = 1000 * 90 = 90,000
  // realizedNet = 3000 + (-1200) = 1800
  // locked = (100*2*90) + (50*1*85) = 18,000 + 4,250 = 22,250 (second open trade's OWN fx_rate, 85, not 90)
  // capitalLeft = 90000 + 1800 - 22250 = 69,550
  const state = computeCapitalState({
    capitalTotal: 1000, nativeInr: false, fx: { rate: 90 },
    closedTrades: [{ pnl_inr: 3000 }, { pnl_inr: -1200 }],
    openTrades: [{ entry_price: 100, qty: 2, fx_rate: 90 }, { entry_price: 50, qty: 1, fx_rate: 85 }],
  });
  assert.deepEqual(state, { totalInr: 90000, realizedNetInr: 1800, lockedInr: 22250, capitalLeftInr: 69550 });
});

test('computeCapitalState: an open trade with no fx_rate and no usdInrFallback contributes nothing to locked (never an invented rate)', () => {
  // locked = only the first open trade (100*2*90 = 18,000); the second has no rate anywhere, so it is skipped
  const state = computeCapitalState({
    capitalTotal: 1000, nativeInr: false, fx: { rate: 90 },
    closedTrades: [],
    openTrades: [{ entry_price: 100, qty: 2, fx_rate: 90 }, { entry_price: 999, qty: 5 }],
  });
  assert.equal(state.lockedInr, 18000);
});

test('computeCapitalState: no capitalTotal or no fx -> null, never a half-guessed number', () => {
  assert.equal(computeCapitalState({ capitalTotal: 0, fx: { rate: 90 } }), null);
  assert.equal(computeCapitalState({ capitalTotal: 1000, fx: null }), null);
  assert.equal(computeCapitalState(), null);
});

test('capitalLine: nativeInr (NSE) - total/used/left-now/running-net in rupees, hand-checked', () => {
  // used = 101 * 500 = 50,500; pct = 50500/100000*100 = 50.5%
  // realizedNet = 2000 + (-500) = 1,500; locked (this same open trade, in the book snapshot) = 50,500
  // left now = 100000 + 1500 - 50500 = 51,000
  const t = { entry_price: 101, qty: 500 };
  const text = capitalLine(t, {
    capitalTotal: 100000, nativeInr: true,
    closedTrades: [{ pnl_inr: 2000 }, { pnl_inr: -500 }],
    openTrades: [{ entry_price: 101, qty: 500 }],
  });
  assert.equal(text, 'Capital: ₹1,00,000 total | this trade ₹50,500 (50.5%) | ₹51,000 left now\nRunning net P&L: +₹1,500');
});

test('capitalLine: crypto with a real fx rate - converts total AND used to rupees, live balance hand-checked', () => {
  // used = 100 * 2 = 200 USDT; pct = 20%; total INR = 1000*90 = 90,000; used INR = 200*90 = 18,000
  // realizedNet = 3000 + (-1200) = 1,800
  // locked = this same open trade (100*2*90=18,000) + another open trade (50*1*90=4,500) = 22,500
  // left now = 90000 + 1800 - 22500 = 69,300
  const t = { entry_price: 100, qty: 2, fx_rate: 90, fx_source: 'coingecko' };
  const text = capitalLine(t, {
    capitalTotal: 1000, nativeInr: false,
    closedTrades: [{ pnl_inr: 3000 }, { pnl_inr: -1200 }],
    openTrades: [{ entry_price: 100, qty: 2, fx_rate: 90 }, { entry_price: 50, qty: 1, fx_rate: 90 }],
  });
  assert.equal(text, 'Capital: ₹90,000 total | this trade ₹18,000 (20%) | ₹69,300 left now\nRunning net P&L: +₹1,800');
});

test('capitalLine: no closedTrades/openTrades passed -> reads as "no other activity known" (realized 0, locked 0), never a crash', () => {
  // used = 100*2=200 USDT, pct 20%, total INR 90,000, used INR 18,000; realizedNet=0, locked=0 -> left now = 90,000
  const t = { entry_price: 100, qty: 2, fx_rate: 90 };
  assert.equal(capitalLine(t, { capitalTotal: 1000 }), 'Capital: ₹90,000 total | this trade ₹18,000 (20%) | ₹90,000 left now\nRunning net P&L: +₹0');
});

test('capitalLine: crypto with NO fx anywhere - shows USD and says "rate n/a", never an invented rate (legacy per-trade fallback)', () => {
  // used = 100 * 2 = 200 USDT; pct = 20%; left = 1000 - 200 = 800 (no INR rate anywhere, so no live balance either)
  const t = { entry_price: 100, qty: 2, fx_rate: null };
  assert.equal(capitalLine(t, { capitalTotal: 1000, nativeInr: false }), 'Capital: $1000 total | this trade $200 (20%) | $800 left (rate n/a, per-trade only)');
});

test('capitalLine: no capitalTotal passed -> null, never a guessed number', () => {
  assert.equal(capitalLine({ entry_price: 100, qty: 2 }, {}), null);
  assert.equal(capitalLine({ entry_price: 100, qty: 2 }, { capitalTotal: 0 }), null);
  assert.equal(capitalLine({ entry_price: 100, qty: 2 }), null); // opts entirely omitted
});

test('formatEntry: capital line (2 lines) appears right after Reward:Risk, before the blank line and Kyu, only when capitalTotal is passed', () => {
  // used = 100*10 = 1000 USDT = 100% of capitalTotal -> total INR = 1000*90 = 90,000; used INR = 90,000
  // realizedNet (one closed trade) = 500; locked (this same trade, now open) = 100*10*90 = 90,000
  // left now = 90000 + 500 - 90000 = 500
  const withCap = formatEntry(LONG, 'intraday', {
    costPct: 0, capitalTotal: 1000,
    closedTrades: [{ pnl_inr: 500 }],
    openTrades: [{ entry_price: 100, qty: 10, fx_rate: 90 }],
  }).split('\n');
  assert.equal(withCap[9], 'Capital: ₹90,000 total | this trade ₹90,000 (100%) | ₹500 left now');
  assert.equal(withCap[10], 'Running net P&L: +₹500');
  assert.equal(withCap[11], ''); // the blank separator before Kyu is still there, just shifted down two lines
  assert.equal(withCap[12], 'Kyu: order_block retest. 15m trend up, VWAP reclaim.');

  // without capitalTotal, the layout is byte-for-byte the same as before this feature (no new blank line, no stray text)
  const withoutCap = formatEntry(LONG, 'intraday', { costPct: 0 });
  assert.ok(!withoutCap.includes('Capital:'));
});

// ---- Task 1 root-cause fix: a legacy crypto/intraday trade opened before level-based exits existed
// (paperbot/bot.js's cryptoMonitor) stores target_price/sl_price as null. estimateMove() used to coerce
// `Number(null)` to 0, so `distance = Math.abs(0 - entryPrice) = entryPrice` - a ~100%-of-entry-price
// "move", inflating the shown implied risk by 40-150x and showing the literal word "null" for Target/Stop.
// Every number below is hand-worked, never copied from the function's own output.

test('estimateMove: a null/undefined level is never coerced to price 0 - returns n/a (null), not an inflated number', () => {
  assert.deepEqual(estimateMove(1819.91, null, 1, 0, { rate: 88 }), { usd: null, inr: null });
  assert.deepEqual(estimateMove(1819.91, undefined, 1, 0, { rate: 88 }), { usd: null, inr: null });
  // a missing entry_price or qty must not be coerced to 0 either
  assert.deepEqual(estimateMove(null, 110, 1, 0, { rate: 88 }), { usd: null, inr: null });
  assert.deepEqual(estimateMove(100, 110, null, 0, { rate: 88 }), { usd: null, inr: null });
});

test('formatEntry: legacy crypto trade (target_price/sl_price both null) - the exact ETHUSDT SHORT incident entry (1819.91) - shows reconstructed prices, never "null", and a sane implied risk', () => {
  // Reconstruction (src/paper/lib/legacyExit.js, DEFAULTS.crypto target_pct 2 / stop_pct 1, SHORT so dir=-1):
  // target = 1819.91 * (1 - 2/100) = 1819.91 * 0.98 = 1783.5118 (below entry, correct for a SHORT)
  // stop   = 1819.91 * (1 + 1/100) = 1819.91 * 1.01 = 1838.1091 (above entry, correct for a SHORT)
  const legacy = { id: 501, direction: 'SHORT', symbol: 'ETHUSDT', entry_price: 1819.91, target_price: null, sl_price: null, qty: 1, basis: 'legacy fixed-rule trade' };
  const text = formatEntry(legacy, 'intraday', { costPct: 0, usdInrFallback: 88 });
  assert.match(text, /Target: 1783\.5118 \(legacy fixed % \(reconstructed\)\)/);
  assert.match(text, /Stop: 1838\.1091 \(legacy fixed % \(reconstructed\)\)/);
  assert.doesNotMatch(text, /\bnull\b/);
  assert.doesNotMatch(text, /\bundefined\b/);
  assert.doesNotMatch(text, /\bNaN\b/);
  // distance to target = |1783.5118 - 1819.91| = 36.3982 -> net 36.4usd -> inr = round(36.4*88) = 3,203
  // distance to stop = |1838.1091 - 1819.91| = 18.1991 -> net 18.2usd -> inr = round(18.2*88) = 1,602
  // (BEFORE the fix: a null-coerced-to-0 level made distance = entry_price = 1819.91, giving an inr figure
  // roughly 1819.91*88 ≈ 160,152 for a qty of 1 - 40-150x too large, and the "null" bug text besides.)
  assert.match(text, /Target lagne par ≈ \+₹3,203/);
  assert.match(text, /Stop lagne par ≈ -₹1,602/);
  // reward:risk = 36.4 / 18.2 = 2.00 - a real, sane number, not the meaningless 1.00 the null-coercion bug produced
  assert.match(text, /Reward:Risk 2\.00/);
});

test('formatEntry: legacy LONG crypto trade (both null) - target above entry, stop below, same reconstruction', () => {
  // target = 100 * 1.02 = 102; stop = 100 * 0.99 = 99
  const legacy = { id: 502, direction: 'LONG', symbol: 'BTCUSDT', entry_price: 100, target_price: null, sl_price: null, qty: 1 };
  const text = formatEntry(legacy, 'intraday', { costPct: 0, usdInrFallback: 88 });
  assert.match(text, /Target: 102 \(legacy fixed % \(reconstructed\)\)/);
  assert.match(text, /Stop: 99 \(legacy fixed % \(reconstructed\)\)/);
});

test('formatEntry: a NORMAL level-based trade (target_price/sl_price both present) is completely unaffected by the legacy-reconstruction code path', () => {
  const text = formatEntry(LONG, 'intraday', { costPct: 0 });
  assert.match(text, /Target: 110 \(swing high 1h\)/);
  assert.match(text, /Stop: 95 \(pattern low \+ 1xATR\)/);
  assert.doesNotMatch(text, /reconstructed/);
});

// ---- Task 3: blanket robustness - a maximally-sparse trade (only the truly required identity fields)
// must never throw and must never leak "null"/"undefined"/"NaN"/"[object Object]" into a Telegram message,
// for every bot label telegramAlerts/register.js sends alerts for.
const ALL_BOT_LABELS = ['intraday', 'intraday-MIRROR', 'scalp', 'scalp-MIRROR', 'scalp_wide', 'scalp_wide-MIRROR',
  'nse', 'nse_scalp', 'exhaustion_only', 'exhaustion_only-MIRROR', 'trend_smc', 'trend_smc-MIRROR'];
const BAD_SUBSTRINGS = [/\bnull\b/, /\bundefined\b/, /\bNaN\b/, /\[object Object\]/];

for (const label of ALL_BOT_LABELS) {
  test(`formatEntry/formatExit (${label}): a maximally-sparse trade (id, symbol, direction only) never throws and never leaks null/undefined/NaN/[object Object]`, () => {
    const sparse = { id: 1, symbol: 'X', direction: 'LONG' };
    const nativeInr = label === 'nse' || label === 'nse_scalp';
    const entryText = formatEntry(sparse, label, { nativeInr });
    const exitText = formatExit(sparse, label, { nativeInr });
    for (const re of BAD_SUBSTRINGS) {
      assert.doesNotMatch(entryText, re, `formatEntry(${label}) leaked ${re}`);
      assert.doesNotMatch(exitText, re, `formatExit(${label}) leaked ${re}`);
    }
  });
}

test('formatEntry/formatExit: a maximally-sparse SHORT/PUT trade and a trade with a totally unknown exit_reason are also safe', () => {
  for (const direction of ['SHORT', 'PUT', 'CALL', 'unknown']) {
    const t = { id: 2, symbol: 'Y', direction };
    const entryText = formatEntry(t, 'intraday', {});
    for (const re of BAD_SUBSTRINGS) assert.doesNotMatch(entryText, re);
  }
  const exitText = formatExit({ id: 3, symbol: 'Y', direction: 'LONG', exit_reason: 'some_future_reason_this_code_does_not_know_about' }, 'intraday', {});
  for (const re of BAD_SUBSTRINGS) assert.doesNotMatch(exitText, re);
  assert.match(exitText, /some_future_reason_this_code_does_not_know_about/); // shown plainly, not swallowed
});

test('formatExit: capital line (2 lines) appears last, only when capitalTotal is passed', () => {
  const t = { symbol: 'BTCUSDT', exit_reason: 'target', pnl_inr: 4500, entry_time: '2026-11-14T10:00:00Z', exit_time: '2026-11-14T10:37:00Z', entry_price: 100, qty: 2 };
  // used = 100*2 = 200 USDT; pct = 20%; total INR = 1000*90 = 90,000; used INR = 18,000
  // realizedNet (this same trade, now closed) = 4500; locked (no other open trades) = 0
  // left now = 90000 + 4500 - 0 = 94,500
  const withCap = formatExit(t, 'intraday', {
    capitalTotal: 1000, nativeInr: false, usdInrFallback: 90,
    closedTrades: [{ pnl_inr: 4500 }], openTrades: [],
  });
  const lines = withCap.split('\n');
  assert.equal(lines[lines.length - 2], 'Capital: ₹90,000 total | this trade ₹18,000 (20%) | ₹94,500 left now');
  assert.equal(lines[lines.length - 1], 'Running net P&L: +₹4,500');

  const withoutCap = formatExit(t, 'intraday');
  assert.ok(!withoutCap.includes('Capital:'));
});
