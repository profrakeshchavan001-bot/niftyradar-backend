'use strict';
/**
 * Task Group E (overnight brief): a per-day trade summary WEB PAGE.
 * GET /api/paper/daily-summary?key=<PAPER_ADMIN_SECRET>&date=YYYY-MM-DD, date optional, defaults to
 * today in IST (paperbot/time.js's istParts()). The owner explicitly asked for a WEB PAGE version of the
 * "daily summary" idea - a Telegram version already exists (paperbot/report.js's dailySummary(), sent at
 * 15:45/23:55) but that is Telegram-only, so this is a separate, read-only HTML/JSON route, not a
 * replacement for it.
 *
 * Pure data-gathering lives here (testable without Express); src/paper/ops/dailySummary/register.js wires
 * it to the route with the same cookie-secret auth every other /api/paper/ route uses.
 *
 * Data sources, all read-only, nothing new added to the store:
 *  - store.tradesForDay(market, date) for every market in ALL_MARKETS (same list paperbot/report.js's
 *    VARIANT_MARKETS and src/paper/ops/csvExport.js already combine into) - every trade TAKEN that day.
 *  - store.skipsSince(date, market) filtered to skip_date === date (skipsSince is ">= date", there is no
 *    "exact day" store method - the same filter src/paper/ops/csvExport.js and paperbot/report.js's own
 *    createReporter().daily() already apply) - every setup SKIPPED that day.
 *  - src/paper/decision/filterStrictness.js's tallyFilters()/categorize() for the top skip reasons - reused
 *    exactly as the overnight filter-strictness report uses it, not re-implemented here.
 *
 * Assumption logged, not asked about (owner said never stop to ask): "open trades" for a PAST date means
 * trades entered that date whose status is still 'open' right now (a trade's own row is updated in place
 * when it exits - sql/paper_bot.sql has no point-in-time history), i.e. the same filter works for "as of
 * now" (today) and "as of end-of-day" (a past date, where every trade from that day should already be
 * closed unless something is stuck open, which is itself worth surfacing, not hiding).
 */
const { istParts } = require('../../../../paperbot/time');
const { VARIANT_MARKETS } = require('../../../../paperbot/report');
const { tallyFilters } = require('../../decision/filterStrictness');

const ALL_MARKETS = ['nse', ...VARIANT_MARKETS.nse, 'crypto', ...VARIANT_MARKETS.crypto];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n) => Math.round(n * 100) / 100;
const pnlOf = (t) => (t.pnl_inr != null ? t.pnl_inr : 0);

/** Validates an optional ?date= against YYYY-MM-DD; returns today's IST date when omitted. Throws on a bad format. */
function resolveDate(rawDate, now = Date.now()) {
  if (rawDate == null || rawDate === '') return istParts(now).date;
  const date = String(rawDate);
  if (!DATE_RE.test(date)) throw new Error(`bad date "${date}", expected YYYY-MM-DD`);
  return date;
}

/** Gathers every trade taken and every setup skipped that day, across every bot in ALL_MARKETS. Read-only. */
async function buildDailySummary({ store, date, now = Date.now() }) {
  const resolved = resolveDate(date, now);
  const isToday = resolved === istParts(now).date;

  const perMarket = await Promise.all(ALL_MARKETS.map(async (market) => {
    const [trades, skipsFrom] = await Promise.all([
      store.tradesForDay(market, resolved),
      store.skipsSince(resolved, market),
    ]);
    const skips = skipsFrom.filter((s) => s.skip_date === resolved);
    return { market, trades, skips };
  }));

  const taken = perMarket.flatMap((m) => m.trades);
  const skips = perMarket.flatMap((m) => m.skips);
  const open = taken.filter((t) => t.status === 'open');
  const closed = taken.filter((t) => t.status === 'closed');
  const totalPnlInr = round2(closed.reduce((s, t) => s + pnlOf(t), 0));
  const wins = closed.filter((t) => pnlOf(t) > 0).length;
  const losses = closed.filter((t) => pnlOf(t) <= 0).length;
  const topSkipReasons = tallyFilters(skips).slice(0, 5);

  return {
    paperOnly: true,
    date: resolved,
    isToday,
    openAsOf: isToday ? 'now' : 'end of day (no later snapshot is stored; see file header)',
    generatedAt: new Date(now).toISOString(),
    taken, skips, open, closed,
    takenCount: taken.length, skipsCount: skips.length, openCount: open.length, closedCount: closed.length,
    wins, losses, totalPnlInr,
    topSkipReasons,
  };
}

module.exports = { buildDailySummary, resolveDate, ALL_MARKETS, pnlOf };
