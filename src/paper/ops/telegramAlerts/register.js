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
 * settle()/costPct()) keep the original { nativeInr: false } path, now (Task 1 fix) with a live/fallback
 * rate resolved once per source per poll tick (see resolveLiveRate below): the trade's own fx_rate, else
 * that live/fallback rate, else USDINR_FALLBACK, else a hard-coded default - never shown in USD with
 * "rate n/a" any more, and never a silently invented rate either (every tier is a real, configured number).
 *
 * Rules followed: polls on a timer (never inside a bot's own code), DB-backed dedupe (never sent twice,
 * even after a redeploy; falls back to an in-memory Set when there is no database, logged once), a
 * Telegram failure or 5s timeout is caught and logged, never thrown up into the scan/cron cycle, no
 * end-of-day/morning-brief/weekly text is ever sent here (item 3), no summaries - only entry/exit.
 */
const path = require('path');
const { formatEntry, formatExit, DEFAULT_COST_PCT } = require('./format');
const { createRateLimiter } = require('./rateLimit');
// Capital line (Task: capital line on every trade alert): each bot's own already-configured demo
// capital, read from the SAME *_DEFAULTS/DEFAULTS objects every bot's own config.js already exports -
// never a new/invented number. nse/nse_scalp: paperbot/config.js DEFAULTS.nse.capital_inr. crypto/intraday
// and every crypto-denominated bot: each bot's own capital_usdt (DEFAULTS.crypto for intraday,
// SCALP_DEFAULTS/SCALP_WIDE_DEFAULTS for scalp/scalp_wide, EXHAUSTION_ONLY_DEFAULTS/TREND_SMC_DEFAULTS for
// exhaustion_only/trend_smc - each already has its own capital_usdt: 1000, confirmed in their own
// config.js). A MIRROR bot uses the SAME capitalTotal as the original it mirrors (no mirror-specific
// capital config exists anywhere in this repo today) - logged in the PR notes as the explicit assumption
// the task's own "if none are defined, take a safe default and note it" rule asks for.
const { DEFAULTS: PAPERBOT_DEFAULTS } = require('../../../../paperbot/config');
const { SCALP_DEFAULTS, SCALP_WIDE_DEFAULTS } = require('../../scalp/config');
const { EXHAUSTION_ONLY_DEFAULTS } = require('../../bots/exhaustion_only/config');
const { TREND_SMC_DEFAULTS } = require('../../bots/trend_smc/config');
const { CCY_WIDE_DEFAULTS } = require('../../lib/currencyConfig');
// mcx_gold/mcx_crude (this task): own tables, own capital_inr (already INR - no FX step), priced from a
// PROXY feed (src/paper/lib/yahooFutures.js) - see each bot's own register.js for that caveat.
const { MCX_GOLD_DEFAULTS } = require('../../bots/mcx_gold/config');
const { MCX_CRUDE_DEFAULTS } = require('../../bots/mcx_crude/config');
// research_* (CC2 demo bots for the PASS-verdict research strategies, docs/RESEARCH-STRATEGIES-REPORT.md):
// own tables, nativeInr: true (their own entry/exit prices and qty are already denominated against the
// bot's Rs 1,00,000 capital directly - see each bot's own register.js), costPct 0 (no separate round-trip
// cost model in the live demo; the backtest's own Indian cost model already ran once, in research/
// strategies/costs.py, to decide PASS/FAIL - this live bot is a forward-paper-trading mirror of that
// signal, not a second cost backtest).
const { RESEARCH_USDINR_TREND_DEFAULTS } = require('../../bots/research_usdinr_trend/config');
const { RESEARCH_BTC_MOMENTUM_DEFAULTS } = require('../../bots/research_btc_momentum/config');
const { RESEARCH_N200_52WH_DEFAULTS } = require('../../bots/research_nifty200_52whigh/config');

// nse_scalp has no capital config of its own anywhere in the repo (paperbot/config.js's DEFAULTS has no
// nse_scalp section) - ASSUMED DEFAULT: it shares the main nse capital pool (DEFAULTS.nse.capital_inr),
// logged here and noted in the PR description, per the task's "no config found -> safe default, log it,
// note it" rule.
const NSE_SCALP_CAPITAL_INR = PAPERBOT_DEFAULTS.nse.capital_inr;

