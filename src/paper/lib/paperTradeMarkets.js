'use strict';
// The ONE source of truth for every value paper_trades.market has ever held or can hold.
//
// Root-cause fix (15 Nov outage round 3): sql/paper_bot.sql's paper_trades_market_check CHECK constraint must be
// built from exactly this list - test/paperTradeMarkets.test.js checks the two stay in sync. Before this fix,
// the SQL file re-added the constraint TWICE as new market values were introduced historically, each time with
// its own hand-typed list; the first (narrower) ADD CONSTRAINT validated against rows already carrying a later
// value and aborted the whole migration every time the bot's store retried it (paperbot/store.js), which is
// exactly how every job's every write started failing with "check constraint ... is violated by some row".
//
// Add a new market here FIRST, then add it to sql/paper_bot.sql's CHECK list (CREATE TABLE's inline CHECK and
// the ALTER ... ADD CONSTRAINT ... NOT VALID both need the same, full list) - never remove a value that any row
// might still carry.
const PAPER_TRADES_MARKETS = ['nse', 'crypto', 'nse_scalp', 'crypto_scalp', 'crypto_wide_scalp'];

module.exports = { PAPER_TRADES_MARKETS };
