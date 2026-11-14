'use strict';
// Scalp wiring: ONE hook called from paperbot/index.js. PAPER_SCALP_ENABLED (default true; "false" turns the scalp strategy off).
//   - cron: scan every minute (5 s after the 1-minute candle closes), monitor every minute (35 s past)
//   - GET /api/paper/scalp-report (same secret as the other paper routes): HTML, or JSON with ?format=json
const fs = require('fs');
const path = require('path');
const { createScalpBot } = require('./bot');
const { createScalpSource } = require('./source');
const { buildScalpData, renderScalpReport } = require('./report');
const { createMemoryShadowStore, createPgShadowStore } = require('../shadow/store');

async function ensureShadowSchema(pool, log) {
  try { await pool.query(fs.readFileSync(path.join(__dirname, '..', 'shadow', 'schema.sql'), 'utf8')); } catch (e) { log(`[scalp] shadow schema failed: ${e.message}`); }
}

function attachScalp({ app, cron, axios, env = process.env, log = console.log, state, store, crypto, secret, okSecret, enabled, guarded, now = Date.now, pool = null }) {
  const scalpOn = env.PAPER_SCALP_ENABLED !== 'false';
  // read-only report, registered whether or not the scalp is running (it then shows what is stored)
  app.get('/api/paper/scalp-report', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).type('text').send('Unauthorized');
    if (!enabled || !state.ready) return res.status(503).type('text').send(enabled ? 'paper bot is starting' : 'paper bot is disabled (PAPER_BOT_ENABLED=false)');
    try {
      const data = await buildScalpData({ store: state.store, now });
      if (req.query.format === 'json') return res.json({ ...data, scalpEnabled: scalpOn });
      return res.type('html').send(renderScalpReport(data));
    } catch (e) {
      return res.status(500).type('text').send('could not read paper bot data');
    }
  });
  if (!scalpOn) { log('[scalp] disabled (PAPER_SCALP_ENABLED=false)'); return { enabled: false }; }
  const shadowStore = pool ? createPgShadowStore(pool) : createMemoryShadowStore();
  if (pool) ensureShadowSchema(pool, log); // fire-and-forget, same as every other idempotic schema here (schema.sql is additive and safe to race)
  const bot = createScalpBot({ store, crypto, source1m: createScalpSource({ axios }), shadowStore, now, log });
  const tz = { timezone: 'Asia/Kolkata' };
  cron.schedule('5 * * * * *', guarded('scalp scan', bot.cryptoScalpScan, log), tz);
  cron.schedule('35 * * * * *', guarded('scalp monitor', bot.cryptoScalpMonitor, log), tz);
  cron.schedule('10 */5 * * * *', guarded('scalp_wide scan', bot.cryptoScalpWideScan, log), tz);
  cron.schedule('40 * * * * *', guarded('scalp_wide monitor', bot.cryptoScalpWideMonitor, log), tz);
  bot.nseScalpScan(); // logs once why NSE scalp does not run
  bot.backfillShadows().catch((e) => log(`[scalp] shadow backfill failed: ${e.message}`)); // CC3 urgent fix item 2, fire-and-forget at startup
  log('[scalp] ready (PAPER ONLY, crypto 1-minute scalps + 5-minute scalp_wide; report: /api/paper/scalp-report)');
  return { enabled: true, bot };
}

module.exports = { attachScalp };
