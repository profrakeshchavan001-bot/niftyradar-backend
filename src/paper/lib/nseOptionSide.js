'use strict';
// nse-MIRROR / nse-REVERSE (Group 4, 2026-11). Every other MIRROR/REVERSE bot in this repo flips
// direction on the SAME price series (a stock or a crypto coin), so "swap the original's own two
// numbers" (src/paper/lib/mirror.js) or "same distance as the original's own stop" (src/paper/lib/
// reverse.js) are well-defined on that one series. An NSE trade's "opposite side" is a DIFFERENT option
// CONTRACT (CALL -> PUT or back) with its OWN real premium - there is no single price to swap across two
// different contracts, so this module does not reuse buildMirrorEntry/buildReverseEntry. Documented,
// deliberate divergence - see docs/BOTS.md.
//
// Both sides, alike:
//  - open as soon as sync() sees a new, REAL-priced ('dhan_option_chain_ltp'; never 'simulated_option')
//    original 'nse' trade not yet opened on this side, using the REAL CURRENT premium of the OPPOSITE
//    option type at the SAME strike/expiry (nse.optionQuote - the exact Dhan option-chain call Group 2
//    uses for the original). If no real quote is available right now, this sync tick simply does not
//    open it - retried on the next tick, never on a simulated/derived number.
//  - run their OWN monitor (no candle history needed - same idea as paperbot/bot.js's own nseMonitor):
//    a fresh nse.optionQuote each tick, checked with the SAME E.evaluateExit() the original NSE bot
//    already uses, plus the SAME force-exit-time rule (cfg.nse.force_exit_ist) - never a different exit
//    rule. If the forced-exit time has passed but no real quote is available right now, the trade is
//    simply left open and rechecked next tick (force stays true) - this never force-closes on a guessed
//    price, unlike paperbot/bot.js's own simulated-delta fallback (Group 2's whole point for this side).
//
// Only where the two sides differ:
//  - nse-MIRROR's target/stop apply the SAME target_pct/stop_pct the live nse config already uses,
//    to its OWN entry premium (the "mirror" is being on the opposite contract, not swapping two
//    premiums that belong to two different contracts).
//  - nse-REVERSE's stop is at the DISTANCE (in rupees) of the ORIGINAL's own stop from the original's
//    own entry premium, target is 2x that distance, both applied to the reverse's OWN entry premium -
//    reward:risk exactly 2.0 by construction, the same idea as src/paper/lib/reverse.js.
// qty is always a straight copy of the original's own qty (same number of lots), per the "same qty as
// the original" convention every MIRROR/REVERSE bot in this repo follows.
const E = require('../../../paperbot/engine');
const { istParts, toMinutes, nseJobWindow } = require('../../../paperbot/time');
const { loadConfig } = require('../../../paperbot/config');

const round = (n, d = 2) => { const m = 10 ** d; return Math.round((n + Number.EPSILON) * m) / m; };

const invertType = (direction) => (direction === 'CALL' ? 'PUT' : 'CALL');
const invertRawDir = (direction) => (direction === 'CALL' ? 'down' : 'up'); // nse.optionQuote's own 'up'/'down' direction arg

// Original row's own instrument string, e.g. "RELIANCE 2026-11-26 1300 CE" (paperbot/bot.js's tradeRow()).
function parseInstrument(instrument) {
  const parts = String(instrument || '').split(' ');
  return { expiry: parts[1], strike: parseFloat(parts[2]) };
}

