'use strict';
// REVERSE trades (requested alongside MIRROR): same signal, same entry price/time/qty as the original,
// SAME direction as the mirror (opposite of the original) - but unlike MIRROR, which swaps the
// original's own target/stop (reward:risk ~0.3, needs an unrealistic ~88% win rate after fees), REVERSE
// gets its OWN, proper levels: stop at the distance of the ORIGINAL's own stop from entry (the same
// pattern high/low + ATR distance the original used), placed on the losing side of the reverse trade;
// target at 2x that distance, on the winning side. Reward:risk is always exactly 2.0, by construction.
// Pure functions only (docs/BOT-INTERFACE.md): no Date.now(), no network, no database. Used both live
// (src/paper/lib/reverseBot.js) and for the historical backfill (scripts/mirrorBackfill.js).
const { resolveExitLevels } = require('./legacyExit');
const { invertDirection } = require('./mirror'); // same direction flip MIRROR uses - REVERSE takes the mirror's own direction

const LEGACY_CRYPTO_TARGET_PCT = 2;
const LEGACY_CRYPTO_STOP_PCT = 1;

/**
 * The OPEN reverse row for an original trade, live or during backfill - entry fields never change once
 * opened, so this is safe to call again even after the original has since closed. `original` needs the
 * same fields buildMirrorEntry does (see src/paper/lib/mirror.js): id, symbol, direction, entry_price,
 * entry_time, qty, trade_date, trigger_t, sl_price, target_price (sl_price/target_price may be null for a
 * legacy pre-level-exits trade - resolved to real numbers via resolveExitLevels FIRST, same single fix
 * point mirror.js's buildMirrorEntry uses, so the stop distance below is always real).
 *
 * direction is the mirror's own direction (opposite of the original) - LONG/SHORT only for intraday and
 * scalp_wide (the two bots REVERSE exists for today); invertDirection also maps up/down and CALL/PUT for
 * completeness/consistency with mirror.js, though those markets have no REVERSE bot.
 */
function buildReverseEntry(original, { targetPct = LEGACY_CRYPTO_TARGET_PCT, stopPct = LEGACY_CRYPTO_STOP_PCT } = {}) {
  const levels = resolveExitLevels(original, { targetPct, stopPct });
  const direction = invertDirection(original.direction);
  const long = direction === 'LONG' || direction === 'up' || direction === 'CALL';
  const entry = Number(original.entry_price);
  // The ORIGINAL's own stop distance from its own entry - exactly the distance the original's pattern
  // high/low + ATR rule produced, never recomputed independently (that would not be "the distance of the
  // ORIGINAL's stop", it would be a fresh guess).
  const stopDistance = Math.abs(entry - Number(levels.stop));
  const targetDistance = stopDistance * 2; // reward:risk 2.0, by construction
  const stop = long ? entry - stopDistance : entry + stopDistance; // losing side of the REVERSE trade
  const target = long ? entry + targetDistance : entry - targetDistance; // winning side of the REVERSE trade
  return {
    status: 'open',
    original_trade_id: original.id ?? null,
    symbol: original.symbol,
    trade_date: original.trade_date,
    trigger_t: original.trigger_t,
    direction,
    entry_price: original.entry_price,
    entry_time: original.entry_time,
    qty: original.qty,
    target_price: target,
    sl_price: stop,
    target_type: `REVERSE: 2x the original's own stop distance (${stopDistance})`,
    stop_type: `REVERSE: same distance as the original's own stop${levels.reconstructed ? ' (legacy fixed % (reconstructed))' : original.stop_type ? ` (${original.stop_type})` : ''}`,
    rr: 2,
    be_moved: false,
    basis: `REVERSE of trade #${original.id ?? '?'}: same direction as the MIRROR (opposite of the original), own stop at the original's stop distance, target at 2x that distance (reward:risk 2.0). ${original.basis || ''}`.trim(),
  };
}

