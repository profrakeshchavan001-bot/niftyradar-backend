'use strict';
/**
 * Add-on v2 + Task Group C: Telegram trade alerts, at the moment a trade is TAKEN (entry) and again on
 * exit. Reads newly opened/closed trades from the stores on a timer - never called from inside a bot's
 * decision code. Auto-loaded by src/paper/pluginLoader.js.
 *
 * Coverage (Task Group C extends this to every bot that lacked it):
 *  - shared `paper_trades` table (this plugin's ctx.store / state.store, listTrades(limit, market)):
 *    crypto   -> 'intraday', crypto_scalp -> 'scalp', crypto_wide_scalp -> 'scalp_wide' (add-on v2, as before)
 *    nse      -> 'nse', nse_scalp -> 'nse_scalp' (NEW: the main NSE stock bot + the reserved nse_scalp
 *               market had NO alert at all until now - same table, same listTrades() call, just never wired)
 *  - own tables, no shared row (NEW, closing the exact gap docs/decisions/CC4.md logged as deferred):
 *    exhaustion_only, trend_smc - src/paper/bots/<name>/store.js. Reached via ctx.exhaustionMemoryStore /
 *    ctx.trendSmcMemoryStore, which each bot's own register.js already sets to whichever store it is
 *    really using (Postgres or memory - the "Memory" in the name is historical, not a guarantee) BEFORE
 *    this plugin loads (src/paper/pluginLoader.js loads every bots/ plugin before any ops/ plugin). If a
 *    bot is disabled (PAPER_EXHAUSTION_ENABLED=false / PAPER_TREND_SMC_ENABLED=false) or has not finished
 *    registering yet, the property is simply absent - logged once, that bot's alerts are skipped, no
 *    crash, every other bot keeps being checked.
 *
 * INR math (format.js): the NSE bots' own prices and qty are already in rupees, with no FX step and no
 * round-trip-cost % modelled in their own P&L calc (paperbot/bot.js: pnl_inr = (exit - entry) * qty) - so
 * they are formatted with { nativeInr: true, costPct: 0 }, matching that real booking exactly, not an
 * invented fee. The crypto-denominated bots (intraday/scalp/scalp_wide and now exhaustion_only/trend_smc,
 * which use the exact same USDT + fx_rate + 0.23% round-trip-cost convention as the scalp bots'
 * settle()/costPct()) keep the original { nativeInr: false } path: the trade's own fx_rate, else
 * USDINR_FALLBACK, else shown in USD with "rate n/a" - never a silently invented rate.
 *
 * Rules followed: polls on a timer (never inside a bot's own code), DB-backed dedupe (never sent twice,
 * even after a redeploy; falls back to an in-memory Set when there is no database, logged once), a
 * Telegram failure or 5s timeout is caught and logged, never thrown up into the scan/cron cycle, no
 * end-of-day/morning-brief/weekly text is ever sent here (item 3), no summaries - only entry/exit.
 */
const path = require('path');
const { formatEntry, formatExit, DEFAULT_COST_PCT } = require('./format');
const { createRateLimiter } = require('./rateLimit');

// Shared `paper_trades` table markets. nativeInr/costPct feed formatEntry (see file header above).
const SHARED_STORE_MARKETS = {
  crypto: { label: 'intraday', nativeInr: false, costPct: DEFAULT_COST_PCT },
  crypto_scalp: { label: 'scalp', nativeInr: false, costPct: DEFAULT_COST_PCT },
  crypto_wide_scalp: { label: 'scalp_wide', nativeInr: false, costPct: DEFAULT_COST_PCT },
  nse: { label: 'nse', nativeInr: true, costPct: 0 },
  nse_scalp: { label: 'nse_scalp', nativeInr: true, costPct: 0 },
};

