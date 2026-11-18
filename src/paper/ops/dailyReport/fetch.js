'use strict';
/**
 * Daily Telegram report (05:00 IST): data gathering only, no text, no Telegram. Reuses the exact same
 * stores every other report/leaderboard already reads - nothing new added to any bot's schema.
 *
 * Every row read here for an own-table bot goes through castNumericColumns (src/paper/lib/numericCast.js,
 * same shared TRADE_NUMERIC_COLUMNS list src/paper/bots/leaderboard/register.js's queryClosed() and
 * src/paper/lib/mcxStore.js use): node-pg returns NUMERIC/DECIMAL columns as STRINGS, and this report's
 * INR totals must be real numbers, not string concatenation or NaN.
 */
const { castNumericColumns } = require('../../lib/numericCast');

// Bot (table name is `${bot}_trades`) -> the ctx key its own register.js sets for the no-pool
// (memory/test) fallback - the exact same keys src/paper/bots/leaderboard/register.js's
// closedTradesByBot() already uses ("the 'Memory' in the name is historical, not a guarantee": it holds
// the real store either way).
const OWN_TABLE_BOTS = {
  exhaustion_only: 'exhaustionMemoryStore', exhaustion_only_mirror: 'exhaustionMirrorMemoryStore',
  trend_smc: 'trendSmcMemoryStore', trend_smc_mirror: 'trendSmcMirrorMemoryStore',
  scalp_mirror: 'scalpMirrorMemoryStore', scalp_wide_mirror: 'scalpWideMirrorMemoryStore',
  intraday_mirror: 'intradayMirrorMemoryStore',
  ccy_usdinr: 'ccyUsdinrMemoryStore', ccy_usdinr_mirror: 'ccyUsdinrMirrorMemoryStore',
  ccy_eurinr: 'ccyEurinrMemoryStore', ccy_eurinr_mirror: 'ccyEurinrMirrorMemoryStore',
  ccy_gbpinr: 'ccyGbpinrMemoryStore', ccy_gbpinr_mirror: 'ccyGbpinrMirrorMemoryStore',
  ccy_jpyinr: 'ccyJpyinrMemoryStore', ccy_jpyinr_mirror: 'ccyJpyinrMirrorMemoryStore',
  mcx_gold: 'mcxGoldMemoryStore', mcx_gold_mirror: 'mcxGoldMirrorMemoryStore',
  mcx_crude: 'mcxCrudeMemoryStore', mcx_crude_mirror: 'mcxCrudeMirrorMemoryStore',
  // REVERSE bots (this task): own table, same ctx-key convention as every mirror above - set by each
  // <bot>_reverse/register.js (src/paper/bots/intraday_reverse, scalp_wide_reverse).
  intraday_reverse: 'intradayReverseMemoryStore', scalp_wide_reverse: 'scalpWideReverseMemoryStore',
  // research_* (CC2, this task): demo bots for the PASS-verdict research strategies
  // (docs/RESEARCH-STRATEGIES-REPORT.md) - own tables, same ctx-key convention as every bot above.
  research_usdinr_trend: 'researchUsdinrTrendMemoryStore',
  research_btc_momentum: 'researchBtcMomentumMemoryStore',
  research_nifty200_52whigh: 'researchN20052whMemoryStore',
  // confluence / confluence_flow (Bots A/B, a different task): own tables, own ctx-key convention as
  // every bot above - set by src/paper/bots/confluence/register.js and src/paper/bots/confluence_flow/register.js.
  confluence: 'confluenceMemoryStore',
  confluence_flow: 'confluenceFlowMemoryStore',
  // nse-MIRROR / nse-REVERSE (Group 4, this task, src/paper/lib/nseOptionSide.js): own tables, same
  // ctx-key convention as every bot above. NOT wired into MIRROR_OF/REVERSE_OF below, because 'nse' is
  // not its own key in tradesByBot() (it is merged into the 'intraday' bucket together with the crypto
  // market, a pre-existing convention this task did not touch) - their own report routes
  // (/api/paper/nse-mirror-report, /api/paper/nse-reverse-report) and Telegram alerts are unaffected.
  nse_mirror: 'nseMirrorMemoryStore', nse_reverse: 'nseReverseMemoryStore',
};

// Original -> mirror bot name, for the "overall status" section (requirement 5: original vs mirror per bot).
const MIRROR_OF = {
  intraday: 'intraday_mirror', scalp: 'scalp_mirror', scalp_wide: 'scalp_wide_mirror',
  exhaustion_only: 'exhaustion_only_mirror', trend_smc: 'trend_smc_mirror',
  mcx_gold: 'mcx_gold_mirror', mcx_crude: 'mcx_crude_mirror',
  ccy_usdinr: 'ccy_usdinr_mirror', ccy_eurinr: 'ccy_eurinr_mirror',
  ccy_gbpinr: 'ccy_gbpinr_mirror', ccy_jpyinr: 'ccy_jpyinr_mirror',
};

// Original -> reverse bot name (this task: requirement 5, the 3-way original/MIRROR/REVERSE breakdown).
// Only intraday and scalp_wide have a REVERSE bot, as asked - every other original is simply absent here.
const REVERSE_OF = { intraday: 'intraday_reverse', scalp_wide: 'scalp_wide_reverse' };

async function ownTableRows(ctx, bot, status) {
  const { pool } = ctx;
  if (pool) {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${bot}_trades WHERE status = $1 ORDER BY id`, [status]);
      return rows.map((r) => castNumericColumns(r));
    } catch (e) { return []; } // table not there yet (bot disabled / fresh database) - empty, never an error
  }
  const store = ctx[OWN_TABLE_BOTS[bot]];
  if (!store) return [];
  try {
    if (status === 'open') return store.allOpenTrades ? await store.allOpenTrades() : [];
    return await store.closedTrades();
  } catch (e) { return []; }
}

/** Every bot's trades of one status ('open' | 'closed'), keyed by bot name - see docs/BOTS.md for the full bot list. */
async function tradesByBot(ctx, status) {
  const { store: mainStore } = ctx;
  let intraday; let scalp; let scalp_wide;
  if (status === 'open') {
    const [nse, crypto] = await Promise.all([mainStore.openTrades('nse'), mainStore.openTrades('crypto')]);
    intraday = [...nse, ...crypto];
    [scalp, scalp_wide] = await Promise.all([mainStore.openTrades('crypto_scalp'), mainStore.openTrades('crypto_wide_scalp')]);
  } else {
    [intraday, scalp, scalp_wide] = await Promise.all([
      mainStore.closedTrades(null), mainStore.closedTrades('crypto_scalp'), mainStore.closedTrades('crypto_wide_scalp'),
    ]);
  }
  const ownNames = Object.keys(OWN_TABLE_BOTS);
  const ownRows = await Promise.all(ownNames.map((b) => ownTableRows(ctx, b, status)));
  return { intraday, scalp, scalp_wide, ...Object.fromEntries(ownNames.map((b, i) => [b, ownRows[i]])) };
}

const closedTradesByBot = (ctx) => tradesByBot(ctx, 'closed');
const openTradesByBot = (ctx) => tradesByBot(ctx, 'open');

module.exports = { closedTradesByBot, openTradesByBot, MIRROR_OF, REVERSE_OF, OWN_TABLE_BOTS };
