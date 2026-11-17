'use strict';
// Shared orchestration for all four ccy_* bots (USDINR/EURINR/GBPINR/JPYINR currency futures). One
// factory, parameterized by pair/symbol/fx-ticker/store/config, instead of four near-identical bot.js
// files - the task's own "do not duplicate pattern-detection logic" rule extended to the orchestration
// around it too. The actual entry rule (analyseWide) and exit rule (evaluateExit) are untouched imports
// from src/paper/scalp/engine.js (see src/paper/lib/currencyEngine.js's header). PAPER ONLY: no order API
// anywhere, same as every other bot in src/paper/bots/.
const { closedOnly, aggregate } = require('../../../paperbot/engine');
const { istParts, istDayStart } = require('../../../paperbot/time');
const { analyseWide, evaluateExit, sizeLots, settleInr } = require('./currencyEngine');
const { ccyJobWindow, ccySession } = require('./currencySession');

const FIVE = 5 * 60000;
const FIFTEEN = 15 * 60000;

// `pair`: 'USDINR' | 'EURINR' | 'GBPINR' | 'JPYINR' (also the symbol stored on every trade/skip row).
// `fx`: { candles5(pair), candles15(pair) } (src/paper/lib/currencyFx.js). `loadCfg`: () => cfg (own
// paper_config row, src/paper/lib/currencyConfig.js). `loadHolidays`: () => string[] (the SAME NSE
// holiday list paperbot/config.js's main nse section already owns - reused, never copied).
function createCurrencyBot({ pair, label, store, fx, loadCfg, loadHolidays, shadowStore, now = Date.now, log = console.log }) {
  const skipSeen = new Set();
  const noted = new Set(); // one "outside hours" log line per IST calendar day, never spammed every cron tick

  async function skip(reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[${label}] skip ${pair}: ${reason}`);
    await store.insertSkip({ symbol: pair, skip_date: date, reason });
    if (extra.shadowPlan && shadowStore) {
      await shadowStore.insertShadow({ bot: label, symbol: pair, setup_date: date, trigger_t: extra.shadowPlan.trigger_t, direction: extra.shadowPlan.direction, entry_price: extra.shadowPlan.entry_price, sl_price: extra.shadowPlan.sl_price, target_price: extra.shadowPlan.target_price, skip_reason: reason });
    }
  }

  // Outside NSE currency hours (09:00-17:00 IST) or on an NSE holiday: skip silently, no "has not
  // scanned" alert, same pattern nseScalpScan() in src/paper/scalp/bot.js already follows for the
  // reserved-but-not-running NSE scalp bot - log at most once a day so it is visible in the server log
  // without being noise on every cron tick.
  async function gateClosed(reasonPrefix) {
    const day = istParts(now()).date;
    const key = `${day}|${reasonPrefix}`;
    if (!noted.has(key)) { noted.add(key); log(`[${label}] not scanning ${pair}: ${reasonPrefix}`); }
    return { ran: false, reason: reasonPrefix };
  }

  async function resolveShadows() {
    if (!shadowStore) return { checked: 0, resolved: 0 };
    try {
      const open = await shadowStore.openShadows(label);
      if (!open.length) return { checked: 0, resolved: 0 };
      let resolved = 0;
      for (const sh of open) {
        try {
          const c5 = await fx.candles5(pair);
          const ev = evaluateExit({ trade: sh, candles: closedOnly(c5, FIVE, now()) });
          if (!ev.exit) continue;
          await shadowStore.resolveShadow(sh.id, { resolved_reason: ev.reason, resolved_price: ev.price, resolved_time: new Date(ev.timeMs).toISOString() });
          resolved += 1;
        } catch (e) { log(`[${label}] shadow ${sh.id} failed to resolve: ${e.message}`); }
      }
      return { checked: open.length, resolved };
    } catch (e) {
      log(`[${label}] resolveShadows failed: ${e.message}`);
      return { checked: 0, resolved: 0, error: e.message };
    }
  }

  async function scan() {
    // Cheap, database-free gate FIRST (weekend/time only - same convention as nseJobWindow()).
    const jw = ccyJobWindow(now());
    if (!jw.open) return gateClosed(jw.reason);
    const cfg = await loadCfg();
    const holidays = typeof loadHolidays === 'function' ? await loadHolidays() : [];
    const session = ccySession(now(), holidays);
    if (!session.open) return gateClosed(session.reason);

    const date = istParts(now()).date;
    const today = await store.tradesForDay(date);
    const open = await store.allOpenTrades();
    if (open.length) return { ran: true, entered: [] }; // one open trade per pair at a time (same convention as scalp_wide)
    let c5; let c15;
    try { [c5, c15] = await Promise.all([fx.candles5(pair), fx.candles15 ? fx.candles15(pair) : null]); } catch (e) { log(`[${label}] candles for ${pair} failed: ${e.message}`); return { ran: false, reason: 'candle fetch failed' }; }
    const a = analyseWide({ c5raw: c5, c15raw: c15 || aggregate(closedOnly(c5, FIVE, now())), now: now(), cfg, dayStartMs: istDayStart(now()) });
    if (!a.ok) { if (!a.quiet) await skip(a.reason, a.extra || {}); return { ran: true, entered: [] }; }
    const plan = a.plan;
    if (today.some((t) => t.trigger_t === plan.last.t)) return { ran: true, entered: [] }; // this candle already traded
    const size = sizeLots({ capitalInr: cfg.capital_inr, riskPct: cfg.risk_pct, stopPct: plan.stopPct, freeCashInr: cfg.capital_inr, price: plan.entry, pairs: 1, lotUnits: cfg.lot_units });
    if (!size) { await skip('no free virtual INR balance (or price too small for 1 lot)', { shadowPlan: { direction: plan.long ? 'LONG' : 'SHORT', entry_price: plan.entry, sl_price: plan.stopPrice, target_price: plan.targetPrice, trigger_t: plan.last.t } }); return { ran: true, entered: [] }; }
    const row = {
      symbol: pair, trade_date: date, status: 'open', direction: plan.long ? 'LONG' : 'SHORT',
      trigger_t: plan.last.t, entry_price: plan.entry, entry_time: new Date(now()).toISOString(), qty: size.qty,
      sl_price: plan.stopPrice, target_price: plan.targetPrice, stop_type: plan.stopType, target_type: plan.targetType, rr: plan.rr,
      basis: `${label} LONG/SHORT from scalp_wide (5-min entry, 15-min trend, VWAP + ATR stop): ${plan.hits.map((h) => h.name).join(', ')}; target ${plan.targetType}, stop ${plan.stopType}; lots ${size.lots} (${cfg.lot_units} units/lot).`,
    };
    const id = await store.insertTrade(row);
    if (id == null) return { ran: true, entered: [] }; // restart safety: duplicate of this exact candle
    log(`[${label}] PAPER entry ${pair} ${row.direction} @ ${plan.entry}: lots ${size.lots}; target ${plan.targetPrice}, stop ${plan.stopPrice}, R ${plan.rr}`);
    return { ran: true, entered: [pair] };
  }

  async function monitor() {
    const jw = ccyJobWindow(now());
    if (!jw.open) { await resolveShadows(); return { checked: 0, closed: 0 }; }
    const open = await store.allOpenTrades();
    if (!open.length) { await resolveShadows(); return { checked: 0, closed: 0 }; }
    const cfg = await loadCfg();
    let closed = 0;
    for (const t of open) {
      let c5;
      try { c5 = await fx.candles5(pair); } catch (e) { log(`[${label}] candles for ${pair} failed: ${e.message}`); continue; }
      const ev = evaluateExit({ trade: t, candles: closedOnly(c5, FIVE, now()), nowMs: now(), cfg });
      if (!ev.exit) continue;
      const s = settleInr({ trade: t, exitPrice: ev.price, cfg });
      await store.updateTrade(t.id, { status: 'closed', exit_price: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason, ...s });
      log(`[${label}] PAPER exit ${pair}: ${ev.reason}, net ₹${s.pnl_inr}`);
      closed += 1;
    }
    await resolveShadows();
    return { checked: open.length, closed };
  }

  async function backfillShadows() {
    const r = await resolveShadows();
    log(`[${label}] shadow backfill: ${r.resolved}/${r.checked}`);
    return r;
  }

  return { scan, monitor, backfillShadows };
}

module.exports = { createCurrencyBot };
