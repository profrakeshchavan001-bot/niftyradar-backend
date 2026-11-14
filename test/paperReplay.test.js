'use strict';
// Paper bot replay: plays the recorded candles in test/fixtures/paper_replay.json
// through the real bot with a fake clock and fake data sources (no network).
// The fixture is hand-built (see make-paper-replay.js); P&L values below are
// worked out by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');
const { createReporter } = require('../paperbot/report');
const { loadConfig } = require('../paperbot/config');
const CS = require('./fixtures/cryptoScenario');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'paper_replay.json'), 'utf8'));
const MIN = 60000;
const FIVE = 5 * MIN;

function nseHarness({ optionLtp, news = [], feedStopsAt = Infinity }) {
  const clock = { t: fx.nse.sessionStart };
  const store = createMemoryStore();
  const logs = [];
  const closedAt = () => fx.nse.candles.filter((k) => k.t + FIVE <= clock.t);
  const spotNow = () => closedAt().at(-1)?.c ?? null;
  const nse = {
    ranking: () => {
      const price = spotNow();
      if (!price) return null;
      const volume = 1000000;
      return [{ symbol: 'TESTSTK', price, pct: -1.8, volume }, { symbol: 'AAA', price: 100, pct: 2.5, volume }, { symbol: 'BBB', price: 100, pct: -0.4, volume },
        { symbol: 'CCC', price: 100, pct: 0.3, volume }, { symbol: 'DDD', price: 100, pct: 0.6, volume }, { symbol: 'THIN', price: 100, pct: -3, volume: 10 }];
    },
    spot: (s) => (s === 'TESTSTK' ? spotNow() : null),
    // includes the candle still forming, like a live feed does
    candles: async (s) => ({ candles: s === 'TESTSTK' ? fx.nse.candles.filter((k) => k.t <= Math.min(clock.t, feedStopsAt)) : [], source: 'replay_fixture' }),
    optionQuote: async (s, dir, fixed) => {
      const ltp = optionLtp ? optionLtp(clock.t) : null;
      return ltp ? { ltp, strike: fixed?.strike ?? 490, expiry: fixed?.expiry ?? '2026-11-26', spot: spotNow() } : null;
    },
    lotSize: () => 500,
    news: async () => news,
  };
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log: (m) => logs.push(m) });
  // one session, minute by minute: scan 20 s after every 5-minute mark, exit check at :50 of every minute
  async function runSession() {
    for (let m = 0; m <= 375; m++) {
      const base = fx.nse.sessionStart + m * MIN;
      if (m % 5 === 0) { clock.t = base + 20000; await bot.nseScan(); }
      clock.t = base + 50000;
      await bot.nseMonitor();
    }
  }
  return { clock, store, bot, logs, runSession };
}

const ist = (h, m, s = 0) => Date.UTC(2026, 10, 13, h - 5, m - 30, s);

