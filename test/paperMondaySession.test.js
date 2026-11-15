'use strict';
// Dry-run of a full NSE session, Monday 16 Nov 2026, 09:15-15:30 IST, with a FAKE CLOCK and FIXTURE
// candles - no network, no real money (docs/PAPER-BOT.md, "Task Group A" NSE Monday readiness).
// This exercises the real bot end to end: the real R-factor ranking (paperbot/rfactor.js,
// docs/R-FACTOR.md), the owner's two-candle-confirmed exhaustion reversal
// (paperbot/patterns.js exhaustionReversalConfirmed, NSE-only), the live Judge
// (src/paper/decision/judge.js, docs/JUDGE.md) with its sector/news helpers wired in, and the
// SMC/ICT tags (src/paper/lib/smc). It proves a trade actually OPENS, gets TRACKED (price/percent
// updates while open) and CLOSES (target/stop/EOD) within the simulated session - not just that one
// function returns the right number in isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');

const r2 = (x) => Number(x.toFixed(2));
const MIN = 60000;
const FIVE = 5 * MIN;

// Same hand-built-candle style as test/fixtures/make-paper-replay.js: a run of moves from a start
// price, each one 5 minutes after the last.
function series(startMs, startPrice, steps) {
  const out = [];
  let price = startPrice;
  steps.forEach(([move, wick, v], i) => {
    const o = price;
    const c = r2(o + move);
    out.push({ t: startMs + i * FIVE, o, h: r2(Math.max(o, c) + wick), l: r2(Math.min(o, c) - wick), c, v });
    price = c;
  });
  return out;
}
const rep = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

// Monday 16 Nov 2026, 09:15 IST = 03:45 UTC.
const SESSION_START = Date.UTC(2026, 10, 16, 3, 45);
const ist = (h, m, s = 0) => Date.UTC(2026, 10, 16, h - 5, m - 30, s);

// 14 flat candles, a fall (6 red candles, enough for the 4-of-6 rule), a small red candle, a FIRST
// green candle (closes above the small candle's high - not itself a signal), then the SECOND green
// candle that confirms entry (the owner's rule, docs/PAPER-BOT.md) - closing at 11:10 IST. Then a
// slow drift up to 15:30 (75 five-minute candles cover the whole 09:15-15:30 session).
const nseCandles = series(SESSION_START, 500, [
  ...rep(14, (i) => [i % 2 ? -0.4 : 0.4, 0.2, 1000]),
  [-1.5, 0.2, 1500], [-1.5, 0.2, 1500], [-1, 0.2, 1200], [-1.5, 0.2, 1500], [-1.5, 0.2, 1500], [-2, 0.2, 1500],
  [-0.4, 0.2, 900],
  [0.8, 0.1, 1500],
  [0.6, 0.1, 1500],
  ...rep(52, () => [0.02, 0.01, 800]),
]);
// Friday 13 Nov (the previous trading day, Sat/Sun are closed): quiet, so the 15-min ATR and the
// previous-day high/low used by the real R factor exist, as they would on a live feed.
const prevDayCandles = series(SESSION_START - 3 * 86400000, 500, rep(75, (i) => [i % 2 ? -0.4 : 0.4, 0.2, 1000]));
const ALL = [...prevDayCandles, ...nseCandles];

// Option price script: 20 at entry (11:10:20), then rises to 22.1 (+10.5%, clears the +10% target).
const optionLtp = (t) => (t < ist(11, 11) ? 20 : t < ist(11, 12) ? 20.6 : t < ist(11, 13) ? 21.4 : 22.1);

