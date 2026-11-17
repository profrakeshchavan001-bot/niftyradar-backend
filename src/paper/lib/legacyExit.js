'use strict';
// Single reconstruction point for a trade's REAL target/stop price when its own row predates
// level-based exits and stores target_price/sl_price as null. paperbot/bot.js's cryptoMonitor has this
// exact documented legacy path: "a trade opened before level-based exits existed: it finishes on the
// fixed rule it was opened with" - the shared paper_trades table's sl_price/target_price columns are
// nullable (added by an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, sql/paper_bot.sql), so any row
// inserted before that column existed has null there forever; it is never backfilled.
//
// Reused by BOTH:
//  - src/paper/ops/telegramAlerts/format.js, to show a real reconstructed price instead of the literal
//    word "null", or (far worse) silently treating the missing level as "price fell/rose all the way to
//    zero" - the Nov 2026 incident: estimateMove()'s `Number(null)` coerced to 0, so `distance` became
//    `Math.abs(0 - entryPrice) = entryPrice`, inflating the shown implied risk by ~40-150x (qty x
//    entry_price x fx, i.e. a ~100%-of-entry-price move) and collapsing both target and stop distance to
//    the same magnitude, which is also why the shown reward:risk was a meaningless 1.00.
//  - src/paper/lib/mirror.js's buildMirrorEntry, which must resolve the ORIGINAL trade's real levels
//    BEFORE swapping them for the mirror - swapping two nulls only produces two more nulls, and (because
//    the legacy rule's target_pct != stop_pct) reconstructing the MIRROR independently, as if it were a
//    fresh trade in its own (flipped) direction, would NOT equal the correct swap of the original's own
//    reconstructed numbers. So the original must be resolved first, every time, by this one function.
//
// Pure (docs/BOT-INTERFACE.md): no Date.now(), no network, no database. targetPct/stopPct are passed in
// by the caller rather than read from config here - the legacy fixed rule is frozen for any trade that
// already used it (paperbot/config.js's DEFAULTS.crypto.target_pct/stop_pct are kept "only for the A/B
// columns ... never used for an exit"), so a caller's own baked-in default for ITS bot is the correct,
// stable source, never a live config read from this pure module.
const { legacyLevels } = require('./levels');

// Direction spellings seen across this codebase's trade rows that mean "short" for the legacy formula's
// sign (crypto: LONG/SHORT: NSE options: CALL/PUT; paperbot's own internal candidate shape: up/down).
const SHORT_DIRECTIONS = new Set(['SHORT', 'PUT', 'down']);

/**
 * { target, stop, reconstructed } for one trade row.
 *
 * Uses the trade's own stored target_price/sl_price when BOTH are present (the normal, level-based
 * case - completely untouched, including every mid-trade breakeven move, which only ever touches
 * stop_active, never sl_price/target_price themselves). Reconstructs BOTH from entry_price + direction
 * + the legacy fixed-% rule only when EITHER is missing, so a resolved trade is never a mix of one real,
 * level-based number and one guessed number (the two plans are not compatible with each other).
 *
 * Returns the stored (possibly still-null) values unreconstructed when entry_price, targetPct or
 * stopPct is not a finite number - never a guess built on a non-number.
 */
function resolveExitLevels(trade, { targetPct, stopPct } = {}) {
  const storedTarget = trade.target_price != null && Number.isFinite(Number(trade.target_price)) ? Number(trade.target_price) : null;
  const storedStop = trade.sl_price != null && Number.isFinite(Number(trade.sl_price)) ? Number(trade.sl_price) : null;
  if (storedTarget != null && storedStop != null) return { target: storedTarget, stop: storedStop, reconstructed: false };

  // `Number(null)` is 0, not NaN - never trust that coercion for "is there really an entry price here"
  // (the exact class of bug this file exists to avoid at the display layer). Only a genuinely finite,
  // non-null entry_price/pct may be used to reconstruct a price.
  if (trade.entry_price == null) return { target: storedTarget, stop: storedStop, reconstructed: false };
  const entry = Number(trade.entry_price);
  if (!Number.isFinite(entry) || !Number.isFinite(Number(targetPct)) || !Number.isFinite(Number(stopPct))) {
    return { target: storedTarget, stop: storedStop, reconstructed: false };
  }
  // Matches paperbot/bot.js's cryptoMonitor EXACTLY: `if (t.target_price == null || t.stop_active ==
  // null)` reverts the WHOLE trade to the old fixed rule, even if the OTHER of the pair happens to be
  // non-null - never blending one real, level-based number with one guessed number. So when either is
  // missing, BOTH are reconstructed from the legacy rule here too, discarding any partially-stored value.
  const short = SHORT_DIRECTIONS.has(trade.direction);
  const legacy = legacyLevels({ entry, short, targetPct: Number(targetPct), stopPct: Number(stopPct) });
  return { target: legacy.target, stop: legacy.stop, reconstructed: true };
}

module.exports = { resolveExitLevels, SHORT_DIRECTIONS };
