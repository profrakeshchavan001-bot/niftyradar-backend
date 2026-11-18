'use strict';
// CC2 add-on: when a new demo bot goes live, send ONE Telegram message on the existing bot/chat
// introducing itself - never repeated on a later restart. Reuses the exact same send call
// (api.telegram.org/bot<token>/sendMessage) and env vars (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) every
// other alert in this repo already uses (src/paper/ops/telegramAlerts/register.js's sendTelegram) - this
// is a separate, tiny client rather than a dependency on that plugin (which may be disabled via
// TELEGRAM_TRADE_ALERTS, a switch that should not also silence this one-time hello).
// "Never sent again" is backed by the bot's own store.getMeta/setMeta (src/paper/lib/researchStore.js) -
// a real guarantee with a Postgres pool, best-effort (resets with the process) in memory mode, same as
// every other in-memory store's persistence in this repo.
async function announceLiveOnce({ store, axios, env, log, botName, strategyLine, market, capitalInr }) {
  try {
    if (await store.getMeta('live_announced')) return;
  } catch (e) {
    log(`[live-announce] ${botName}: could not read announce flag (${e.message}) - skipping this run, will retry next start`);
    return;
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  const text = `Hello, I am ${botName}. Strategy: ${strategyLine}. Market: ${market}. Capital: Rs ${Math.round(capitalInr).toLocaleString('en-IN')}. I am live now.`;
  if (!token || !chat) {
    log(`[live-announce] ${botName}: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured - skipping hello message (not marked sent, will try again next start)`);
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text }, { timeout: 5000 });
    await store.setMeta('live_announced', 'true');
    log(`[live-announce] ${botName}: sent one-time "I am live now" message`);
  } catch (e) {
    log(`[live-announce] ${botName}: send failed (${e.response?.status || (e.code === 'ECONNABORTED' ? 'timeout' : 'network error')}) - will retry next start`);
  }
}

module.exports = { announceLiveOnce };
