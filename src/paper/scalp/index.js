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

function attachScalp({ app, cron, axios, env = process.env, log = console.log, state, store, crypto, secret, okSecret, enabled, guarded, now = Date.now, pool = null, healthTracker = null, jobRegistry = null }) {
  const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
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
  // CC3 urgent fix (docs/decisions/CC3.md): this was a bare fire-and-forget with no wait anywhere - reproduced locally, the
  // very first backfill (and the first scan tick, if it lands before this finishes) could race the schema and fail with
  // "relation shadow_setups does not exist". Crons are scheduled immediately regardless (none fire for several seconds,
  // real cron-second offsets below), but the one-time backfill now waits for the schema to actually be there first.
  const shadowSchemaReady = pool ? ensureShadowSchema(pool, log) : Promise.resolve();
  const bot = createScalpBot({ store, crypto, source1m: createScalpSource({ axios }), shadowStore, now, log });
  const tz = { timezone: 'Asia/Kolkata' };
  const scalpScanFn = guarded('scalp scan', track('scalpScan', bot.cryptoScalpScan), log);
  const scalpMonitorFn = guarded('scalp monitor', track('scalpMonitor', bot.cryptoScalpMonitor), log);
  const scalpWideScanFn = guarded('scalp_wide scan', track('scalpWideScan', bot.cryptoScalpWideScan), log);
  const scalpWideMonitorFn = guarded('scalp_wide monitor', track('scalpWideMonitor', bot.cryptoScalpWideMonitor), log);
  cron.schedule('5 * * * * *', scalpScanFn, tz);
  cron.schedule('35 * * * * *', scalpMonitorFn, tz);
  cron.schedule('10 */5 * * * *', scalpWideScanFn, tz);
  cron.schedule('40 * * * * *', scalpWideMonitorFn, tz);
  if (jobRegistry) Object.assign(jobRegistry, { scalpScan: scalpScanFn, scalpMonitor: scalpMonitorFn, scalpWideScan: scalpWideScanFn, scalpWideMonitor: scalpWideMonitorFn });
  bot.nseScalpScan(); // logs once why NSE scalp does not run
  shadowSchemaReady.then(() => bot.backfillShadows()).catch((e) => log(`[scalp] shadow backfill failed: ${e.message}`)); // CC3 urgent fix item 2
  // CC3 urgent fix item 4: resume monitoring of any already-open trade immediately on startup (its own stop/target/time
  // rule against real candle history), not wait for the next cron tick - this is what actually closes a trade left open
  // across a restart/outage (e.g. the stuck crypto_wide_scalp ETHUSDT row from the 15 Nov outage).
  bot.cryptoScalpMonitor().then((r) => log(`[scalp] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[scalp] startup resume failed: ${e.message}`));
  bot.cryptoScalpWideMonitor().then((r) => log(`[scalp_wide] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[scalp_wide] startup resume failed: ${e.message}`));
  log('[scalp] ready (PAPER ONLY, crypto 1-minute scalps + 5-minute scalp_wide; report: /api/paper/scalp-report)');
  return { enabled: true, bot };
}

module.exports = { attachScalp };
