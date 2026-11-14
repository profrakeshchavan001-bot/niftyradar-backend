'use strict';
// Replay engine wiring: ONE hook called from paperbot/index.js, same pattern as src/paper/scalp/index.js.
// PAPER ONLY, runs on the Render server (not a sandbox) because Binance's public klines host is only
// reachable from there. PAPER_REPLAY_ENABLED (default true; "false" turns the whole lane off).
//   - history: catches up stored candles for BTCUSDT/ETHUSDT/SOLUSDT (1m/5m/15m/1h) on an interval, resumable
//   - GET /api/paper/replay-report (+&format=json): latest stored run, same secret as the other paper routes
//   - GET /api/paper/replay/run: starts a run in the background, same secret; answers immediately (manual
//     runs are NEVER blocked by the safety guard below -- the owner asked for it directly)
//   - automatic runs ONLY at 02:00 IST (round 2, item 2); skipped (never started) if the live bot's own
//     health page would report PROBLEM, or if this process's memory is already high (src/paper/replay/safety.js)
const { createHistoryClient, loadHistory } = require('./history');
const { createPgReplayStore, createMemoryReplayStore } = require('./store');
const { loadScalpConfig, loadScalpWideConfig, SCALP_DEFAULTS } = require('../scalp/config');
const { loadExhaustionConfig } = require('../bots/exhaustion_only/config');
const { loadConfig: loadLiveConfig } = require('../../../paperbot/config');
const { INTRADAY_CRYPTO_DEFAULTS } = require('./adapters/intradayCrypto');
const { runReplay } = require('./run');
const { runSweep } = require('./sweep');
const { shouldSkipAutoRun } = require('./safety');

const SYMBOLS = SCALP_DEFAULTS.symbols;
const INTERVALS = ['1m', '5m', '15m', '1h'];
const HISTORY_DAYS = 30;

function buildReplayStore(env, log) {
  if (!env.PAPER_DATABASE_URL) {
    log('[replay] PAPER_DATABASE_URL is not set: replay history and results are kept in memory only, lost on restart.');
    return createMemoryReplayStore();
  }
  const { pgOptions } = require('../../../paperbot/index');
  const { Pool } = require('pg');
  const pool = new Pool(pgOptions(env.PAPER_DATABASE_URL));
  pool.on('error', (e) => log(`[replay] database error: ${e.message}`));
  return createPgReplayStore(() => pool);
}

const STRATEGY_LABEL = { scalp: 'Scalp (1m/5m)', scalp_wide: 'Scalp wide (5m/15m)', exhaustion_only: 'Exhaustion only (5m)', intraday_crypto: 'Intraday crypto (5m)' };

function renderReport(result) {
  if (!result) return '<!doctype html><title>Replay</title><p>No replay run yet. GET /api/paper/replay/run?key=... to start one.</p>';
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (label, m) => `<tr><td>${esc(label)}</td><td>${m.tooFew ? 'too few trades, no conclusion' : `${m.trades} trades, ${m.winRatePct}% win, net ₹${m.netInr}, avg win ₹${m.avgWinInr}, avg loss ₹${m.avgLossInr}, max DD ₹${m.maxDrawdownInr}, longest losing streak ${m.longestLosingStreak}`}</td></tr>`;
  const c = result.combined || {};
  const strategyRows = Object.keys(STRATEGY_LABEL).map((name) => {
    const s = c[name];
    if (!s) return '';
    return `${row(`${STRATEGY_LABEL[name]}, in-sample`, s.base?.inSample || { tooFew: true })}${row(`${STRATEGY_LABEL[name]}, out-of-sample`, s.base?.outSample || { tooFew: true })}`
      + `${row(`${STRATEGY_LABEL[name]}, random baseline`, s.randomBaseline?.full || { tooFew: true })}${row(`${STRATEGY_LABEL[name]}, doubled cost`, s.doubledCost?.full || { tooFew: true })}`;
  }).join('');
  const params = result.params || {};
  const lastRunLine = `Last run: #${esc(result.runId)} (${esc(result.trigger || 'unknown')}), ${esc(result.status)}, started ${esc(result.startedAt)}, `
    + `candles loaded ${esc(params.candlesLoaded ?? 'n/a')}, runtime ${esc(params.runtimeMs != null ? `${Math.round(params.runtimeMs / 1000)}s` : 'n/a')}.`;
  return `<!doctype html><title>Replay report</title>
<p><b>Past data, not proof of future results.</b> ${lastRunLine} Look-ahead check: ${result.lookAheadOk ? 'passed' : 'FAILED'}.</p>
<table border="1" cellpadding="4">${strategyRows}</table>
<p>Per-symbol detail, filter study and look-ahead checks: ?format=json</p>`;
}