function mondayHarness() {
  const clock = { t: SESSION_START };
  const store = createMemoryStore();
  const logs = [];
  const sectorCalls = [];
  const newsCalls = [];
  const closedAt = () => ALL.filter((k) => k.t + FIVE <= clock.t);
  const spotNow = () => closedAt().at(-1)?.c ?? null;
  const nse = {
    ranking: () => {
      const price = spotNow();
      if (!price) return null;
      return [{ symbol: 'TESTSTK', price, pct: -1.8, volume: 1000000 }];
    },
    spot: (s) => (s === 'TESTSTK' ? spotNow() : null),
    candles: async (s) => ({ candles: s === 'TESTSTK' ? ALL.filter((k) => k.t <= clock.t) : [], source: 'monday_fixture' }),
    optionQuote: async (s, dir, fixed) => {
      const ltp = optionLtp(clock.t);
      return ltp ? { ltp, strike: fixed?.strike ?? 490, expiry: fixed?.expiry ?? '2026-12-31', spot: spotNow() } : null;
    },
    lotSize: () => 500,
    news: async () => [],
  };
  // Real-shaped sector/news helpers (same return shape as src/paper/context/sector.js /
  // src/paper/context/news.js), favourable, so the trade clears the Judge's 65-point threshold -
  // this also proves the Judge really asks these helpers for THIS symbol on the NSE path.
  const judgeHelpers = {
    stockSectorView: async (s) => { sectorCalls.push(s); return { sector: 'IT', score: 80, label: 'STRONG', vsNifty: 1 }; },
    newsScore: async (s) => { newsCalls.push(s); return { score: 40, label: 'positive', headlines: [] }; },
    eventBlock: async () => ({ block: false }),
  };
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log: (m) => logs.push(m), judgeOn: true, judgeHelpers });

  // One full session, minute by minute, exactly like the live cron: scan 20s after every 5-minute
  // mark (09:15 to 15:30, i.e. 09:15 + 375 minutes), exit check at :50 of every minute.
  const snapshots = [];
  async function runSession() {
    for (let m = 0; m <= 375; m++) {
      const base = SESSION_START + m * MIN;
      if (m % 5 === 0) { clock.t = base + 20000; await bot.nseScan(); }
      clock.t = base + 50000;
      await bot.nseMonitor();
      const open = store._db.trades.find((t) => t.status === 'open');
      snapshots.push({ m, open: open ? { max_fav_pct: open.max_fav_pct, max_adv_pct: open.max_adv_pct } : null });
    }
  }
  return { clock, store, bot, logs, sectorCalls, newsCalls, snapshots, runSession };
}

test('Monday 16 Nov 2026 09:15-15:30 IST, full session dry run: a trade OPENS, is TRACKED, and CLOSES', async () => {
  const h = mondayHarness();
  await h.runSession();

  // --- OPENS: exactly one NSE trade, from the real R-factor ranking + the owner's confirmed exhaustion rule ---
  assert.equal(h.store._db.trades.length, 1, 'exactly one trade opened in the session');
  const t = h.store._db.trades[0];
  assert.equal(t.symbol, 'TESTSTK');
  assert.equal(t.market, 'nse');
  assert.equal(t.trade_date, '2026-11-16');
  assert.equal(t.direction, 'CALL');
  assert.ok(t.patterns.includes('exhaustion_reversal'));
  // the saved trigger candles are THREE candles (small red, first green, second/confirming green) -
  // proof the two-candle confirmation really ran on the NSE path, not the single-candle crypto rule
  const trig = t.trigger_candles.find((g) => g.pattern === 'exhaustion_reversal');
  assert.equal(trig.candles.length, 3);
  assert.match(trig.note, /confirmed by a second green close/);
  assert.equal(t.entry_time, new Date(ist(11, 10, 20)).toISOString(), 'entry is decided on the SECOND green candle, 09:15 + 115 minutes');

  // --- real R factor (docs/R-FACTOR.md), not the legacy %-move placeholder ---
  assert.equal(t.score_source, 'r_factor_v2 (target distance / stop distance, 15-min ATR and swing levels)');
  assert.equal(t.r_factor, 3); // stop = 1 x ATR (1.4143), target capped at 3 x ATR (no level close enough)
  assert.equal(t.r_detail.long.stopBasis, 'atr');
  assert.equal(t.r_detail.long.targetBasis, 'capped at 3 x ATR');
  assert.ok(Number.isFinite(t.legacy_rf), 'the old placeholder value is still stored for comparison, never used to rank');
  assert.equal(t.r_detail.rRank, 1);

  // --- the live Judge (judgeOn: true) actually ran and took this trade ---
  assert.equal(t.judge_take, true);
  assert.equal(t.judge_score, 83);
  assert.deepEqual(t.judge_contributions, { r_factor: 25, pattern: 20, sector: 16, news: 7, market_trend: 5, time: 10 });
  assert.match(t.judge_basis, /^Taken: long scores 83\/100, needs 65\./);

  // --- sector/news helper modules really were asked for THIS stock (the Judge wiring, NSE path) ---
  assert.deepEqual(h.sectorCalls, ['TESTSTK']);
  assert.deepEqual(h.newsCalls, ['TESTSTK']);

  // --- SMC/ICT tags (src/paper/lib/smc) are present on the trade (informational, as documented) ---
  assert.ok(Array.isArray(t.smc_tags) && t.smc_tags.length > 0, 'SMC/ICT tags were computed and stored for this NSE trade');

  // --- TRACKED: max_fav_pct grows minute by minute while the trade is open, before it closes ---
  const whileOpen = h.snapshots.filter((s) => s.open);
  assert.ok(whileOpen.length >= 2, 'the trade stayed open across more than one monitor check, so tracking really ran');
  assert.equal(whileOpen[0].open.max_fav_pct, 0); // just opened, no excursion yet
  assert.ok(whileOpen.at(-1).open.max_fav_pct > whileOpen[0].open.max_fav_pct, 'max_fav_pct increased while the trade was tracked');

  // --- CLOSES: the option clears the +10% target before 15:30 ---
  assert.equal(t.status, 'closed');
  assert.equal(t.exit_reason, 'target');
  assert.equal(t.exit_price, 22.1);
  assert.equal(t.pnl_inr, 4200);
  assert.equal(t.max_fav_pct, 10.5);
  assert.ok(Date.parse(t.exit_time) < ist(15, 30), 'closed well before the 15:30 IST session end');

  // --- never an order-placing call anywhere in this run ---
  assert.ok(!h.logs.some((l) => /\/orders|\/positions/.test(l)));
});