// Shared `paper_trades` table markets. nativeInr/costPct/capitalTotal feed formatEntry/formatExit (see file header above).
const SHARED_STORE_MARKETS = {
  crypto: { label: 'intraday', nativeInr: false, costPct: DEFAULT_COST_PCT, capitalTotal: PAPERBOT_DEFAULTS.crypto.capital_usdt },
  crypto_scalp: { label: 'scalp', nativeInr: false, costPct: DEFAULT_COST_PCT, capitalTotal: SCALP_DEFAULTS.capital_usdt },
  crypto_wide_scalp: { label: 'scalp_wide', nativeInr: false, costPct: DEFAULT_COST_PCT, capitalTotal: SCALP_WIDE_DEFAULTS.capital_usdt },
  nse: { label: 'nse', nativeInr: true, costPct: 0, capitalTotal: PAPERBOT_DEFAULTS.nse.capital_inr },
  nse_scalp: { label: 'nse_scalp', nativeInr: true, costPct: 0, capitalTotal: NSE_SCALP_CAPITAL_INR },
};

// Bots with their own table instead of a row in paper_trades - see file header above for how their store
// is reached on ctx and why it is never missing by the time this plugin's checks actually run.
const OWN_TABLE_BOTS = {
  exhaustion_only: { label: 'exhaustion_only', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'exhaustionMemoryStore', capitalTotal: EXHAUSTION_ONLY_DEFAULTS.capital_usdt },
  trend_smc: { label: 'trend_smc', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'trendSmcMemoryStore', capitalTotal: TREND_SMC_DEFAULTS.capital_usdt },
  // MIRROR bots (docs/BOTS.md "Mirror bots"): own table, own ctx key (set by each <bot>_mirror/register.js,
  // which the loader always runs after its original - the folder name sorts after it), same INR/cost
  // convention as the bot they mirror. Label carries the "-MIRROR" suffix so formatEntry/formatExit (same
  // exact message format, unchanged) are visibly distinguishable from the original's own alerts in the
  // same Telegram channel. capitalTotal is the SAME total as the original bot (see file header above).
  exhaustion_only_mirror: { label: 'exhaustion_only-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'exhaustionMirrorMemoryStore', capitalTotal: EXHAUSTION_ONLY_DEFAULTS.capital_usdt },
  trend_smc_mirror: { label: 'trend_smc-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'trendSmcMirrorMemoryStore', capitalTotal: TREND_SMC_DEFAULTS.capital_usdt },
  scalp_mirror: { label: 'scalp-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'scalpMirrorMemoryStore', capitalTotal: SCALP_DEFAULTS.capital_usdt },
  scalp_wide_mirror: { label: 'scalp_wide-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'scalpWideMirrorMemoryStore', capitalTotal: SCALP_WIDE_DEFAULTS.capital_usdt },
  // intraday-MIRROR (new, this task): mirrors ONLY the 'crypto' market (see src/paper/bots/intraday_mirror/
  // register.js) - same capitalTotal as the intraday bot it mirrors.
  intraday_mirror: { label: 'intraday-MIRROR', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'intradayMirrorMemoryStore', capitalTotal: PAPERBOT_DEFAULTS.crypto.capital_usdt },
  // ccy_* (new, this task): NSE currency futures USDINR/EURINR/GBPINR/JPYINR, src/paper/bots/ccy_*/ +
  // their _mirror siblings. Already rupees-native (src/paper/lib/currencyEngine.js's settleInr(), no fx
  // step) - same { nativeInr: true, costPct: 0 } convention as the nse/nse_scalp rows above, not the
  // crypto one. capitalTotal is each pair's own CCY_WIDE_DEFAULTS.capital_inr
  // (src/paper/lib/currencyConfig.js) - all four pairs share the same default capital today.
  ccy_usdinr: { label: 'ccy_usdinr', nativeInr: true, costPct: 0, ctxKey: 'ccyUsdinrMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_eurinr: { label: 'ccy_eurinr', nativeInr: true, costPct: 0, ctxKey: 'ccyEurinrMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_gbpinr: { label: 'ccy_gbpinr', nativeInr: true, costPct: 0, ctxKey: 'ccyGbpinrMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_jpyinr: { label: 'ccy_jpyinr', nativeInr: true, costPct: 0, ctxKey: 'ccyJpyinrMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_usdinr_mirror: { label: 'ccy_usdinr-MIRROR', nativeInr: true, costPct: 0, ctxKey: 'ccyUsdinrMirrorMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_eurinr_mirror: { label: 'ccy_eurinr-MIRROR', nativeInr: true, costPct: 0, ctxKey: 'ccyEurinrMirrorMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_gbpinr_mirror: { label: 'ccy_gbpinr-MIRROR', nativeInr: true, costPct: 0, ctxKey: 'ccyGbpinrMirrorMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  ccy_jpyinr_mirror: { label: 'ccy_jpyinr-MIRROR', nativeInr: true, costPct: 0, ctxKey: 'ccyJpyinrMirrorMemoryStore', capitalTotal: CCY_WIDE_DEFAULTS.capital_inr },
  // mcx_gold / mcx_crude (this task, src/paper/bots/mcx_gold, mcx_crude): own table, nativeInr: true -
  // their prices are already converted to INR before anything stores them (the proxy source converts
  // USD -> INR before the bot ever sees a candle; settle() always runs with fxRate 1), same convention
  // as nse/nse_scalp above. Unlike nse/nse_scalp, these DO model round-trip costs (fee + slippage, same
  // 0.23% shape as the crypto bots - src/paper/scalp/config.js), so costPct is DEFAULT_COST_PCT, not 0.
  mcx_gold: { label: 'mcx_gold', nativeInr: true, costPct: DEFAULT_COST_PCT, ctxKey: 'mcxGoldMemoryStore', capitalTotal: MCX_GOLD_DEFAULTS.capital_inr },
  mcx_crude: { label: 'mcx_crude', nativeInr: true, costPct: DEFAULT_COST_PCT, ctxKey: 'mcxCrudeMemoryStore', capitalTotal: MCX_CRUDE_DEFAULTS.capital_inr },
  mcx_gold_mirror: { label: 'mcx_gold-MIRROR', nativeInr: true, costPct: DEFAULT_COST_PCT, ctxKey: 'mcxGoldMirrorMemoryStore', capitalTotal: MCX_GOLD_DEFAULTS.capital_inr },
  mcx_crude_mirror: { label: 'mcx_crude-MIRROR', nativeInr: true, costPct: DEFAULT_COST_PCT, ctxKey: 'mcxCrudeMirrorMemoryStore', capitalTotal: MCX_CRUDE_DEFAULTS.capital_inr },
  // REVERSE bots (this task): same direction as the MIRROR (opposite of the original) but with proper
  // 2:1 reward:risk levels of its own (src/paper/lib/reverse.js) instead of the mirror's swapped ones -
  // only intraday and scalp_wide have one, as asked. Same capitalTotal as the original they reverse.
  intraday_reverse: { label: 'intraday-REVERSE', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'intradayReverseMemoryStore', capitalTotal: PAPERBOT_DEFAULTS.crypto.capital_usdt },
  scalp_wide_reverse: { label: 'scalp_wide-REVERSE', nativeInr: false, costPct: DEFAULT_COST_PCT, ctxKey: 'scalpWideReverseMemoryStore', capitalTotal: SCALP_WIDE_DEFAULTS.capital_usdt },
  // research_* (CC2, this task): own tables, see the require() comment above for the nativeInr/costPct convention.
  research_usdinr_trend: { label: 'research_usdinr_trend', nativeInr: true, costPct: 0, ctxKey: 'researchUsdinrTrendMemoryStore', capitalTotal: RESEARCH_USDINR_TREND_DEFAULTS.capital_inr },
  research_btc_momentum: { label: 'research_btc_momentum', nativeInr: true, costPct: 0, ctxKey: 'researchBtcMomentumMemoryStore', capitalTotal: RESEARCH_BTC_MOMENTUM_DEFAULTS.capital_inr },
  research_nifty200_52whigh: { label: 'research_nifty200_52whigh', nativeInr: true, costPct: 0, ctxKey: 'researchN20052whMemoryStore', capitalTotal: RESEARCH_N200_52WH_DEFAULTS.capital_inr },
};

const POLL_MS = 20000;

// Task 1 root-cause fix: an entry alert for a crypto-denominated bot used to show "$X (rate n/a)" because
// a trade's own fx_rate is set ONLY at exit time (paperbot/bot.js's closeTrade) and USDINR_FALLBACK is
// usually unset. `ctx.cachedCrypto` is the SAME shared, cached Binance+CoinGecko source every src/paper/
// bots/ plugin already gets (threaded from paperbot/index.js's attachPaperBot -> pluginLoader.loadPlugins),
// and its `usdtInr(fallback)` is the EXACT SAME live-rate call cryptoMonitor() already makes before every
// real exit (paperbot/bot.js) - reused here verbatim, never a second rate source. It never throws (its own
// try/catch already falls back to `fallback` and logs once there - paperbot/sources.js), so the try/catch
// below only guards a missing/mis-shaped ctx.cachedCrypto itself.
//
// Resolved ONCE PER SOURCE PER POLL TICK (called from check(), outside the per-trade loop below) - never
// once per trade - and logged at most once ever per bot label when a fallback tier had to be used, the
// same "log once, not spammy" pattern as `warnedMissingStore` below. `warnedFxFallback` is created fresh
// inside register(ctx) (like `warnedMissingStore`), never at module scope - a module-level Set would keep
// state across unrelated register() calls (e.g. in tests, or a hot-reload) and under-log for good.
function resolveLiveRate(cachedCrypto, env, log, botLabel, warnedFxFallback) {
  if (!cachedCrypto || typeof cachedCrypto.usdtInr !== 'function') {
    if (!warnedFxFallback.has(botLabel)) { log(`[telegram-alerts] ${botLabel}: no shared crypto source on ctx - entry/capital-line fx falls back to USDINR_FALLBACK/default only`); warnedFxFallback.add(botLabel); }
    return Promise.resolve(null);
  }
  const envFallback = Number(env.USDINR_FALLBACK);
  // priority (c) env USDINR_FALLBACK > (d) the bot's own usdt_inr_fallback default (88) - usdtInr() falls
  // back to WHATEVER is passed here if CoinGecko itself cannot be reached, so this one call already covers
  // tiers (b)/(c)/(d) of format.js's fxInfo in the normal case; fxInfo's own (c)/(d) tiers are then only a
  // backstop for when ctx.cachedCrypto is absent entirely (see the branch above).
  const fallback = envFallback > 0 ? envFallback : PAPERBOT_DEFAULTS.crypto.usdt_inr_fallback;
  return cachedCrypto.usdtInr(fallback).then((fx) => {
    if (!fx || !(Number(fx.rate) > 0)) return null;
    if (fx.source !== 'coingecko' && !warnedFxFallback.has(botLabel)) {
      log(`[telegram-alerts] ${botLabel}: live USDT/INR rate unavailable - entry/capital-line fx uses the fallback rate ${fx.rate} (source: ${fx.source})`);
      warnedFxFallback.add(botLabel);
    }
    return { rate: Number(fx.rate), source: fx.source };
  }).catch((e) => {
    if (!warnedFxFallback.has(botLabel)) { log(`[telegram-alerts] ${botLabel}: live fx rate fetch failed (${e.message}) - entry/capital-line fx falls back to USDINR_FALLBACK/default`); warnedFxFallback.add(botLabel); }
    return null;
  });
}

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
  const { env, log, pool, state, axios = require('axios'), cron, now = Date.now, cachedCrypto } = ctx;
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
  const warnedFxFallback = new Set(); // bot label -> already logged that entry/capital-line fx is using a non-live fallback (Task 1)

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
  // closedFetch/openFetch (Task: live running capital balance): this bot's OWN current book - same
  // store methods buildSources() already reads trades from, and the same ones the leaderboard already
  // calls cheaply on every /api/paper/bots-report request (small, per-bot tables - docs/BOTS.md), so
  // reading them once per source per 20s poll tick adds no new query shape to the codebase.
  function buildSources() {
    const sources = [];
    for (const [market, cfg] of Object.entries(SHARED_STORE_MARKETS)) {
      if (!wanted(market, cfg.label)) continue;
      sources.push({
        label: cfg.label, nativeInr: cfg.nativeInr, costPct: cfg.costPct, capitalTotal: cfg.capitalTotal,
        fetch: () => state.store.listTrades(50, market),
        closedFetch: () => state.store.closedTrades(market),
        openFetch: () => state.store.openTrades(market),
      });
    }
    for (const [bot, cfg] of Object.entries(OWN_TABLE_BOTS)) {
      if (!wanted(bot, cfg.label)) continue;
      const store = ctx[cfg.ctxKey];
      if (!store) {
        if (!warnedMissingStore.has(cfg.label)) { log(`[telegram-alerts] ${cfg.label} has no store yet (disabled, or not registered) - its alerts are skipped`); warnedMissingStore.add(cfg.label); }
        continue;
      }
      sources.push({
        label: cfg.label, nativeInr: cfg.nativeInr, costPct: cfg.costPct, capitalTotal: cfg.capitalTotal,
        fetch: () => store.listTrades(50),
        closedFetch: () => store.closedTrades(),
        openFetch: () => store.allOpenTrades(),
      });
    }
    return sources;
  }

  async function check() {
    for (const src of buildSources()) {
      let rows;
      try { rows = await src.fetch(); } catch (e) { log(`[telegram-alerts] could not read ${src.label} trades: ${e.message}`); continue; }
      if (!rows.length) continue; // nothing to alert on this tick - skip the extra book reads below entirely
      // Read this bot's own current book ONCE per tick (not once per trade row) - the same closedTrades()/
      // allOpenTrades() the leaderboard already calls, just read here too for the live capital-left line.
      // A failure here must never drop the entry/exit alerts themselves: fall back to "unknown book" (the
      // formatter then shows no capital line rather than a wrong one - capitalLine requires a real total).
      let closedTrades = []; let openTrades = [];
      try { [closedTrades, openTrades] = await Promise.all([src.closedFetch(), src.openFetch()]); } catch (e) { log(`[telegram-alerts] could not read ${src.label}'s own book for the capital line: ${e.message}`); }
      // Task 1: one live/fallback USDT-INR rate per source per tick (never per trade - see resolveLiveRate
      // above) - only crypto-denominated bots (nativeInr: false) need one; nse/nse_scalp/ccy_*/mcx_* are
      // already rupees-native and ignore `liveRate` entirely (formatEntry/formatExit/capitalLine all pass
      // `{ rate: 1 }` themselves for those).
      const liveRate = src.nativeInr ? null : await resolveLiveRate(cachedCrypto, env, log, src.label, warnedFxFallback);
      for (const t of rows) {
        try {
          if (!(await alreadySent(src.label, t.id, 'entry'))) await deliver(formatEntry(t, src.label, { costPct: src.costPct, usdInrFallback: env.USDINR_FALLBACK, nativeInr: src.nativeInr, capitalTotal: src.capitalTotal, closedTrades, openTrades, liveRate }));
          if (exitAlertsOn && t.status === 'closed' && !(await alreadySent(src.label, t.id, 'exit'))) await deliver(formatExit(t, src.label, { usdInrFallback: env.USDINR_FALLBACK, nativeInr: src.nativeInr, capitalTotal: src.capitalTotal, closedTrades, openTrades, liveRate }));
        } catch (e) { log(`[telegram-alerts] trade ${t.id} (${src.label}) failed: ${e.message}`); } // one bad row must never stop the others
      }
    }
  }

  cron.schedule('*/20 * * * * *', () => check().catch((e) => log(`[telegram-alerts] check failed: ${e.message}`)));
  return { check };
}

// sendTelegram is also exported for reuse by server.js's Dhan-token-renewal failure alert (Group 1,
// 2026-11) - the exact same sender, never a second copy of the same axios.post.
module.exports = { name: 'telegram-alerts', schemaSql: path.join(__dirname, 'schema.sql'), register, SHARED_STORE_MARKETS, OWN_TABLE_BOTS, POLL_MS, sendTelegram };