function attachReplay({ app, cron, axios, env = process.env, log = console.log, secret, okSecret, enabled, guarded, now = Date.now, liveStore = null, liveState = null }) {
  const replayOn = env.PAPER_REPLAY_ENABLED !== 'false';
  const state = { store: null, running: false, lastResult: null };

  const route = (pathname, handler) => app.get(pathname, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).type('text').send('Unauthorized');
    if (!enabled || !replayOn) return res.status(503).type('text').send('replay is disabled');
    try { await handler(req, res); } catch (e) { log(`[replay] route error: ${e.message}`); res.status(500).type('text').send('could not read replay data'); }
  });

  route('/api/paper/replay-report', async (req, res) => {
    const result = await lastRunStatus(state);
    if (req.query.format === 'json') return res.json({ paperOnly: true, result, trades: req.query.trades === '1' && result ? await state.store.tradesForRun(result.runId) : undefined });
    return res.type('html').send(renderReport(result));
  });

  route('/api/paper/replay/run', async (req, res) => {
    if (state.running) return res.json({ started: false, reason: 'a replay run is already in progress' });
    state.running = true;
    startRun(state, env, log, now, 'manual', liveStore).finally(() => { state.running = false; });
    res.json({ started: true, note: 'running in the background; poll /api/paper/replay-report' });
  });

  // Stop/target parameter sweep (brief "if time allows" extra): on demand only, one symbol at a time (it
  // is heavier than a normal run -- 25 cells by default). Suggestions only, nothing is applied automatically.
  route('/api/paper/replay/sweep', async (req, res) => {
    const symbol = String(req.query.symbol || SYMBOLS[0]);
    if (!SYMBOLS.includes(symbol)) return res.status(400).json({ error: `symbol must be one of ${SYMBOLS.join(', ')}` });
    const now_ = now();
    const windowStartMs = now_ - HISTORY_DAYS * 86400000;
    const [c1, c5] = await Promise.all([
      state.store.getCandles(symbol, '1m', { fromT: windowStartMs, toT: now_ }),
      state.store.getCandles(symbol, '5m', { fromT: windowStartMs, toT: now_ }),
    ]);
    const cfg = liveStore ? await loadScalpConfig(liveStore) : SCALP_DEFAULTS;
    if (c1.length < cfg.min_candles_1m || c5.length < cfg.min_candles_5m) return res.status(503).json({ error: 'not enough stored history for this symbol yet' });
    const result = runSweep({ symbol, candles1m: c1, candles5m: c5, cfg, windowStartMs, inSampleDays: 20 });
    res.json({ paperOnly: true, ...result });
  });

  if (!enabled || !replayOn) { log('[replay] disabled (PAPER_BOT_ENABLED=false or PAPER_REPLAY_ENABLED=false)'); return { enabled: false }; }
  state.store = buildReplayStore(env, log);

  // History catch-up: resumable, polite, small pages. Runs once shortly after start and then on an interval,
  // so it never blocks the live bot's own cron jobs and never holds more than one page of candles in memory.
  const client = createHistoryClient({ axios, log });
  const historyTick = guarded('replay history', async () => {
    const { errors } = await loadHistory({ client, store: state.store, symbols: SYMBOLS, intervals: INTERVALS, days: HISTORY_DAYS, now: now(), log });
    if (errors.length) log(`[replay] history catch-up had ${errors.length} error(s): ${JSON.stringify(errors)}`);
  }, log);
  setTimeout(historyTick, 15000).unref();
  cron.schedule('*/15 * * * *', historyTick);

  // Automatic run: ONLY 02:00 IST (round 2, item 2), and only when the live bot's own health is not a
  // PROBLEM and memory is not already high -- never started otherwise. A skip is logged, not an error.
  cron.schedule('0 2 * * *', guarded('replay run (scheduled)', async () => {
    const check = await shouldSkipAutoRun({ liveState, liveStore, now, log });
    if (check.skip) { log(`[replay] scheduled run skipped: ${check.reason}`); return; }
    await startRun(state, env, log, now, 'scheduled', liveStore);
  }, log), { timezone: 'Asia/Kolkata' });

  log('[replay] ready (PAPER ONLY; report: /api/paper/replay-report, run: /api/paper/replay/run, sweep: /api/paper/replay/sweep)');
  return { enabled: true, state, getLastRunStatus: () => lastRunStatus(state) };
}

