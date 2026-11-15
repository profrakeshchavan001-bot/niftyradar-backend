'use strict';
// Task Group E: GET /api/paper/daily-summary (+ ?format=json), auto-loaded by src/paper/pluginLoader.js.
// Read-only, PAPER ONLY: reads whatever the bots already stored, never writes, never trades.
// See report.js's file header for data sources and the "open trades as of" assumption.
const { buildDailySummary, resolveDate } = require('./report');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (v) => (v == null ? '-' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

function tradeRow(t) {
  const result = t.status === 'closed' ? `${esc(t.exit_reason || '-')} ${inr(t.pnl_inr)}` : 'OPEN';
  return `<tr><td>${esc(t.market)}</td><td>${esc(t.symbol)}</td><td>${esc(t.direction)}</td><td>${t.entry_price ?? '-'}</td>` +
    `<td>${t.target_price ?? '-'}</td><td>${t.sl_price ?? '-'}</td><td>${t.exit_price ?? '-'}</td><td>${result}</td></tr>`;
}

function skipRow(s) {
  return `<tr><td>${esc(s.market)}</td><td>${esc(s.symbol)}</td><td>${esc(s.reason)}</td></tr>`;
}

function renderHtml(d) {
  const takenRows = d.taken.map(tradeRow).join('');
  const openRows = d.open.map(tradeRow).join('');
  const skipRows = d.skips.slice(0, 200).map(skipRow).join('');
  const topReasonItems = d.topSkipReasons.map((r) => `<li>${r.count}x ${esc(r.label)}${r.sharePct == null ? '' : ` (${r.sharePct}%)`}</li>`).join('')
    || '<li class="m">No skips recorded that day.</li>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Daily summary ${esc(d.date)}</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff}h1{font-size:18px;margin:0 0 4px}h3{font-size:15px;margin:16px 0 6px}.m{color:#5b6470}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0}.grid div{border:1px solid #d9dde3;border-radius:8px;padding:8px}.grid b{display:block;font-size:16px}.grid span{color:#5b6470;font-size:12px}
table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border-bottom:1px solid #e5e8ec;padding:5px 6px;text-align:left;font-size:13px;vertical-align:top}</style></head><body>
<h1>NiftyRadar PAPER: daily summary</h1><p class="m">Demo only, no real money. ${esc(d.date)}${d.isToday ? ' (today)' : ''}. Generated ${esc(d.generatedAt)}.</p>
<div class="grid"><div><b>${d.takenCount}</b><span>trades taken</span></div><div><b>${d.wins}W/${d.losses}L</b><span>closed result</span></div>
<div><b>${inr(d.totalPnlInr)}</b><span>total P&amp;L (after costs)</span></div><div><b>${d.openCount}</b><span>still open (as of ${esc(d.openAsOf)})</span></div>
<div><b>${d.skipsCount}</b><span>setups skipped</span></div></div>
<h3>Trades taken</h3>${d.taken.length ? `<table><tr><th>Bot</th><th>Symbol</th><th>Dir</th><th>Entry</th><th>Target</th><th>Stop</th><th>Exit</th><th>Result</th></tr>${takenRows}</table>` : '<p class="m">No trades taken this day.</p>'}
<h3>Still open (as of ${esc(d.openAsOf)})</h3>${d.open.length ? `<table><tr><th>Bot</th><th>Symbol</th><th>Dir</th><th>Entry</th><th>Target</th><th>Stop</th><th>Exit</th><th>Result</th></tr>${openRows}</table>` : '<p class="m">No open trades.</p>'}
<h3>Top skip reasons (top 5, src/paper/decision/filterStrictness.js categorization)</h3><ul>${topReasonItems}</ul>
<h3>Setups skipped (${d.skipsCount}, first 200 shown)</h3>${d.skips.length ? `<table><tr><th>Bot</th><th>Symbol</th><th>Reason</th></tr>${skipRows}</table>` : '<p class="m">No skips recorded this day.</p>'}
</body></html>`;
}

module.exports = {
  name: 'daily-summary',
  buildDailySummary, // reused directly by tests
  async register(ctx) {
    const { app, env, log } = ctx;
    app.get('/api/paper/daily-summary', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      const store = (ctx.state && ctx.state.store) || ctx.store; // read live at request time (same reason as leaderboard/register.js)
      if (!store) return res.status(503).type('text').send('paper bot is starting');
      let date;
      try { date = resolveDate(req.query.date); } catch (e) { return res.status(400).type('text').send(e.message); }
      try {
        const data = await buildDailySummary({ store, date });
        if (req.query.format === 'json') return res.json(data);
        return res.type('html').send(renderHtml(data));
      } catch (e) {
        log(`[daily-summary] could not build the report: ${e.message}`);
        return res.status(500).type('text').send('could not read paper bot data');
      }
    });
    log('[daily-summary] ready (PAPER ONLY, read-only; report: /api/paper/daily-summary)');
  },
};