test('replay NSE: exhaustion reversal -> CALL at the real option price -> target exit', async () => {
  // option price script: 20 at entry (11:05:20), then 20.6, 21.4, 22.1
  const optionLtp = (t) => (t < ist(11, 6) ? 20 : t < ist(11, 7) ? 20.6 : t < ist(11, 8) ? 21.4 : 22.1);
  const h = nseHarness({ optionLtp });
  await h.runSession();
  const trades = h.store._db.trades;
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.symbol, 'TESTSTK');
  assert.equal(t.market, 'nse');
  assert.equal(t.direction, 'CALL');
  assert.ok(t.patterns.includes('exhaustion_reversal'));
  // Real R factor, CALL side: no swing low below 492, so stop = 1 x ATR; the nearest level above is the
  // previous-day low 499.8 (7.8 away), more than 3 x ATR (ATR is about 1.41), so target = 3 x ATR -> R = 3.
  assert.equal(t.r_factor, 3);
  assert.equal(t.r_detail.long.stopBasis, 'atr');
  assert.equal(t.r_detail.long.targetBasis, 'capped at 3 x ATR');
  assert.equal(t.r_detail.short.r, 2); // PUT side: no level below, target = 2 x ATR, stop = 1 x ATR
  assert.deepEqual(t.r_detail.prevDay, { high: 500.6, low: 499.8 });
  // old move-size value kept next to it: 1.8 x 1.8 + 0.5 = 3.74; by size of move it was 3rd (THIN -3%, AAA +2.5%)
  assert.equal(t.legacy_rf, 3.74);
  assert.equal(t.r_detail.legacyRank, 3);
  assert.equal(t.r_detail.rRank, 1);
  assert.match(t.score_source, /^r_factor_v2/);
  assert.equal(t.simulated_option, false);
  assert.equal(t.instrument, 'TESTSTK 2026-11-26 490 CE');
  assert.equal(t.entry_time, new Date(ist(11, 5, 20)).toISOString());
  // trigger candles saved with their numbers: small red, then the green candle
  const trig = t.trigger_candles.find((g) => g.pattern === 'exhaustion_reversal');
  assert.deepEqual(trig.candles.map((k) => [k.o, k.h, k.l, k.c]), [[491, 491.2, 490.4, 490.6], [490.6, 492.2, 490.5, 492]]);
  assert.equal(t.trend_state.vwapSide, 'down');
  assert.match(t.basis, /Bought a CALL on TESTSTK because it was in the top R-factor list/);
  assert.match(t.basis, /reversal trade against the trend/);
  // size: Rs 40,000 / (20 x 500 = 10,000 per lot) = 4 lots = 2000 qty
  assert.equal(t.qty, 2000);
  assert.equal(t.entry_price, 20);
  // 22.1 is +10.5% -> target; P&L = (22.1 - 20) x 2000 = 4200
  assert.equal(t.status, 'closed');
  assert.equal(t.exit_reason, 'target');
  assert.equal(t.exit_price, 22.1);
  assert.equal(t.pnl_inr, 4200);
  assert.equal(t.exit_time, new Date(ist(11, 8, 50)).toISOString());
  assert.equal(t.max_fav_pct, 10.5);
  // ranking: only liquid stocks with valid candles are ranked (THIN is illiquid, AAA-DDD have no candles)
  assert.ok(h.logs.some((l) => /NSE rank: 1 ranked, 1 below the liquidity floor, 4 without valid candles; top: TESTSTK R 3/.test(l)));
  assert.equal(h.store._db.skips.filter((s) => s.symbol !== 'TESTSTK').length, 0);
});

test('replay NSE: no option price -> simulated (flagged) -> forced exit at 15:15', async () => {
  const h = nseHarness({ optionLtp: null });
  await h.runSession();
  const trades = h.store._db.trades;
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.simulated_option, true);
  assert.match(t.price_source, /simulated/);
  assert.match(t.basis, /SIMULATED/);
  // premium = 2.5% of 492 = 12.3; lot value 12.3 x 500 = 6150; 40,000 / 6150 = 6 lots = 3000 qty
  assert.equal(t.entry_price, 12.3);
  assert.equal(t.qty, 3000);
  // by 15:15 fifty more candles closed, +0.02 each: stock 493; option 12.3 + 0.5 x 1 = 12.8 (+4.07%, below target)
  assert.equal(t.exit_reason, 'time_exit_15:15');
  assert.equal(t.exit_underlying, 493);
  assert.equal(t.exit_price, 12.8);
  assert.equal(t.pnl_inr, 1500); // 0.5 x 3000
  assert.equal(t.exit_time, new Date(ist(15, 15, 50)).toISOString());
});

test('replay NSE: news today -> no trade, skip reason logged', async () => {
  const h = nseHarness({ optionLtp: () => 20, news: [{ title: 'TESTSTK board to consider results today', pubDate: 'Fri, 13 Nov 2026 08:30:00 +0530' }] });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.ok(h.store._db.skips.some((s) => s.symbol === 'TESTSTK' && /^news filter: news today/.test(s.reason) && s.patterns.includes('exhaustion_reversal')));
});

