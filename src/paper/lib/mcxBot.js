'use strict';
// Generic MCX commodity bot (mcx_gold, mcx_crude - docs/BOTS.md). PAPER ONLY, no order API anywhere.
// Reuses src/paper/scalp/engine.js's analyseWide() / evaluateExit() / settle() UNCHANGED (5-min entries,
// 15-min trend built from the 5-min candles, VWAP, ATR-based stop) - this file only wires that engine to
// an MCX symbol: the market-hours gate (paperbot/time.js mcxSession()), position sizing in LOTS
// (paperbot/engine.js sizeNse(), the same lot-based sizing the NSE option bot uses - premium x lot, not
// sizeCrypto's fractional-coin notional), and storage.
//
// One symbol per bot (GOLDM or CRUDEOIL), one open trade at a time - no daily cap, no cooldown, the same
// convention the crypto scalp_wide bot uses for each of its coins.
const E = require('../../../paperbot/engine');
const { istParts, istDayStart, mcxSession } = require('../../../paperbot/time');
const { analyseWide, evaluateExit, settle } = require('../scalp/engine');

// Values that are already in INR (this bot's price source converts USD proxy -> INR before anything else
// ever sees a candle - src/paper/lib/yahooFutures.js), so settle()'s fxRate is always 1: nothing here
// re-applies a USD/INR conversion a second time. fx_rate/fx_source are still stored on every trade (same
// columns every other bot has) so the report/alerts can show which USDINR rate priced the underlying
// candles, even though it played no further part in the P&L arithmetic.
const NATIVE_FX = 1;

function createMcxBot({ label, symbol, lotKey, store, source, loadCfg, shadowStore = null, now = Date.now, log = console.log }) {
  const skipSeen = new Set();
  const offHoursNoted = new Set();

  async function skip(reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[${label}] skip ${symbol}: ${reason}`);
    await store.insertSkip({ symbol, skip_date: date, reason });
  }

  async function scan() {
    const cfg = await loadCfg();
    const session = mcxSession(now(), cfg.holidays || []);
    if (!session.open) {
      // Off-hours (or a holiday) is NOT a skip: no store write, no alert - same "logged once a day, never
      // spammed" convention src/paper/scalp/bot.js's nseScalpScan() uses for the NSE scalp gap.
      const day = istParts(now()).date;
      const key = `${day}|${session.reason}`;
      if (!offHoursNoted.has(key)) { offHoursNoted.add(key); log(`[${label}] not scanning: ${session.reason}`); }
      return { ran: false, reason: session.reason };
    }
    const date = istParts(now()).date;
    const today = await store.tradesForDay(date);
    const open = await store.openTrades(symbol);
    if (open.length) return { ran: true, entered: [] }; // one open MCX trade at a time
    let c5;
    try { c5 = await source.candles5m(); } catch (e) { log(`[${label}] candles for ${symbol} failed: ${e.message}`); return { ran: true, entered: [] }; }
    const a = analyseWide({ c5raw: c5, now: now(), cfg, dayStartMs: istDayStart(now()) });
    if (!a.ok) { if (!a.quiet) await skip(a.reason, a.extra || {}); return { ran: true, entered: [] }; }
    const plan = a.plan;
    if (today.some((t) => t.symbol === symbol && t.trigger_t === plan.last.t)) return { ran: true, entered: [] }; // this candle was already traded
    const lot = cfg[lotKey];
    const size = E.sizeNse({ capital: cfg.capital_inr, riskPct: cfg.risk_pct, stopPct: plan.stopPct, freeCash: cfg.capital_inr, premium: plan.entry, lot });
    if (!size) { await skip('position size came out at 0 lots (capital too small for one lot at this stop)', { patterns: plan.hits.map((h) => h.name), trigger_t: plan.last.t }); return { ran: true, entered: [] }; }
    const long = plan.long;
    const row = {
      symbol, trade_date: date, status: 'open', rr: plan.rr,
      direction: long ? 'LONG' : 'SHORT', patterns: plan.hits.map((h) => h.name),
      trigger_t: plan.last.t,
      qty: size.qty, entry_price: plan.entry, entry_time: new Date(now()).toISOString(),
      sl_price: plan.stopPrice, target_price: plan.targetPrice, target_type: plan.targetType, stop_type: plan.stopType,
      basis: `${label} ${long ? 'LONG' : 'SHORT'} on ${symbol} (MCX proxy, src/paper/lib/yahooFutures.js): the 5-min chart showed `
        + `${plan.hits.map((h) => h.name.replace(/_/g, ' ')).join(', ')}. 15-min trend ${plan.trend15}, price ${plan.ctx15.price} vs VWAP ${plan.ctx15.vwap}. `
        + `Target ${plan.targetPrice} (${plan.targetType}), stop ${plan.stopPrice} (${plan.stopType}), reward/risk ${plan.rr} after costs. `
        + `${size.lots} lot(s) of ${lot} (demo, not a real MCX order).`,
    };
    const id = await store.insertTrade(row);
    if (id == null) return { ran: true, entered: [] }; // restart safety: unique (symbol, trigger_t) index caught a duplicate
    log(`[${label}] PAPER entry ${symbol} ${row.direction} @ ${plan.entry}: ${row.patterns.join(', ')}; target ${plan.targetPrice}, stop ${plan.stopPrice}, R ${plan.rr}, ${size.lots} lot(s)`);
    return { ran: true, entered: [symbol] };
  }

  async function monitor() {
    const cfg = await loadCfg();
    const session = mcxSession(now(), cfg.holidays || []);
    const open = await store.openTrades(symbol);
    if (!session.open) {
      // Still outside the session: never force an exit just because the clock moved past 23:30 - the
      // open trade waits for the next session's candles, same as every other time-gated bot in this repo.
      return { checked: 0, closed: 0 };
    }
    if (!open.length) return { checked: 0, closed: 0 };
    let closed = 0;
    for (const t of open) {
      let candles;
      try { candles = await source.candles5m(); } catch (e) { log(`[${label}] candles for ${t.symbol} failed: ${e.message}`); continue; }
      const ev = evaluateExit({ trade: t, candles: E.closedOnly(candles, 300000, now()), nowMs: now(), cfg });
      if (!ev.exit) continue;
      const s = settle({ trade: t, exitPrice: ev.price, cfg, fxRate: NATIVE_FX });
      await store.updateTrade(t.id, {
        status: 'closed', exit_price: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason,
        ...s, fx_rate: NATIVE_FX, fx_source: 'native INR (MCX proxy already converted - src/paper/lib/yahooFutures.js)',
      });
      log(`[${label}] PAPER exit ${t.symbol}: ${ev.reason}, net Rs ${s.pnl_inr}`);
      closed += 1;
    }
    return { checked: open.length, closed };
  }

  return { scan, monitor };
}

module.exports = { createMcxBot };
