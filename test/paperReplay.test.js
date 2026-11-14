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

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'paper_replay.json'), 'utf8'));
const MIN = 60000;
const FIVE = 5 * MIN;

function nseHarness({ optionLtp, news = [] }) {
  const clock = { t: fx.nse.sessionStart };
  const store = createMemoryStore();
  const logs = [];
  const closedAt = () => fx.nse.candles.filter((k) => k.t + FIVE <= clock.t);
  const spotNow = () => closedAt().at(-1)?.c ?? null;
  const nse = {
    ranking: () => {
      const price = spotNow();
      if (!price) return null;
      return [{ symbol: 'TESTSTK', price, pct: -1.8 }, { symbol: 'AAA', price: 100, pct: 0.5 }, { symbol: 'BBB', price: 100, pct: -0.4 },
        { symbol: 'CCC', price: 100, pct: 0.3 }, { symbol: 'DDD', price: 100, pct: 0.6 }, { symbol: 'EEE', price: 100, pct: -0.2 }];
    },
    spot: (s) => (s === 'TESTSTK' ? spotNow() : null),
    // includes the candle still forming, like a live feed does
    candles: async (s) => ({ candles: s === 'TESTSTK' ? fx.nse.candles.filter((k) => k.t <= clock.t) : [], source: 'replay_fixture' }),
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
  assert.equal(t.r_factor, 4); // |-1.8| / median of (1.8, 0.6, 0.5, 0.4, 0.3, 0.2) = (0.4 + 0.5) / 2 = 0.45 -> 1.8 / 0.45 = 4
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
  // skips were written with a reason, once each (not once per scan)
  const skips = h.store._db.skips;
  assert.ok(skips.some((s) => s.symbol === 'AAA' && /not enough 5-min candles/.test(s.reason)));
  assert.equal(skips.filter((s) => s.symbol === 'AAA').length, 1);
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

test('replay crypto: exhaustion reversal down -> SHORT -> stop, P&L in INR; then summary', async () => {
  const trigger = fx.crypto.candles[39]; // red candle O 101.88 C 101.58, closes 09:20 IST
  const clock = { t: trigger.t + FIVE + 25000 };
  const store = createMemoryStore();
  let price = 101.6;
  const crypto = {
    candles: async (s) => (s === 'BTCUSDT' ? fx.crypto.candles.filter((k) => k.t <= clock.t) : []),
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
  assert.equal(t.entry_price, 101.58);
  assert.ok(t.r_factor >= 1);
  assert.match(t.basis, /Went SHORT on BTCUSDT because its momentum score was/);
  // notional = min(2000, 1000/3, 1000) = 333.33 USDT
  assert.ok(Math.abs(t.qty * 101.58 - 333.3333) < 0.001);

  clock.t += 30000;
  await bot.cryptoMonitor(); // 101.6 = -0.02% for a short: stays open
  assert.equal(store._db.trades[0].status, 'open');
  price = 102.7; // +1.1026% against the short: stop
  clock.t += MIN;
  await bot.cryptoMonitor();
  const c = store._db.trades[0];
  assert.equal(c.exit_reason, 'stop');
  // loss = 333.3333 x 1.12 / 101.58 = 3.675264 USDT x 88 = Rs 323.42
  assert.equal(c.pnl_inr, -323.42);
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
  assert.match(saved.body, /exit: stop · P&L Rs -323/);
  assert.match(saved.body, /Day total: 1 trades, 0 wins, P&L Rs -323/);
  assert.match(saved.body, /exhaustion_reversal: 1 trades, win 0%, avg Rs -323 \(fewer than 20 trades, no conclusion\)/);
  const w = await reporter.weekly();
  assert.match(w.text, /Too few trades, no conclusion/);
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