/**
 * Backfill-only, honest approximation of a REVERSE trade's exit from the ORIGINAL's own already-closed
 * row - no candle history is stored anywhere in this schema, so the live, candle-accurate monitor
 * (src/paper/lib/reverseBot.js's monitor()) cannot be run retroactively; this is the best a single stored
 * {entry, exit_price, exit_reason} row can honestly support, never a guess beyond what the numbers prove:
 *
 *  - If the original's OWN exit_reason was 'target' (it won), the price moved by the original's own
 *    target distance AGAINST the reverse trade's direction. The original bot's own reward:risk is always
 *    >= 1 (every bot's analyse()/planTrade() refuses a trade below its own min_rr floor), so the
 *    original's target distance is always >= its own stop distance - and the reverse trade's stop is
 *    placed at EXACTLY that stop distance. So hitting the original's target GUARANTEES the reverse trade
 *    had already crossed its own stop by that point (by the intermediate value theorem: a monotone-enough
 *    price path from entry to a point beyond the stop distance must cross the stop level on the way) -
 *    this is the one case fully provable from a single stored row. Returns a closed 'stop'.
 *  - Any other original exit_reason ('stop', 'breakeven', 'breakeven_stop', 'time') leaves the reverse
 *    side's own target (2x the stop distance, same side as the original's OWN stop) unreached by anything
 *    this one stored point proves - the reverse trade may already have continued well past its own entry
 *    by then, but nothing in the original's row says how far. Returns null (left OPEN, not force-closed
 *    with an invented number) UNLESS the original's own exit_price has, by itself, already cleared the
 *    reverse trade's 2x target or 1x stop threshold (checked directly, never assumed).
 *
 * `reverseEntry` is this trade's own buildReverseEntry() output (direction/entry_price/target_price/
 * sl_price already resolved - never re-derives them). Returns `{ status: 'closed', exit_price,
 * exit_time, exit_reason, estimated: true }` or `null` (stays open).
 *
 * Root-cause fix (backfill bug report: REVERSE exits "never arrived" for some bots): the checks above
 * alone only ever resolve an original that won (exit_reason 'target') or one whose single exit POINT
 * happens to already clear a 2x/1x threshold - a bot whose trades mostly end in 'stop'/'time' (so neither
 * holds) left EVERY one of its reverse rows open forever, even though the original's own stored row
 * already proves more than that: every trade (paperbot/bot.js, src/paper/scalp/bot.js) also tracks
 * max_fav_pct/max_adv_pct - the furthest the price ever moved in/against the ORIGINAL's own favor during
 * its whole life, not just where it finally closed. REVERSE sits at the exact same entry price but the
 * OPPOSITE direction, so its own excursions are the original's with the sign flipped: the furthest REVERSE
 * ever moved in its own favor is -(the original's worst move), and the furthest it moved against itself is
 * -(the original's best move). Whichever one of REVERSE's own thresholds this PROVES was crossed (and only
 * one of them - both or neither is still genuinely ambiguous, never guessed) is its real exit.
 */
function estimateReverseExit(original, reverseEntry) {
  const entry = Number(reverseEntry.entry_price);
  const stopDistance = Math.abs(entry - Number(reverseEntry.sl_price));
  const targetDistance = stopDistance * 2;
  if (!(stopDistance > 0) || !Number.isFinite(targetDistance)) return null;
  const favPct = Number(original.max_fav_pct);
  const advPct = Number(original.max_adv_pct);
  if (Number.isFinite(favPct) && Number.isFinite(advPct)) {
    const reverseFavDistance = entry * Math.max(0, -advPct) / 100; // furthest price moved in REVERSE's own favor
    const reverseAdvDistance = entry * Math.max(0, favPct) / 100; // furthest price moved against REVERSE
    const hitTarget = reverseFavDistance >= targetDistance;
    const hitStop = reverseAdvDistance >= stopDistance;
    if (hitTarget && !hitStop) return { status: 'closed', exit_price: reverseEntry.target_price, exit_time: original.exit_time, exit_reason: 'target', estimated: true };
    if (hitStop && !hitTarget) return { status: 'closed', exit_price: reverseEntry.sl_price, exit_time: original.exit_time, exit_reason: 'stop', estimated: true };
  }
  if (original.exit_reason === 'target') {
    return { status: 'closed', exit_price: reverseEntry.sl_price, exit_time: original.exit_time, exit_reason: 'stop', estimated: true };
  }
  const exitPrice = Number(original.exit_price);
  if (!Number.isFinite(exitPrice)) return null;
  const long = reverseEntry.direction === 'LONG';
  const moveInReverseFavor = long ? exitPrice - entry : entry - exitPrice;
  if (moveInReverseFavor >= targetDistance) return { status: 'closed', exit_price: reverseEntry.target_price, exit_time: original.exit_time, exit_reason: 'target', estimated: true };
  if (moveInReverseFavor <= -stopDistance) return { status: 'closed', exit_price: reverseEntry.sl_price, exit_time: original.exit_time, exit_reason: 'stop', estimated: true };
  return null; // genuinely inconclusive from every stored signal - left open rather than guessed
}

module.exports = { buildReverseEntry, estimateReverseExit, LEGACY_CRYPTO_TARGET_PCT, LEGACY_CRYPTO_STOP_PCT };
