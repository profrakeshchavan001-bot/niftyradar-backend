'use strict';
// Group 3b (2026-11): root-cause fix for the reported bug "scalp_wide_reverse: 15 open trades that
// never close". Root cause: trigger_t is `bigint` in Postgres, which node-pg returns as a STRING, and
// src/paper/scalp/engine.js's evaluateExit() does ARITHMETIC on it directly (`c.t < trade.trigger_t +
// MIN`). A string + number is STRING CONCATENATION, producing a huge bogus number that every real
// candle timestamp compares as "less than" - so the exit loop's own `continue` fires on every candle,
// the loop body that would ever reach a stop/target/time-stop check never runs, and the monitor can
// never close the trade. src/paper/lib/mirrorStore.js now casts trigger_t (along with every other
// numeric-looking column) back to a real JS number - this file proves the mechanism, then the full,
// real wiring (createPgMirrorStore + createReverseBot, exactly as src/paper/bots/scalp_wide_reverse/
// register.js assembles them) against a FAKE Postgres pool that hands back trigger_t as a string, the
// same shape real Postgres would.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExit, settle } = require('../src/paper/scalp/engine');
const { SCALP_WIDE_DEFAULTS: cfg } = require('../src/paper/scalp/config');
const { createPgMirrorStore, castNumericColumns, NUMERIC_COLUMNS } = require('../src/paper/lib/mirrorStore');
const { createReverseBot } = require('../src/paper/lib/reverseBot');

const MIN = 60000;

test('castNumericColumns includes trigger_t (Group 3b fix)', () => {
  assert.ok(NUMERIC_COLUMNS.includes('trigger_t'), 'trigger_t must be cast, or every arithmetic exit check on it silently breaks');
  const out = castNumericColumns({ trigger_t: '1700000000000', entry_price: '100' });
  assert.equal(typeof out.trigger_t, 'number');
  assert.equal(out.trigger_t, 1700000000000);
});

// Demonstrates the EXACT mechanism of the bug directly against evaluateExit(), independent of any store:
// the same trade/candles, differing only in whether trigger_t is the real JS number or the string
// node-pg actually hands back.
test('evaluateExit: a string trigger_t (the real node-pg shape) makes a clear stop-hit invisible; a number trigger_t catches it', () => {
  const triggerT = 1700000000000;
  const trade = {
    direction: 'LONG', entry_price: 100, sl_price: 95, target_price: 120,
    entry_time: new Date(triggerT + MIN).toISOString(), trigger_t: triggerT,
  };
  // One candle, well after the trigger candle and well inside the 45-minute time stop, whose low (90)
  // clearly breaches the stop (95).
  const candles = [{ t: triggerT + MIN, o: 100, h: 100, l: 90, c: 92 }];

  const withNumber = evaluateExit({ trade, candles, nowMs: triggerT + 2 * MIN, cfg });
  assert.deepEqual([withNumber.exit, withNumber.reason, withNumber.price], [true, 'stop', 95]);

  const withStringTriggerT = evaluateExit({ trade: { ...trade, trigger_t: String(triggerT) }, candles, nowMs: triggerT + 2 * MIN, cfg });
  assert.equal(withStringTriggerT.exit, false, 'the exact bug this fix removes: a string trigger_t makes every candle look older than the (bogus, concatenated) cutoff, so the obvious stop-hit is never seen');
});

// Full, real wiring: a fake Postgres pool (trigger_t as a string, exactly like real Postgres) ->
// createPgMirrorStore -> createReverseBot, the identical assembly src/paper/bots/scalp_wide_reverse/
// register.js uses for its own monitor(). Before the Group 3b fix this never closes; after it, it does.
// Minimal but faithful: tracks one row's state and answers SELECT (filtered by status, like the real
// SQL) and UPDATE (merges the SET columns, like a real UPDATE ... WHERE id = $1) the same way Postgres
// would for createPgMirrorStore's own fixed queries.
function fakePgPool(initialRow) {
  const row = { ...initialRow };
  return {
    async query(sql, params) {
      if (/^UPDATE/.test(sql)) {
        const cols = sql.match(/SET (.+) WHERE/)[1].split(',').map((s) => s.trim().split(' = ')[0]);
        cols.forEach((c, i) => { row[c] = params[i + 1]; });
        return { rows: [] };
      }
      if (/status = 'closed'/.test(sql)) return { rows: row.status === 'closed' ? [{ ...row }] : [] };
      if (/status = 'open'/.test(sql)) return { rows: row.status === 'open' ? [{ ...row }] : [] };
      return { rows: [{ ...row }] };
    },
  };
}

test('scalp_wide-REVERSE monitor(), real wiring: a Postgres-shaped (string trigger_t) open trade closes on its own stop', async () => {
  const triggerT = 1700000000000;
  const row = {
    id: 42, original_trade_id: 7, symbol: 'SOLUSDT', trade_date: '2026-11-15', status: 'open',
    direction: 'LONG', trigger_t: String(triggerT), entry_price: '100', entry_time: new Date(triggerT + MIN).toISOString(),
    sl_price: '95', target_price: '120', qty: '10', basis: 'reverse', be_moved: false,
  };
  const reverseStore = createPgMirrorStore(fakePgPool(row), 'scalp_wide_reverse_trades');
  const candles = [{ t: triggerT + MIN, o: 100, h: 100, l: 90, c: 92 }];
  const evaluateExitFn = (trade, rawCandles, nowMs, cfgArg) => {
    const ev = evaluateExit({ trade, candles: rawCandles, nowMs, cfg: cfgArg });
    return ev.exit ? { exit: true, reason: ev.reason, price: ev.price, timeMs: ev.timeMs } : { exit: false };
  };
  const bot = createReverseBot({
    originalStore: { allOpenTrades: async () => [], closedTrades: async () => [] },
    reverseStore, fetchCandles: async () => candles, evaluateExitFn, settle, loadCfg: async () => cfg, log: () => {},
  });
  const r = await bot.monitor(triggerT + 2 * MIN);
  assert.deepEqual(r, { checked: 1, closed: 1 });
  const [closed] = await reverseStore.closedTrades();
  assert.equal(closed.exit_reason, 'stop');
  assert.equal(closed.exit_price, 95);
  assert.equal(typeof closed.net_pnl_usdt, 'number');
});