function createNseSideBot({ mainStore, sideStore, nse, mode, log = console.log, now = Date.now, label }) {
  if (mode !== 'mirror' && mode !== 'reverse') throw new Error(`createNseSideBot: unknown mode ${mode}`);

  async function eligibleOriginals() {
    const [open, closed] = await Promise.all([mainStore.openTrades('nse'), mainStore.closedTrades('nse')]);
    // Never open a side-trade for an original that itself has no real Dhan price (pre-Group-2 legacy
    // rows, or a rare race where the quote vanished between entry and now) - the whole point of this
    // task is to never simulate the mirror/reverse side while the original uses a real one.
    return [...open, ...closed].filter((o) => o.simulated_option === false && o.instrument);
  }

  async function sync() {
    const jobWindow = nseJobWindow(now());
    if (!jobWindow.open) return { opened: 0, ran: false, reason: jobWindow.reason };
    const originals = await eligibleOriginals();
    const cfg = (await loadConfig(mainStore)).nse;
    let opened = 0;
    for (const o of originals) {
      if (o.id == null) continue;
      if (await sideStore.byOriginalId(o.id)) continue;
      const { expiry, strike } = parseInstrument(o.instrument);
      if (!expiry || !Number.isFinite(strike)) continue;
      const type = invertType(o.direction);
      let q;
      try { q = await nse.optionQuote(o.symbol, invertRawDir(o.direction), { expiry, strike }); } catch (e) { log(`[${label}] option price for ${o.symbol} failed (${e.message}); will retry`); continue; }
      if (!q || !(q.ltp > 0)) continue; // no real price right now - never simulated, retried next tick
      const premium = q.ltp;
      let target; let stop; let basis;
      if (mode === 'mirror') {
        target = round(premium * (1 + cfg.target_pct / 100));
        stop = round(premium * (1 - cfg.stop_pct / 100));
        basis = `nse-MIRROR of trade #${o.id}: opposite option (${type} ${expiry} ${strike}), real Dhan premium at open (Rs ${premium}), same ${cfg.target_pct}% target / ${cfg.stop_pct}% stop rule as the original - a different contract has its own premium, so there is no single number to swap (docs/BOTS.md).`;
      } else {
        const origStopDistance = Math.abs(Number(o.entry_price) - Number(o.sl_price));
        const targetDistance = origStopDistance * 2;
        target = round(premium + targetDistance);
        stop = round(Math.max(0.05, premium - origStopDistance));
        basis = `nse-REVERSE of trade #${o.id}: same direction as nse-MIRROR (opposite option ${type} ${expiry} ${strike}), own stop at the original's own stop distance (Rs ${round(origStopDistance)}), target at 2x that (reward:risk 2.0).`;
      }
      const id = await sideStore.insertTrade({
        original_trade_id: o.id, symbol: o.symbol, trade_date: o.trade_date, status: 'open',
        direction: type, instrument: `${o.symbol} ${expiry} ${strike} ${type}`, strike, expiry,
        qty: o.qty, entry_price: premium, entry_underlying: q.spot ?? null, entry_time: new Date(now()).toISOString(),
        sl_price: stop, target_price: target, price_source: 'dhan_option_chain_ltp', basis,
        max_fav_pct: 0, max_adv_pct: 0,
      });
      if (id == null) continue; // raced with another sync tick for the same original
      opened += 1;
      log(`[${label}] opened for original trade #${o.id} (${o.symbol} ${type} @ ${premium})`);
    }
    return { opened, ran: true };
  }

  async function monitor() {
    const jobWindow = nseJobWindow(now());
    if (!jobWindow.open) return { checked: 0, ran: false, reason: jobWindow.reason };
    const open = await sideStore.allOpenTrades();
    if (!open.length) return { checked: 0, ran: true };
    const cfg = (await loadConfig(mainStore)).nse;
    const p = istParts(now());
    let closed = 0;
    for (const t of open) {
      const force = p.minutes >= toMinutes(cfg.force_exit_ist) ? `time_exit_${cfg.force_exit_ist}` : null;
      const rawDir = t.direction === 'CALL' ? 'up' : 'down';
      let q;
      try { q = await nse.optionQuote(t.symbol, rawDir, { expiry: t.expiry, strike: t.strike }); } catch (e) { log(`[${label}] option price for ${t.symbol} failed (${e.message})`); continue; }
      if (!q || !(q.ltp > 0)) {
        if (force) log(`[${label}] ${t.symbol} trade #${t.id}: past the force-exit time but no real option price yet - staying open, will retry`);
        continue; // never force-closed on a guessed price
      }
      const price = q.ltp;
      const targetPct = (t.target_price - t.entry_price) / t.entry_price * 100;
      const stopPct = (t.entry_price - t.sl_price) / t.entry_price * 100;
      const r = E.evaluateExit({ entry: t.entry_price, current: price, targetPct, stopPct, forceReason: force });
      if (r.exit) {
        const pnlInr = round((price - t.entry_price) * t.qty);
        await sideStore.updateTrade(t.id, {
          status: 'closed', exit_price: price, exit_time: new Date(now()).toISOString(), exit_underlying: q.spot ?? null,
          exit_reason: r.reason, pnl_inr: pnlInr,
          max_fav_pct: round(Math.max(t.max_fav_pct || 0, r.pct)), max_adv_pct: round(Math.min(t.max_adv_pct || 0, r.pct)),
        });
        closed += 1;
        log(`[${label}] closed for trade #${t.id} (${t.symbol}): ${r.reason}, pnl Rs ${pnlInr}`);
      } else {
        await sideStore.updateTrade(t.id, { max_fav_pct: round(Math.max(t.max_fav_pct || 0, r.pct)), max_adv_pct: round(Math.min(t.max_adv_pct || 0, r.pct)) });
      }
    }
    return { checked: open.length, closed, ran: true };
  }

  return { sync, monitor, eligibleOriginals };
}

module.exports = { createNseSideBot, invertType, invertRawDir, parseInstrument, round };
