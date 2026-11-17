'use strict';
/**
 * Pure formatting for the mirror-backfill Telegram report (src/paper/ops/mirrorBackfillReport/).
 * Takes the exact row shape scripts/mirrorBackfill.js's runJob() already produces - one object per bot:
 *   { bot, mirrorLabel, opened, closedThisRun, original: { trades, netPnlInr, grossPnlInr, feesInr, winRatePct }, mirror: {...same} }
 * and turns it into Telegram-ready text. No I/O, no clock (generatedAt is passed in, never read here), no
 * database - deterministic and easy to unit-test with fixture rows (test/mirrorBackfillReport.test.js).
 *
 * No parse_mode is used when this text is actually sent (register.js): bot names like "exhaustion_only"
 * contain underscores, which Telegram's legacy Markdown mode treats as italics and can reject outright -
 * the exact same plain-text convention src/paper/ops/telegramAlerts/format.js already uses.
 */
const TELEGRAM_MESSAGE_LIMIT = 4096;

const inr = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const pct = (v) => (v == null ? 'n/a' : `${v}%`);
const inrPlain = (v) => (v == null ? 'n/a' : `₹${Math.round(v).toLocaleString('en-IN')}`); // a plain amount, never signed (capital, not P&L)

/**
 * One bot's block of text. A bot with ZERO trades on both sides (original and mirror) reads "no trades
 * yet" instead of a blank/NaN-filled block - e.g. a bot added after the backfill ran, or one that has not
 * closed a single trade. A bot with trades on only one side (should not normally happen - sync() mirrors
 * every original trade - but is handled the same safe way by computeBotStats, which already turns an
 * empty array into trades: 0, winRatePct: null, netPnlInr: 0, never NaN) still prints its real numbers.
 *
 * Capital (Task: add capital to this report - it never showed any before): each side's currently-locked
 * capital (open trades' own entry_price x qty, each converted via its own fx_rate) against that bot's own
 * configured total (scripts/mirrorBackfill.js's sideSummary()/computeCapitalState()) - "n/a" rather than
 * 0 when there is no USDINR_FALLBACK rate to express it in rupees with, never a guessed number.
 */
function botBlock(row) {
  const { bot, mirrorLabel, original, mirror } = row;
  if (!original.trades && !mirror.trades) {
    return `${bot} (mirror: ${mirrorLabel})\nno trades yet`;
  }
  return [
    `${bot} (mirror: ${mirrorLabel})`,
    `Trades: ${original.trades} original, ${mirror.trades} mirror`,
    `PnL: original ${inr(original.netPnlInr)}, mirror ${inr(mirror.netPnlInr)}`,
    `Win rate: original ${pct(original.winRatePct)}, mirror ${pct(mirror.winRatePct)}`,
    `Fees: original ${inr(original.feesInr)}, mirror ${inr(mirror.feesInr)}`,
    `Capital used: original ${inrPlain(original.capitalUsedInr)} of ${inrPlain(original.capitalTotalInr)}, mirror ${inrPlain(mirror.capitalUsedInr)} of ${inrPlain(mirror.capitalTotalInr)}`,
  ].join('\n');
}

/**
 * "Best bot" = the bot whose COMBINED original+mirror net INR P&L is the highest (stated in the line
 * itself, so the metric is never ambiguous to whoever reads the Telegram message). A bot with no trades
 * at all on either side is never eligible (there is nothing to rank); if literally no bot has any trades,
 * says so instead of naming an arbitrary "winner".
 */
function bestBotLine(rows) {
  const ranked = rows
    .map((r) => ({ bot: r.bot, combined: (r.original.netPnlInr || 0) + (r.mirror.netPnlInr || 0), hasTrades: r.original.trades > 0 || r.mirror.trades > 0 }))
    .filter((r) => r.hasTrades)
    .sort((a, b) => b.combined - a.combined);
  if (!ranked.length) return 'Best bot: n/a (no bot has any trades yet)';
  const top = ranked[0];
  return `Best bot: ${top.bot} (highest combined original+mirror net P&L: ${inr(top.combined)})`;
}

/**
 * The ordered list of text blocks making up the full report: one intro header, one block per bot (in the
 * order given), and the best-bot line last. Each block is kept deliberately small so packIntoMessages()
 * below can group them into 2-3 Telegram messages without ever cutting a bot's own block in half.
 */
function buildReportBlocks(rows, { generatedAt } = {}) {
  const header = [
    'Mirror backfill report',
    `Generated: ${generatedAt || new Date().toISOString()}`,
    'Every closed trade of every bot replayed as its MIRROR (opposite side) - no sampling.',
  ].join('\n');
  return [header, ...rows.map(botBlock), bestBotLine(rows)];
}

/**
 * Greedily packs blocks (in the given order) into messages of at most `limit` characters each, joining
 * consecutive blocks in the same message with a blank line. Never reorders and never splits a block
 * across two messages - a single block that is itself over the limit (should not happen with the small
 * per-bot blocks above) is sent alone, truncated to `limit` as a last resort rather than silently dropped.
 */
function packIntoMessages(blocks, limit = TELEGRAM_MESSAGE_LIMIT) {
  const messages = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) messages.push(current);
    current = block.length <= limit ? block : '';
    if (block.length > limit) messages.push(block.slice(0, limit));
  }
  if (current) messages.push(current);
  return messages;
}

/** Full pipeline: rows -> blocks -> packed Telegram messages (what register.js actually sends). */
function buildTelegramMessages(rows, { generatedAt } = {}, limit = TELEGRAM_MESSAGE_LIMIT) {
  return packIntoMessages(buildReportBlocks(rows, { generatedAt }), limit);
}

module.exports = { botBlock, bestBotLine, buildReportBlocks, packIntoMessages, buildTelegramMessages, TELEGRAM_MESSAGE_LIMIT, inr, pct, inrPlain };
