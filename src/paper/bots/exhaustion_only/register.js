'use strict';
// exhaustion_only plugin wiring (docs/BOT-INTERFACE.md, docs/BOTS.md). Auto-loaded by src/paper/pluginLoader.js - nothing in
// paperbot/index.js or server.js needs to change for this bot to exist. Switch: PAPER_EXHAUSTION_ENABLED (default on).
const path = require('path');
const { createExhaustionBot, MARKET } = require('./bot');
const { createMemoryExhaustionStore, createPgExhaustionStore } = require('./store');
const { loadExhaustionConfig } = require('./config');
const { summarise } = require('../../scalp/report');

module.exports = {
  name: 'exhaustion_only',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool } = ctx;
    const on = env.PAPER_EXHAUSTION_ENABLED !== 'false';

    app.get('/api/paper/exhaustion-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const eStore = pool ? createPgExhaustionStore(pool) : ctx.exhaustionMemoryStore;
        if (!eStore) return res.status(503).type('text').send('exhaustion_only is starting');
        const cfg = await loadExhaustionConfig(mainStore);
        const closed = await eStore.closedTrades();
        const open = await eStore.allOpenTrades();
        const skips = await eStore.skipsSince('1970-01-01');
        const data = { paperOnly: true, enabled: on, minTrades: cfg.min_trades_for_conclusion, summary: summarise({ closed, open, skips, minTrades: cfg.min_trades_for_conclusion }), recent: await eStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read exhaustion_only data');
      }
    });

    if (!on) { log('[exhaustion_only] disabled (PAPER_EXHAUSTION_ENABLED=false)'); return; }

    // Reuse the main bot's already-cached crypto source when the caller provides one (paperbot/index.js does: one Binance
    // fetch per symbol shared by the main bot, the scalp bots and this plugin, not one each - see createCachedCrypto there).
    // A test or any other caller that does not pass cachedCrypto still gets its own, uncached source, same as before.
    const crypto = ctx.cachedCrypto || (() => {
      const axios = require('axios');
      const { createCryptoSource } = require('../../../../paperbot/sources');
      return createCryptoSource({ axios, log });
    })();
    const eStore = pool ? createPgExhaustionStore(pool) : createMemoryExhaustionStore();
    ctx.exhaustionMemoryStore = eStore; // so the report route above can read it even without a pool

    const bot = createExhaustionBot({ store: eStore, crypto, loadCfg: () => loadExhaustionConfig(mainStore), log });
    cron.schedule('15 */5 * * * *', guarded('exhaustion_only scan', bot.scan, log), tz);
    cron.schedule('45 * * * * *', guarded('exhaustion_only monitor', bot.monitor, log), tz);
    log(`[exhaustion_only] ready (PAPER ONLY, market ${MARKET}; report: /api/paper/exhaustion-report)`);
  },
};