// Small, read-only status for another page to call directly (round 2 item 4: "export a small function CC4's
// health page can call"). Never throws -- a store error here must not break whoever calls it.
async function lastRunStatus(state) {
  if (!state.store) return null;
  try {
    const latest = await state.store.latestRun();
    if (!latest) return null;
    const resultsRows = await state.store.resultsForRun(latest.id);
    const combined = {};
    for (const r of resultsRows) { combined[r.strategy] = combined[r.strategy] || {}; combined[r.strategy][r.variant] = combined[r.strategy][r.variant] || {}; combined[r.strategy][r.variant][r.segment] = r.metrics; }
    return {
      runId: latest.id, status: latest.status, trigger: latest.trigger, startedAt: latest.started_at, finishedAt: latest.finished_at,
      error: latest.error, params: latest.params || {}, combined, lookAheadOk: latest.status !== 'failed',
    };
  } catch (e) {
    return { error: `could not read the last replay run: ${e.message}` };
  }
}

// `liveStore` is the main paperbot store (paper_trades/paper_config), used to read each strategy's own live
// config (so an owner change in paper_config is honoured everywhere); replay never writes to it. Without it
// (liveStore is null) every strategy falls back to its own defaults.
async function startRun(state, env, log, now, trigger, liveStore) {
  try {
    const cfg = liveStore ? await loadScalpConfig(liveStore) : SCALP_DEFAULTS;
    const cfgs = {};
    if (liveStore) {
      try { cfgs.scalp_wide = await loadScalpWideConfig(liveStore); } catch (e) { log(`[replay] could not read scalp_wide config: ${e.message}`); }
      try { cfgs.exhaustion_only = await loadExhaustionConfig(liveStore); } catch (e) { log(`[replay] could not read exhaustion_only config: ${e.message}`); }
      try {
        const live = await loadLiveConfig(liveStore);
        cfgs.intraday_crypto = { ...live.crypto, patternOpt: live.patterns, fee_pct_per_side: INTRADAY_CRYPTO_DEFAULTS.fee_pct_per_side, slippage_pct: INTRADAY_CRYPTO_DEFAULTS.slippage_pct, min_trades_for_conclusion: INTRADAY_CRYPTO_DEFAULTS.min_trades_for_conclusion };
      } catch (e) { log(`[replay] could not read intraday_crypto config: ${e.message}`); }
    }
    const result = await runReplay({ store: state.store, symbols: SYMBOLS, cfg, cfgs, days: HISTORY_DAYS, inSampleDays: 20, now: now(), trigger, log });
    state.lastResult = result;
    log(`[replay] run #${result.runId} (${trigger}) done, look-ahead ${result.lookAheadOk ? 'passed' : 'FAILED'}, candles ${result.candlesLoaded}, ${Math.round(result.runtimeMs / 1000)}s`);
  } catch (e) {
    log(`[replay] run (${trigger}) failed: ${e.message}`);
  }
}

module.exports = { attachReplay, lastRunStatus, SYMBOLS, INTERVALS, HISTORY_DAYS };
