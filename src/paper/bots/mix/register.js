'use strict';
// Mix (docs/BOTS.md "Mix"): GET /api/paper/mix-report (+ ?format=json), auto-loaded by src/paper/pluginLoader.js. SUGGESTIONS ONLY -
// this plugin never places a trade, never changes a rule, never writes anything back to any bot. It only reads trades every bot
// already took and reports what a score-weighted vote of them would have suggested on the candles 2+ bots both looked at.
// Task Group C ("best-of mix" report, docs/decisions/*.md) extends this same route with two read-only, additive sections, kept
// alongside the original vote above (nothing removed, nothing re-fetched that leaderboard/filterStrictness already compute):
//  - scoreboard: the SAME computeBotStats() as /api/paper/bots-report (net INR after costs, win rate, max drawdown), now also
//    carrying avgRFactor (real risk-reward at entry, docs/R-FACTOR.md) and tradesPerDay, added to stats.js itself.
//  - mixCandidate: a plain-English, descriptive-only analysis of which entry pattern/SMC tag each bot's own best-performing
//    trades share, and that bot's own static reward/risk floor - i.e. what a combined "best-of" bot's rule-set would look like if
//    assembled from these slices. It changes no live filter, threshold or bot, and wires no new engine (src/paper/bots/mix/stats.js).
// paper_shadows (a sibling PR's table, if it has landed) would add a third data source; read optionally, never required.
const { computeBotStats } = require('../leaderboard/stats');
const { computeWeights, buildSuggestions, buildMixCandidate } = require('./stats');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (v) => (v == null ? '-' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

let loggedShadowsMissing = false; // log the "not there yet" fact at most once per process, not once per request

// paper_shadows may or may not exist yet (a sibling PR tonight may still be adding it) - read it only to say how many rows it has;
// never lets its absence fail the route. Returns null (section omitted) when the table is not there or pool is unavailable.
async function readShadowsSummary(ctx) {
  const { pool, log } = ctx;
  if (!pool) return null;
  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM paper_shadows');
    return { available: true, rows: r.rows[0]?.n ?? 0 };
  } catch (e) {
    if (!loggedShadowsMissing) { log(`[mix] paper_shadows not available yet (${e.message}) - mix-candidate section continues without it`); loggedShadowsMissing = true; }
    return { available: false, rows: 0 };
  }
}

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
        const mixCandidate = buildMixCandidate(closed);
        const shadows = await readShadowsSummary(ctx);
        const data = {
          paperOnly: true, label: 'suggestion, needs owner approval', note: 'This never trades and never changes anything. It only reports what a score-weighted vote of the bots would have suggested on candles 2 or more bots both looked at; weights come only from bots with 20+ trades.',
          generatedAt: new Date().toISOString(), weights, suggestions,
          scoreboard: stats, // per-bot: trades, win rate, net INR after costs, max drawdown, avgRFactor, tradesPerDay (computeBotStats)
          mixCandidate: { ...mixCandidate, note: 'Descriptive only: what a combined "best-of" bot\'s entry+filter rule-set would look like if assembled from each bot\'s own best-performing slice. No code is built or wired from this - needs owner approval, same as the vote above.' },
          shadows: shadows?.available ? { available: true, rows: shadows.rows } : { available: false, note: 'paper_shadows table not available yet; mix-candidate section continues with trades + replay data only.' },
        };
        if (req.query.format === 'json') return res.json(data);
        const rows = suggestions.map((s) => `<tr><td>${esc(s.symbol)}</td><td>${new Date(s.trigger_t).toISOString()}</td><td>${s.suggestedDirection}</td><td>${s.score}</td><td>${inr(s.weightedPnlInr)}</td><td>${s.bots.map((b) => `${esc(b.bot)} ${esc(b.direction)} (w ${b.weight})`).join(', ')}</td></tr>`).join('');
        const scoreboardRows = Object.entries(stats).map(([bot, s]) => `<tr><td>${esc(bot)}</td><td>${s.trades}</td><td>${s.winRatePct == null ? '-' : s.winRatePct + '%'}</td><td>${inr(s.netPnlInr)}</td><td>${s.avgRFactor == null ? '-' : s.avgRFactor}</td><td>${inr(-s.maxDrawdownInr)}</td><td>${s.tradesPerDay == null ? '-' : s.tradesPerDay}</td></tr>`).join('');
        const mixLines = mixCandidate.description.map((l) => `<li>${esc(l)}</li>`).join('');
        const strongest = mixCandidate.strongest ? `<p class="m"><b>Strongest single candidate:</b> ${esc(mixCandidate.strongest.bot)}'s "${esc(mixCandidate.strongest.tag)}" (${mixCandidate.strongest.bestSharePct}% of its best trades, avg R ${mixCandidate.strongest.avgRFactorBest ?? '-'}).</p>` : '<p class="m">Not enough best trades yet across any bot to name a strongest candidate.</p>';
        return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Mix (suggestion)</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff}h1{font-size:18px;margin:0 0 4px}h3{font-size:15px;margin:16px 0 6px}.m{color:#5b6470}.badge{display:inline-block;background:#fff3cd;color:#664d03;border:1px solid #ffe69c;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border-bottom:1px solid #e5e8ec;padding:5px 6px;text-align:left;font-size:13px;vertical-align:top}</style></head><body>
<h1>NiftyRadar PAPER mix <span class="badge">${esc(data.label)}</span></h1><p class="m">${esc(data.note)} Updated ${esc(data.generatedAt)}.</p>
<h3>Per-bot scoreboard (net INR after costs)</h3><table><tr><th>Bot</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th><th>Avg R</th><th>Max drawdown</th><th>Trades/day</th></tr>${scoreboardRows}</table>
<h3>Mix candidate (suggestion, needs owner approval - never built or wired)</h3><p class="m">${esc(data.mixCandidate.note)}</p>${data.shadows.available ? `<p class="m">paper_shadows: ${data.shadows.rows} rows available.</p>` : `<p class="m">${esc(data.shadows.note)}</p>`}
${mixLines ? `<ul>${mixLines}</ul>` : ''}${strongest}
<h3>Score-weighted vote (candles 2+ bots both looked at)</h3><p class="m">Weights (win rate, only bots with 20+ trades count): ${Object.entries(weights).map(([b, w]) => `${esc(b)}: ${w}`).join(', ')}</p>
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
