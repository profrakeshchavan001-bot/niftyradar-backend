'use strict';
/**
 * Round 3 item 3: the morning card at the top of GET /api/paper/home - since 18:00 IST yesterday, per bot:
 * trades, wins/losses in INR, number of skips and the top 3 skip reasons (explains why few trades happen).
 *
 * Covers only the bots whose trades live in paper_trades (ALL_MARKETS, same list as csvExport.js):
 * nse, nse_scalp, crypto, crypto_scalp, crypto_wide_scalp. exhaustion_only/trend_smc/mix keep their own
 * tables and report pages (see docs/decisions/CC4.md) and are NOT in this card - pulling them in would
 * need a cross-module store import this round didn't have time for; never guessed in.
 *
 * Honesty note on the time boundary: `paper_trades.entry_time` is a real timestamp, so the trade count is
 * exact. `paper_skips.skip_date` is a DATE only (no time of day - see sql/paper_bot.sql), so the skip count
 * is every skip from yesterday's date onward, not exactly from 18:00 - a few hours wider than asked. Said
 * plainly on the card itself, not hidden.
 */
const { istDayStart, istParts } = require('../../../paperbot/time');
const { groupSkipsByReason } = require('../../../paperbot/report');

const ALL_MARKETS = ['nse', 'nse_scalp', 'crypto', 'crypto_scalp', 'crypto_wide_scalp'];
const pnlOf = (t) => (t.pnl_inr != null ? t.pnl_inr : 0);

/** The ms timestamp of 18:00 IST on the IST calendar day before `now`. */
function sinceYesterday6pmIst(now) {
  return istDayStart(now) - 86400000 + 18 * 3600000;
}

/** Builds the card's data. Real counts only - a bot with nothing since the boundary is left out. */
async function buildMorningCard({ store, now = Date.now() }) {
  const boundary = sinceYesterday6pmIst(now);
  const yesterday = istParts(boundary).date;
  const today = istParts(now).date;

  const perBot = [];
  for (const market of ALL_MARKETS) {
    const [tYesterday, tToday, skipsFrom] = await Promise.all([
      store.tradesForDay(market, yesterday), store.tradesForDay(market, today), store.skipsSince(yesterday, market),
    ]);
    const trades = [...tYesterday, ...tToday].filter((t) => {
      const ms = new Date(t.entry_time).getTime();
      return Number.isFinite(ms) && ms >= boundary;
    });
    const skips = skipsFrom.filter((s) => s.skip_date >= yesterday); // date-only granularity, see file header
    if (!trades.length && !skips.length) continue;
    const closed = trades.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => pnlOf(t) > 0).length;
    const losses = closed.filter((t) => pnlOf(t) <= 0).length;
    const netInr = Math.round(closed.reduce((s, t) => s + pnlOf(t), 0) * 100) / 100;
    perBot.push({ bot: market, trades: trades.length, open: trades.length - closed.length, wins, losses, netInr, skips: skips.length, topSkipReasons: groupSkipsByReason(skips, 3) });
  }
  return { sinceIso: new Date(boundary).toISOString(), approxSkipWindow: true, perBot };
}

module.exports = { buildMorningCard, sinceYesterday6pmIst, ALL_MARKETS };
