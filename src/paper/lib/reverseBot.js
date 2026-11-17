'use strict';
// Generic REVERSE bot: wraps any original bot's own store/engine, same shape as createMirrorBot()
// (src/paper/lib/mirrorBot.js) for the OPEN side - sync() opens a reverse trade for every original trade
// not reversed yet (open or closed), via buildReverseEntry (src/paper/lib/reverse.js).
//
// Unlike MIRROR (whose target/stop are a literal swap of the original's own two numbers, so whichever
// one the original hits, the mirror hits the other AT THE SAME INSTANT - closing it is just a patch),
// REVERSE has its OWN, independent levels (1x stop / 2x target), so its exit is NOT determined by the
// original's own close - it genuinely needs its own candle-by-candle monitor, exactly like a real bot.
// monitor() reuses the ORIGINAL bot's own evaluateExitFn/settle() (never re-implemented here) against the
// SAME live candles the original reads, so the exit and cost model are identical in kind, only the levels
// differ.
const { buildReverseEntry } = require('./reverse');

function createReverseBot({ originalStore, reverseStore, fetchCandles, evaluateExitFn, settle, loadCfg, fxRateFallback = 88, log = console.log, label = 'reverse' }) {
  async function allOriginalTrades() {
    const [open, closed] = await Promise.all([originalStore.allOpenTrades(), originalStore.closedTrades()]);
    return [...open, ...closed];
  }

  // Opens a reverse trade for every original trade not reversed yet. Idempotent: insertTrade() is a
  // no-op for an original_trade_id already reversed (unique index, same convention as the mirror store).
  async function sync() {
    const originals = await allOriginalTrades();
    let opened = 0;
    for (const o of originals) {
      if (o.id == null) continue;
      if (await reverseStore.byOriginalId(o.id)) continue;
      const id = await reverseStore.insertTrade(buildReverseEntry(o));
      if (id == null) continue; // raced with another sync tick for the same original trade
      opened += 1;
      log(`[${label}] REVERSE opened for original trade #${o.id} (${o.symbol} ${o.direction} -> reverse ${invertedLabel(o.direction)})`);
    }
    return { opened };
  }

  function invertedLabel(direction) {
    return { LONG: 'SHORT', SHORT: 'LONG' }[direction] || direction;
  }

  // Checks every OPEN reverse trade against its own target/stop, using the SAME candle source and the
  // SAME evaluateExitFn(trade, candles, nowMs, cfg) -> { exit, reason, price } the original bot's own
  // monitor uses - never a different exit rule for REVERSE. `fetchCandles(symbol, sinceMs)` returns the
  // candles needed to cover from the trade's own entry to now (recoveryLimit-style, src/paper/lib/
  // recoveryWindow.js, same pattern cryptoMonitor/scalp monitors already use).
  async function monitor(now = Date.now()) {
    const open = await reverseStore.allOpenTrades();
    if (!open.length) return { checked: 0, closed: 0 };
    const cfg = typeof loadCfg === 'function' ? await loadCfg() : (loadCfg || {});
    let closed = 0;
    for (const t of open) {
      let candles;
      try { candles = await fetchCandles(t.symbol, Date.parse(t.entry_time)); } catch (e) { log(`[${label}] candles for ${t.symbol} failed: ${e.response?.status || e.message}`); continue; }
      if (!candles || !candles.length) continue;
      let r;
      try { r = evaluateExitFn(t, candles, now, cfg); } catch (e) { log(`[${label}] evaluateExit for ${t.symbol} failed: ${e.message}`); continue; }
      if (!r || !r.exit) continue;
      const fxRate = fxRateFallback;
      const s = typeof settle === 'function' ? settle({ trade: t, exitPrice: r.price, cfg, fxRate }) : {};
      // exit_time: the candle's own time when evaluateExitFn gives one (r.timeMs - the scalp/scalp_wide
      // convention), else the wall-clock moment this monitor tick ran (the intraday/crypto convention,
      // paperbot/bot.js's own closeTrade) - each adapter matches its original bot's own convention.
      const exitTime = r.timeMs != null ? new Date(r.timeMs).toISOString() : new Date(now).toISOString();
      await reverseStore.updateTrade(t.id, { status: 'closed', exit_price: r.price, exit_time: exitTime, exit_reason: r.reason, ...s });
      closed += 1;
      log(`[${label}] REVERSE closed for trade #${t.id} (${t.symbol}): ${r.reason}, net ${s.pnl_inr ?? s.net_pnl_usdt ?? 'n/a'}`);
    }
    return { checked: open.length, closed };
  }

  return { sync, monitor };
}

module.exports = { createReverseBot };