test('replay NSE: holiday and weekend -> the bot does nothing', async () => {
  const h = nseHarness({ optionLtp: () => 20 });
  await h.store.setConfigIfMissing('nse', { holidays: ['2026-11-13'] });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.equal(h.store._db.skips.length, 0);
});

test('replay NSE: max trades per day is respected', async () => {
  const h = nseHarness({ optionLtp: () => 20 });
  await h.store.setConfigIfMissing('nse', { max_trades_per_day: 0 });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.ok(h.store._db.skips.some((s) => s.symbol === 'TESTSTK' && /max 0 trades/.test(s.reason)));
});

test('wake after sleep: stale data is refused, missed candles are not replayed, current candle is traded once', async () => {
  // 1) feed stopped at the trigger candle (closed 11:05); the bot wakes at 11:20: data is 3 candles old -> nothing
  const stale = nseHarness({ optionLtp: () => 20, feedStopsAt: ist(11, 0) });
  stale.clock.t = ist(11, 20, 20);
  await stale.bot.nseScan();
  assert.equal(stale.store._db.trades.length, 0);
  assert.ok(stale.logs.some((l) => /0 ranked, 1 below the liquidity floor, 5 without valid candles/.test(l)));
  // 2) live feed, the bot wakes at 11:20 having slept through the 11:05 signal: that old candle is not traded
  const late = nseHarness({ optionLtp: () => 20 });
  late.clock.t = ist(11, 20, 20);
  await late.bot.nseScan();
  assert.equal(late.store._db.trades.length, 0);
  // 3) the bot wakes right on the signal candle: traded, and a second run on the same candle adds nothing
  const onTime = nseHarness({ optionLtp: () => 20 });
  onTime.clock.t = ist(11, 5, 20);
  await onTime.bot.nseScan();
  onTime.clock.t = ist(11, 6, 5);
  await onTime.bot.nseScan();
  assert.equal(onTime.store._db.trades.length, 1);
});

test('replay crypto: exhaustion reversal down -> SHORT -> stop at the level-based stop, P&L in INR; then summary', async () => {
  // candles and hand-worked numbers: test/fixtures/cryptoScenario.js (entry 102.18, stop 103.12, target 99.099)
  const candles = CS.build();
  const clock = { t: CS.scanTime(candles) };
  const store = createMemoryStore();
  let price = 102.2;
  const crypto = {
    candles: async (s) => (s === 'BTCUSDT' ? candles.filter((k) => k.t <= clock.t) : []),
    price: async () => price,
    usdtInr: async () => ({ rate: 88, source: 'test' }),
  };
  const bot = createBot({ store, nse: null, crypto, now: () => clock.t, log: () => {} });
  await bot.cryptoScan();
  await bot.cryptoScan(); // a second scan on the same candle must not open a second trade
  assert.equal(store._db.trades.length, 1);
  const t = store._db.trades[0];
  assert.equal(t.market, 'crypto');
  assert.equal(t.direction, 'SHORT');
  assert.ok(t.patterns.includes('exhaustion_reversal'));
  assert.equal(t.entry_price, 102.18);
  assert.ok(t.r_factor >= 1);
  assert.match(t.basis, /Went SHORT on BTCUSDT because its momentum score was/);
  // notional = min(risk-based 2174, 1000/3, 1000) = 333.33 USDT
  assert.ok(Math.abs(t.qty * 102.18 - 333.3333) < 0.001);

  clock.t += 30000;
  await bot.cryptoMonitor(); // 102.2 is under the stop 103.12: stays open
  assert.equal(store._db.trades[0].status, 'open');
  price = 103.2; // above the stop 103.12 (pattern high 102.52 + ATR 0.6)
  clock.t += MIN;
  await bot.cryptoMonitor();
  const c = store._db.trades[0];
  assert.equal(c.exit_reason, 'stop');
  // loss = (103.2 - 102.18) x 333.3333 / 102.18 = 3.327461 USDT x 88 = Rs 292.82
  assert.equal(c.pnl_inr, -292.82);
  assert.equal(c.fx_rate, 88);

  // end-of-day summary: no Telegram env -> stored in daily_summaries
  const reporter = createReporter({ store, axios: null, env: {}, now: () => clock.t, log: () => {}, loadConfig });
  const r = await reporter.daily('crypto');
  assert.equal(r.telegram_sent, false);
  const saved = store._db.summaries[0];
  assert.equal(saved.kind, 'crypto_daily');
  assert.equal(saved.summary_date, '2026-11-13');
  assert.match(saved.body, /PAPER bot \(demo, no real money\)/);
  assert.match(saved.body, /BTCUSDT SHORT/);
  assert.match(saved.body, /exit: stop · P&L Rs -293/);
  assert.match(saved.body, /Day total: 1 trades, 0 wins, P&L Rs -293/);
  assert.match(saved.body, /exhaustion_reversal: 1 trades, win 0%, avg Rs -293 \(fewer than 20 trades, no conclusion\)/);
  const w = await reporter.weekly();
  assert.match(w.text, /Too few trades, no conclusion/);
});

