'use strict';
// MIRROR trades (docs/BOTS.md "Mirror bots"): the exact opposite of an original bot's own trade, same
// entry price/time and qty, same fee/slippage model, but direction flipped and target/stop SWAPPED
// (mirror target = original's stop price, mirror stop = original's target price) - never a sign-flip
// hack on the P&L, always the bot's own settle() with the inverted direction so the cost model is
// identical. Pure functions only (docs/BOT-INTERFACE.md): no Date.now(), no network, no database.
// Used both live (src/paper/lib/mirrorBot.js) and for the historical backfill (scripts/mirrorBackfill.js).

const { resolveExitLevels } = require('./legacyExit');

// The legacy crypto fixed rule's own target_pct/stop_pct (paperbot/config.js DEFAULTS.crypto: 2 / 1) -
// the only bots that have a mirror today (docs/BOTS.md "Mirror bots") are crypto-denominated, and this
// is the one legacy rule any of their originals can predate (see legacyExit.js). A future mirror of a
// bot with a different legacy rule can pass its own targetPct/stopPct in `opts`.
const LEGACY_CRYPTO_TARGET_PCT = 2;
const LEGACY_CRYPTO_STOP_PCT = 1;

const DIRECTION_FLIP = { LONG: 'SHORT', SHORT: 'LONG', up: 'down', down: 'up', CALL: 'PUT', PUT: 'CALL' };
// target <-> stop swap at EXIT time: whichever barrier the original actually hit, the mirror hit the
// other one (same candle, same price - see docs/BOTS.md worked example). Any other reason
// (breakeven/breakeven_stop/time) describes HOW the original left, not WHICH barrier, so it is left as-is.
const REASON_FLIP = { target: 'stop', stop: 'target' };

function invertDirection(direction) {
  return DIRECTION_FLIP[direction] || direction;
}

function invertExitReason(reason) {
  return REASON_FLIP[reason] || reason;
}

// The OPEN mirror row for an original trade, live or during backfill - entry fields never change once a
// trade has opened, so this is safe to call again even after the original has since closed.
// `original` needs: id, symbol, direction, entry_price, entry_time, qty, trade_date, trigger_t, sl_price,
// target_price; stop_type/target_type/rr/basis are optional (used only for display).
//
// `original.sl_price`/`target_price` can themselves be null - a legacy trade opened before level-based
// exits existed (see src/paper/lib/legacyExit.js). Resolved via that one shared function FIRST, so the
// swap below always swaps two REAL numbers, never propagating a null (or reconstructing the mirror's own
// side independently, which - since the legacy rule's target_pct and stop_pct differ - would not equal
// the correct swap of the original's own numbers).
function buildMirrorEntry(original, { targetPct = LEGACY_CRYPTO_TARGET_PCT, stopPct = LEGACY_CRYPTO_STOP_PCT } = {}) {
  const levels = resolveExitLevels(original, { targetPct, stopPct });
  return {
    status: 'open',
    original_trade_id: original.id ?? null,
    symbol: original.symbol,
    trade_date: original.trade_date,
    trigger_t: original.trigger_t,
    direction: invertDirection(original.direction),
    entry_price: original.entry_price,
    entry_time: original.entry_time,
    qty: original.qty,
    // SWAPPED: the mirror's target is the ORIGINAL's (resolved, real) stop price, and its stop is the
    // original's (resolved, real) target.
    target_price: levels.stop,
    sl_price: levels.target,
    target_type: `MIRROR of the original's stop: ${original.stop_type || (levels.reconstructed ? 'legacy fixed % (reconstructed)' : 'n/a')}`,
    stop_type: `MIRROR of the original's target: ${original.target_type || (levels.reconstructed ? 'legacy fixed % (reconstructed)' : 'n/a')}`,
    rr: original.rr ?? null,
    be_moved: false,
    basis: `MIRROR of trade #${original.id ?? '?'}: the opposite side of the original, with its target and stop swapped. ${original.basis || ''}`.trim(),
  };
}

// The CLOSE patch for a mirror trade once its original has closed. Reuses the ORIGINAL bot's own
// settle({ trade, exitPrice, cfg, fxRate }) (src/paper/*/engine.js, never re-implemented here) with the
// mirror's already-inverted direction, so gross/net P&L comes from exactly the same formula and cost
// model as the real bot, with the sign flip coming only from the (correct) opposite direction - never a
// `pnl_inr * -1` shortcut. `mirrorTrade` is the still-open mirror row (buildMirrorEntry's own shape,
// so trade.direction/entry_price/qty are already the mirror's); `original` is the CLOSED original trade.
function buildMirrorExitPatch({ mirrorTrade, original, settleFn, cfg, fxRateFallback = 88 }) {
  const fxRate = original.fx_rate != null && Number(original.fx_rate) > 0 ? Number(original.fx_rate) : fxRateFallback;
  const s = typeof settleFn === 'function' ? settleFn({ trade: mirrorTrade, exitPrice: original.exit_price, cfg, fxRate }) : {};
  return {
    status: 'closed',
    exit_price: original.exit_price,
    exit_time: original.exit_time,
    exit_reason: invertExitReason(original.exit_reason),
    fx_rate: original.fx_rate ?? null,
    fx_source: original.fx_source ?? null,
    be_moved: original.be_moved ?? false,
    ...s,
  };
}

module.exports = {
  invertDirection, invertExitReason, buildMirrorEntry, buildMirrorExitPatch, DIRECTION_FLIP, REASON_FLIP,
  LEGACY_CRYPTO_TARGET_PCT, LEGACY_CRYPTO_STOP_PCT,
};
