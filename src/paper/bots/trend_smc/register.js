'use strict';
// trend_smc plugin wiring (docs/BOT-INTERFACE.md, docs/BOTS.md). Auto-loaded by src/paper/pluginLoader.js - nothing in
// paperbot/index.js or server.js needs to change for this bot to exist. Switch: PAPER_TREND_SMC_ENABLED (default on).
const path = require('path');
const fs = require('fs');
const { createTrendSmcBot, MARKET } = require('./bot');
const { createMemoryTrendSmcStore, createPgTrendSmcStore } = require('./store');
const { loadTrendSmcConfig } = require('./config');
const { summarise } = require('../../scalp/report');
const { createMemoryShadowStore, createPgShadowStore } = require('../../shadow/store');

// A tiny, self-contained native 15-minute Binance source (own file, not touching the shared paperbot/sources.js, which has no
// 15m method yet): the main crypto bot and the scalp bots build their 15-minute candles from 5-minute ones (E.aggregate), but
// trend_smc's EMA20/50(15m) trend needs 51+ real 15-minute candles, which aggregate() cannot give from a sane number of 5-minute
// candles. Same two-host fallback as createCryptoSource; exported so paperbot/index.js can wrap it with the ONE shared candle
// cache (CC3 round 3 item 3 - no separate cache for this timeframe). 8 s timeout + one backoff pass (round 3 item 2).
function create15mSource({ axios, log, timeoutMs = 8000, backoffMs = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const hosts = ['https://data-api.binance.vision', 'https://api.binance.com'];
  return {
    async candles15(symbol, limit = 100) {
      let lastErr;
      for (const attempt of [0, 1]) {
        if (attempt === 1) await sleep(backoffMs);
        for (const h of hosts) {
          try {
            const rows = (await axios.get(`${h}/api/v3/klines`, { params: { symbol, interval: '15m', limit }, timeout: timeoutMs })).data;
            return rows.map((row) => ({ t: row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], v: +row[5] })).filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite));
          } catch (e) { lastErr = e; }
        }
      }
      throw lastErr;
    },
  };
}

module.exports = {
  name: 'trend_smc',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_TREND_SMC_ENABLED !== 'false';

    app.get('/api/paper/trend-smc-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const tStore = pool ? createPgTrendSmcStore(pool) : ctx.trendSmcMemoryStore;
        if (!tStore) return res.status(503).type('text').send('trend_smc is starting');
        const cfg = await loadTrendSmcConfig(mainStore);
        const closed = await tStore.closedTrades();
        const open = await tStore.allOpenTrades();
        const skips = await tStore.skipsSince('1970-01-01');
        const data = { paperOnly: true, enabled: on, minTrades: cfg.min_trades_for_conclusion, summary: summarise({ closed, open, skips, minTrades: cfg.min_trades_for_conclusion }), recent: await tStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read trend_smc data');
      }
    });

    if (!on) { log('[trend_smc] disabled (PAPER_TREND_SMC_ENABLED=false)'); return; }

    const crypto = ctx.cachedCrypto || (() => {
      const axios = require('axios');
      const { createCryptoSource } = require('../../../../paperbot/sources');
      return createCryptoSource({ axios, log });
    })();
    const tStore = pool ? createPgTrendSmcStore(pool) : createMemoryTrendSmcStore();
    ctx.trendSmcMemoryStore = tStore; // so the report route (and the leaderboard) can read it even without a pool

    const shadowStore = pool ? createPgShadowStore(pool) : createMemoryShadowStore();
    const shadowSchemaReady = pool ? pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'shadow', 'schema.sql'), 'utf8')).catch((e) => log(`[trend_smc] shadow schema failed: ${e.message}`)) : Promise.resolve();

    // Reuse the main bot's already-cached 15-minute source when the caller provides one (paperbot/index.js builds it with the
    // SAME candle cache as the 5m/1h source - see createCachedCrypto/create15mCrypto there); a test or standalone caller still
    // gets its own, uncached source.
    const crypto15 = ctx.cached15mCrypto || create15mSource({ axios: require('axios'), log });
    const bot = createTrendSmcBot({ store: tStore, crypto, crypto15, loadCfg: () => loadTrendSmcConfig(mainStore), shadowStore, log });
    // Staggered seconds (CC3 round 3 item 2): :22 and :58 so neither ever lands on the same tick as another bot's job
    // (nse scan/monitor also use :20/:50 during market hours; shadowMonitor uses :40 every 5 min).
    const scanFn = guarded('trend_smc scan', track('trendSmcScan', bot.scan), log);
    const monitorFn = guarded('trend_smc monitor', track('trendSmcMonitor', bot.monitor), log);
    cron.schedule('22 */5 * * * *', scanFn, tz);
    cron.schedule('58 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { trendSmcScan: scanFn, trendSmcMonitor: monitorFn });
    shadowSchemaReady.then(() => bot.backfillShadows()).catch((e) => log(`[trend_smc] shadow backfill failed: ${e.message}`)); // CC3 urgent fix item 2
    bot.monitor().then((r) => log(`[trend_smc] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[trend_smc] startup resume failed: ${e.message}`)); // item 4
    log(`[trend_smc] ready (PAPER ONLY, market ${MARKET}; report: /api/paper/trend-smc-report)`);
  },
  create15mSource,
};