test('crypto: no daily trade limit (one open trade per coin stays)', async () => {
  const candles = CS.build();
  const clock = { t: CS.scanTime(candles) };
  const store = createMemoryStore();
  await store.setConfigIfMissing('crypto', { max_trades_per_day: 0 }); // an old stored limit is ignored
  // seven closed trades already taken today (more than the old limit of 6)
  for (let i = 0; i < 7; i++) {
    const id = await store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', trade_date: '2026-11-13', trigger_t: i, patterns: [], qty: 1, entry_price: 100, basis: 'b' });
    await store.updateTrade(id, { status: 'closed', pnl_inr: 1 });
  }
  const crypto = { candles: async (s) => (s === 'BTCUSDT' ? candles.filter((k) => k.t <= clock.t) : []), price: async () => 102.2, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const bot = createBot({ store, nse: null, crypto, now: () => clock.t, log: () => {} });
  await bot.cryptoScan();
  assert.equal(store._db.trades.length, 8); // the 8th trade of the day is taken
  const t = store._db.trades[7];
  assert.deepEqual([t.symbol, t.direction, t.status, t.data_source], ['BTCUSDT', 'SHORT', 'open', 'binance_public']);
  // short at 102.18: stop = pattern high 102.52 + ATR 0.6, target = 0.1% before the swing low 99 (test/fixtures/cryptoScenario.js)
  assert.deepEqual([t.sl_price, t.target_price], [103.12, 99.099]);
  assert.ok(!store._db.skips.some((s) => /max .* trades/.test(s.reason)));
  await bot.cryptoScan(); // still one open trade per coin
  assert.equal(store._db.trades.length, 8);
});

test('Telegram: sent when the env vars exist, token never logged', async () => {
  const { sendTelegram } = require('../paperbot/report');
  const calls = [];
  const axios = { post: async (url, body) => { calls.push({ url, body }); } };
  assert.equal(await sendTelegram(axios, { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '9' }, 'x'.repeat(5000)), true);
  assert.equal(calls.length, 2); // split at 3900 characters
  assert.equal(calls[0].url, 'https://api.telegram.org/botT/sendMessage');
  const logs = [];
  const bad = { post: async () => { const e = new Error('boom https://api.telegram.org/botSECRET/x'); e.response = { status: 401 }; throw e; } };
  assert.equal(await sendTelegram(bad, { TELEGRAM_BOT_TOKEN: 'SECRET', TELEGRAM_CHAT_ID: '9' }, 'hi', (m) => logs.push(m)), false);
  assert.ok(!logs.join(' ').includes('SECRET'));
});

test('safety: no order-placing code path in paperbot/', () => {
  const dir = path.join(__dirname, '..', 'paperbot');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Dhan order endpoints and Binance trading/account endpoints must never appear
    assert.doesNotMatch(src, /\/orders|\/super\/orders|\/forever|\/positions|\/api\/v3\/order|\/fapi\/|X-MBX-APIKEY|signature=/, `${f} must not touch an order API`);
  }
});
