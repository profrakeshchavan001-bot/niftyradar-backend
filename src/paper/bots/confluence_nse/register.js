'use strict';
// confluence_nse (GROUP 6): the NSE intraday variant of confluence/confluence_flow's location + trigger +
// real-level stop/target logic, for the NSE F&O universe, priced from the EXISTING Dhan integration
// (server.js's DHAN_ACCESS_TOKEN/DHAN_HEADERS, paperbot/sources.js's createNseSource - reused, not
// rebuilt) for candles and real option prices. Order flow for this variant is meant to use Dhan's 20-level
// market depth; that endpoint is not wired anywhere in this repo today (only marketfeed/quote and
// marketfeed/ohlc, and the option chain - see server.js), so this bot's flow reading always returns
// 'neutral' for now, exactly like src/paper/lib/orderFlow.js degrades on any other feed failure - a
// documented limitation (docs/CONFLUENCE-BOT.md), never a crash and never a silently invented reading.
//
// Feature flag: PAPER_CONFLUENCE_NSE_ENABLED, default OFF ('false' unless explicitly set to 'true'). Even
// when turned on, this bot stays inert and logs "waiting for Dhan token" exactly ONCE at startup until
// env.DHAN_ACCESS_TOKEN is actually present - it never crashes, never stops the server, and every other
// plugin keeps loading normally either way.
const path = require('path');
const { CONFLUENCE_NSE_DEFAULTS, loadConfluenceNseConfig } = require('./config');

// Pure gating decision, exported so it can be unit-tested without a server or a Dhan account.
function readiness(env) {
  const enabled = env.PAPER_CONFLUENCE_NSE_ENABLED === 'true';
  if (!enabled) return { active: false, reason: 'PAPER_CONFLUENCE_NSE_ENABLED is not "true" (default OFF)' };
  if (!env.DHAN_ACCESS_TOKEN) return { active: false, reason: 'waiting for Dhan token' };
  return { active: true, reason: 'enabled and DHAN_ACCESS_TOKEN present' };
}

module.exports = {
  name: 'confluence_nse',
  readiness,
  CONFLUENCE_NSE_DEFAULTS,
  async register(ctx) {
    const { app, env, log, store: mainStore } = ctx;
    const r = readiness(env);

    app.get('/api/paper/confluence-nse-status', (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      res.json({ paperOnly: true, active: r.active, reason: r.reason });
    });

    if (!r.active) {
      log(`[confluence_nse] ${r.reason === 'waiting for Dhan token' ? 'waiting for Dhan token' : `disabled (${r.reason})`}`);
      return; // feature flag off, or no Dhan token yet - no schema, no cron, no API calls, no crash
    }

    // Reached only with the flag on AND a real Dhan token present. Scan/monitor are intentionally NOT
    // scheduled in this change: the live NSE candle/option wiring (universe selection, session/holiday
    // gating, order placement-free sizing) is substantial enough that it belongs in its own follow-up once
    // a real Dhan token is available to test against - this file's job (the task's own instruction) is to
    // make sure the CODE PATH exists and is safe, not to go live blind. The log below says exactly that.
    log('[confluence_nse] flag enabled and Dhan token present, but the live NSE scan/monitor loop is not wired up yet in this change - no schema, no cron, no trade will be taken. See docs/CONFLUENCE-BOT.md.');
    if (mainStore) await loadConfluenceNseConfig(mainStore).catch((e) => log(`[confluence_nse] config load failed: ${e.message}`));
  },
};
