'use strict';
// Generic MIRROR bot (docs/BOTS.md "Mirror bots"): wraps any original bot's OWN store/engine instead of
// re-deciding anything or duplicating its engine.js. For every trade the original bot has ever opened,
// sync() opens the matching mirror trade (same entry price/time and qty, opposite direction, target/stop
// swapped - src/paper/lib/mirror.js); once the original closes, sync() closes the mirror at the SAME
// exit price/time, using the ORIGINAL bot's own settle() with the mirror's inverted direction (same cost
// model, never a sign-flip hack). This one wrapper is reused by every bot's own <bot>_mirror/register.js
// (src/paper/bots/exhaustion_only_mirror, trend_smc_mirror, scalp_mirror) - nothing about any bot's
// engine.js is duplicated. The original bot keeps running completely unchanged: this never writes to
// `originalStore`, only reads it.
const { buildMirrorEntry, buildMirrorExitPatch } = require('./mirror');

function createMirrorBot({ originalStore, mirrorStore, settle, loadCfg, fxRateFallback = 88, log = console.log, label = 'mirror' }) {
  // Every trade the original bot has ever recorded, open + closed - a paper bot's own table, small
  // enough to read in full on every tick (the same assumption leaderboard/stats.js already makes).
  async function allOriginalTrades() {
    const [open, closed] = await Promise.all([originalStore.allOpenTrades(), originalStore.closedTrades()]);
    return [...open, ...closed];
  }

  // Opens a mirror trade for every original trade not mirrored yet, and closes every open mirror whose
  // original has since closed. Idempotent: insertTrade() is a no-op for an original_trade_id already
  // mirrored (unique index - the same restart-safety convention every other bot's (symbol, trigger_t)
  // index already gives it), and closing an already-closed mirror never happens (checked below).
  async function sync() {
    const originals = await allOriginalTrades();
    let opened = 0;
    let closed = 0;
    for (const o of originals) {
      if (o.id == null) continue;
      let mirrorRow = await mirrorStore.byOriginalId(o.id);
      if (!mirrorRow) {
        const id = await mirrorStore.insertTrade(buildMirrorEntry(o));
        if (id == null) continue; // raced with another sync tick for the same original trade
        opened += 1;
        log(`[${label}] MIRROR opened for original trade #${o.id} (${o.symbol} ${o.direction} -> opposite)`);
        mirrorRow = await mirrorStore.byOriginalId(o.id);
      }
      if (o.status === 'closed' && mirrorRow && mirrorRow.status !== 'closed') {
        const cfg = typeof loadCfg === 'function' ? await loadCfg() : (loadCfg || {});
        const patch = buildMirrorExitPatch({ mirrorTrade: mirrorRow, original: o, settleFn: settle, cfg, fxRateFallback });
        await mirrorStore.updateTrade(mirrorRow.id, patch);
        closed += 1;
        log(`[${label}] MIRROR closed for original trade #${o.id}: ${patch.exit_reason}, net ${patch.pnl_inr ?? patch.net_pnl_usdt ?? 'n/a'}`);
      }
    }
    return { opened, closed };
  }

  return { sync };
}

module.exports = { createMirrorBot };