// Bots with their own table instead of a row in paper_trades - see file header above for how their store
// is reached on ctx and why it is never missing by the time this plugin's checks actually run.
const OWN_TABLE_BOTS = {
  exhaustion_only: { label: 'exhaustion_only', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'exhaustionMemoryStore' },
  trend_smc: { label: 'trend_smc', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'trendSmcMemoryStore' },
  // MIRROR bots (docs/BOTS.md "Mirror bots"): own table, own ctx key (set by each <bot>_mirror/register.js,
  // which the loader always runs after its original - the folder name sorts after it), same INR/cost
  // convention as the bot they mirror. Label carries the "-MIRROR" suffix so formatEntry/formatExit (same
  // exact message format, unchanged) are visibly distinguishable from the original's own alerts in the
  // same Telegram channel.
  exhaustion_only_mirror: { label: 'exhaustion_only-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'exhaustionMirrorMemoryStore' },
  trend_smc_mirror: { label: 'trend_smc-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'trendSmcMirrorMemoryStore' },
  scalp_mirror: { label: 'scalp-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'scalpMirrorMemoryStore' },
  scalp_wide_mirror: { label: 'scalp_wide-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'scalpWideMirrorMemoryStore' },
};

const POLL_MS = 20000;

async function sendTelegram(axios, token, chat, text, log) {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: text.slice(0, 4000) }, { timeout: 5000 });
    return true;
  } catch (e) {
    log(`[telegram-alerts] send failed: ${e.response?.status || (e.code === 'ECONNABORTED' ? 'timeout' : 'network error')}`); // never log the URL (holds the token) or any trade secret
    return false;
  }
}

function register(ctx) {
  const { env, log, pool, state, axios = require('axios'), cron, now = Date.now } = ctx;
  const tradeAlertsOn = String(env.TELEGRAM_TRADE_ALERTS || '').toLowerCase() === 'on';
  const exitAlertsOn = String(env.TELEGRAM_EXIT_ALERTS ?? 'on').toLowerCase() !== 'off';
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  const configured = Boolean(token && chat);
  const wantedBots = env.TELEGRAM_BOTS ? env.TELEGRAM_BOTS.split(',').map((s) => s.trim()) : null;
  const wanted = (key, label) => !wantedBots || wantedBots.includes(key) || wantedBots.includes(label);

  state.telegramStats = state.telegramStats || { configured, lastSendOk: null, lastSendAt: null };
  if (!configured || !tradeAlertsOn) {
    log(`[telegram-alerts] off (configured=${configured}, TELEGRAM_TRADE_ALERTS=${env.TELEGRAM_TRADE_ALERTS || 'unset'})`);
    return { check: async () => {} };
  }

  const memoryDedupe = new Set(); // bot:tradeId:event - used only when there is no database (logged once below)
  if (!pool) log('[telegram-alerts] no database pool: dedupe is in-memory only, not safe across a redeploy');
  const rateLimiter = createRateLimiter({ now });
  const warnedMissingStore = new Set(); // own-table bot label -> logged once, not every 20s poll

  async function alreadySent(bot, tradeId, event) {
    if (pool) {
      const r = await pool.query('INSERT INTO telegram_alert_log (bot, trade_id, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1', [bot, tradeId, event]);
      return r.rows.length === 0; // nothing inserted = a row was already there = already sent
    }
    const key = `${bot}:${tradeId}:${event}`;
    if (memoryDedupe.has(key)) return true;
    memoryDedupe.add(key);
    return false;
  }

  async function deliver(text) {
    const decision = rateLimiter.take(text);
    if (decision.action === 'hold') return; // over the cap, held for the next digest
    const ok = await sendTelegram(axios, token, chat, decision.text || text, log);
    state.telegramStats.lastSendOk = ok;
    state.telegramStats.lastSendAt = now();
  }

  // Built fresh on every check() (not captured once at register() time) so an own-table bot that
  // registers its store a little later, or never (disabled), is picked up or skipped correctly either way.
  function buildSources() {
    const sources = [];
    for (const [market, cfg] of Object.entries(SHARED_STORE_MARKETS)) {
      if (!wanted(market, cfg.label)) continue;
      sources.push({ label: cfg.label, nativeInr: cfg.nativeInr, costPct: cfg.costPct, fetch: () => state.store.listTrades(50, market) });
    }
    for (const [bot, cfg] of Object.entries(OWN_TABLE_BOTS)) {
      if (!wanted(bot, cfg.label)) continue;
      const store = ctx[cfg.ctxKey];
      if (!store) {
        if (!warnedMissingStore.has(cfg.label)) { log(`[telegram-alerts] ${cfg.label} has no store yet (disabled, or not registered) - its alerts are skipped`); warnedMissingStore.add(cfg.label); }
        continue;
      }
      sources.push({ label: cfg.label, nativeInr: cfg.nativeInr, costPct: cfg.costPct, fetch: () => store.listTrades(50) });
    }
    return sources;
  }

  async function check() {
    for (const src of buildSources()) {
      let rows;
      try { rows = await src.fetch(); } catch (e) { log(`[telegram-alerts] could not read ${src.label} trades: ${e.message}`); continue; }
      for (const t of rows) {
        try {
          if (!(await alreadySent(src.label, t.id, 'entry'))) await deliver(formatEntry(t, src.label, { costPct: src.costPct, usdInrFallback: env.USDINR_FALLBACK, nativeInr: src.nativeInr }));
          if (exitAlertsOn && t.status === 'closed' && !(await alreadySent(src.label, t.id, 'exit'))) await deliver(formatExit(t, src.label));
        } catch (e) { log(`[telegram-alerts] trade ${t.id} (${src.label}) failed: ${e.message}`); } // one bad row must never stop the others
      }
    }
  }

  cron.schedule('*/20 * * * * *', () => check().catch((e) => log(`[telegram-alerts] check failed: ${e.message}`)));
  return { check };
}

module.exports = { name: 'telegram-alerts', schemaSql: path.join(__dirname, 'schema.sql'), register, SHARED_STORE_MARKETS, OWN_TABLE_BOTS, POLL_MS };