test('Monday session: no trade yet before the second confirming candle has closed (one green is not enough on NSE)', async () => {
  const h = mondayHarness();
  // run only up to the FIRST green candle's close (10 candles short of the real confirmation)
  for (let m = 0; m <= 109; m++) {
    const base = SESSION_START + m * MIN;
    if (m % 5 === 0) { h.clock.t = base + 20000; await h.bot.nseScan(); }
    h.clock.t = base + 50000;
    await h.bot.nseMonitor();
  }
  assert.equal(h.store._db.trades.length, 0, 'the first green candle alone never opens an NSE trade - it only confirms the reversal, it is not the signal');
});

test('Monday session: a forced EOD exit still closes the trade by 15:15 if the target/stop are never hit', async () => {
  // same session, but the option price never moves, so neither the +10% target nor the -5% stop is hit
  const clock = { t: SESSION_START };
  const store = createMemoryStore();
  const closedAt = () => ALL.filter((k) => k.t + FIVE <= clock.t);
  const spotNow = () => closedAt().at(-1)?.c ?? null;
  const nse = {
    ranking: () => { const price = spotNow(); return price ? [{ symbol: 'TESTSTK', price, pct: -1.8, volume: 1000000 }] : null; },
    spot: (s) => (s === 'TESTSTK' ? spotNow() : null),
    candles: async (s) => ({ candles: s === 'TESTSTK' ? ALL.filter((k) => k.t <= clock.t) : [], source: 'monday_fixture' }),
    optionQuote: async () => ({ ltp: 20, strike: 490, expiry: '2026-12-31', spot: spotNow() }), // flat forever
    lotSize: () => 500,
    news: async () => [],
  };
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log: () => {}, judgeOn: true });
  for (let m = 0; m <= 375; m++) {
    const base = SESSION_START + m * MIN;
    if (m % 5 === 0) { clock.t = base + 20000; await bot.nseScan(); }
    clock.t = base + 50000;
    await bot.nseMonitor();
  }
  const t = store._db.trades[0];
  assert.equal(t.status, 'closed');
  assert.equal(t.exit_reason, 'time_exit_15:15');
  assert.equal(t.exit_price, 20); // flat option price, exits at whatever was last quoted
  assert.equal(t.pnl_inr, 0);
  assert.ok(Date.parse(t.exit_time) <= ist(15, 30), 'the forced exit itself still lands inside the 09:15-15:30 session');
});
