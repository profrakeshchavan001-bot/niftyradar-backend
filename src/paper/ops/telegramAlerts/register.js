'use strict';
/**
 * Add-on v2: Telegram trade alerts for crypto bots. Reads newly opened/closed trades from the stores -
 * never called from inside a bot's decision code. Auto-loaded by src/paper/pluginLoader.js.
 *
 * Covered now: intraday ('crypto'), scalp ('crypto_scalp'), scalp_wide ('crypto_wide_scalp') - all three
 * live in the shared paper_trades table this plugin's ctx.store already points at.
 * NOT covered (honest deferral, logged in docs/decisions/CC4.md): exhaustion_only and trend_smc keep their
 * own tables (src/paper/bots/exhaustion_only/store.js, src/paper/bots/trend_smc/store.js) with no shared
 * reference this plugin can reach without one wiring line in each bot's own register.js - out of scope
 * for this add-on's time budget; never guessed in, no fake alerts for them.
 *
 * Rules followed: polls on a timer (never inside a bot's own code), DB-backed dedupe (never sent twice,
 * even after a redeploy; falls back to an in-memory Set when there is no database, logged once), a
 * Telegram failure or 5s timeout is caught and logged, never thrown up into the scan/cron cycle, no
 * end-of-day/morning-brief/weekly text is ever sent here (item 3), no summaries - only entry/exit.
 */
const path = require('path');
const { formatEntry, formatExit } = require('./format');
const { createRateLimiter } = require('./rateLimit');

const BOT_MARKETS = { crypto: 'intraday', crypto_scalp: 'scalp', crypto_wide_scalp: 'scalp_wide' };
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

function register({ env, log, pool, state, axios = require('axios'), cron, now = Date.now }) {
  const tradeAlertsOn = String(env.TELEGRAM_TRADE_ALERTS || '').toLowerCase() === 'on';
  const exitAlertsOn = String(env.TELEGRAM_EXIT_ALERTS ?? 'on').toLowerCase() !== 'off';
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  const configured = Boolean(token && chat);
  const wantedBots = env.TELEGRAM_BOTS ? env.TELEGRAM_BOTS.split(',').map((s) => s.trim()) : null;
  const markets = Object.keys(BOT_MARKETS).filter((m) => !wantedBots || wantedBots.includes(BOT_MARKETS[m]) || wantedBots.includes(m));

  state.telegramStats = state.telegramStats || { configured, lastSendOk: null, lastSendAt: null };
  if (!configured || !tradeAlertsOn) {
    log(`[telegram-alerts] off (configured=${configured}, TELEGRAM_TRADE_ALERTS=${env.TELEGRAM_TRADE_ALERTS || 'unset'})`);
    return { check: async () => {} };
  }

  const memoryDedupe = new Set(); // bot:tradeId:event - used only when there is no database (logged once below)
  if (!pool) log('[telegram-alerts] no database pool: dedupe is in-memory only, not safe across a redeploy');
  const rateLimiter = createRateLimiter({ now });

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

  async function check() {
    for (const market of markets) {
      const botLabel = BOT_MARKETS[market];
      let rows;
      try { rows = await state.store.listTrades(50, market); } catch (e) { log(`[telegram-alerts] could not read ${market} trades: ${e.message}`); continue; }
      for (const t of rows) {
        try {
          if (!(await alreadySent(botLabel, t.id, 'entry'))) await deliver(formatEntry(t, botLabel, { usdInrFallback: env.USDINR_FALLBACK }));
          if (exitAlertsOn && t.status === 'closed' && !(await alreadySent(botLabel, t.id, 'exit'))) await deliver(formatExit(t, botLabel));
        } catch (e) { log(`[telegram-alerts] trade ${t.id} (${market}) failed: ${e.message}`); } // one bad row must never stop the others
      }
    }
  }

  cron.schedule('*/20 * * * * *', () => check().catch((e) => log(`[telegram-alerts] check failed: ${e.message}`)));
  return { check };
}

module.exports = { name: 'telegram-alerts', schemaSql: path.join(__dirname, 'schema.sql'), register, BOT_MARKETS, POLL_MS };
