'use strict';
// Mix (docs/BOTS.md "Mix"): GET /api/paper/mix-report (+ ?format=json), auto-loaded by src/paper/pluginLoader.js. SUGGESTIONS ONLY -
// this plugin never places a trade, never changes a rule, never writes anything back to any bot. It only reads trades every bot
// already took and reports what a score-weighted vote of them would have suggested on the candles 2+ bots both looked at.
const { computeBotStats } = require('../leaderboard/stats');
const { computeWeights, buildSuggestions } = require('./stats');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (v) => (v == null ? '-' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

module.exports = {
  name: 'mix',
  async register(ctx) {
    const { app, env, log } = ctx;
    app.get('/api/paper/mix-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const leaderboard = require('../leaderboard/register');
        const closed = await leaderboard.closedTradesByBot(ctx);
        const stats = Object.fromEntries(Object.entries(closed).map(([bot, rows]) => [bot, computeBotStats(rows)]));
        const weights = computeWeights(stats);
        const suggestions = buildSuggestions(closed, weights);
        const data = {
          paperOnly: true, label: 'suggestion, needs owner approval', note: 'This never trades and never changes anything. It only reports what a score-weighted vote of the bots would have suggested on candles 2 or more bots both looked at; weights come only from bots with 20+ trades.',
          generatedAt: new Date().toISOString(), weights, suggestions,
        };
        if (req.query.format === 'json') return res.json(data);
        const rows = suggestions.map((s) => `<tr><td>${esc(s.symbol)}</td><td>${new Date(s.trigger_t).toISOString()}</td><td>${s.suggestedDirection}</td><td>${s.score}</td><td>${inr(s.weightedPnlInr)}</td><td>${s.bots.map((b) => `${esc(b.bot)} ${esc(b.direction)} (w ${b.weight})`).join(', ')}</td></tr>`).join('');
        return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Mix (suggestion)</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff}h1{font-size:18px;margin:0 0 4px}.m{color:#5b6470}.badge{display:inline-block;background:#fff3cd;color:#664d03;border:1px solid #ffe69c;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border-bottom:1px solid #e5e8ec;padding:5px 6px;text-align:left;font-size:13px;vertical-align:top}</style></head><body>
<h1>NiftyRadar PAPER mix <span class="badge">${esc(data.label)}</span></h1><p class="m">${esc(data.note)} Updated ${esc(data.generatedAt)}.</p>
<p class="m">Weights (win rate, only bots with 20+ trades count): ${Object.entries(weights).map(([b, w]) => `${esc(b)}: ${w}`).join(', ')}</p>
${rows ? `<table><tr><th>Symbol</th><th>Candle</th><th>Suggested</th><th>Score</th><th>Weighted result</th><th>Who voted</th></tr>${rows}</table>` : '<p class="m">No candle has 2+ bots with a weighted opinion yet.</p>'}
</body></html>`);
      } catch (e) {
        log(`[mix] could not build the report: ${e.message}`);
        return res.status(500).type('text').send('could not read paper bot data');
      }
    });
    log('[mix] ready (PAPER ONLY, read-only, SUGGESTIONS ONLY - never trades; report: /api/paper/mix-report)');
  },
};
