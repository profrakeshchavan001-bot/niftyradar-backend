'use strict';
/**
 * GET /api/paper/home: one mobile-friendly index linking health, report, scalp-report, bots-report,
 * replay-report, news-check, universe and the latest summary. Plain words, big numbers, green or red.
 * Links whose page is not registered on this server yet (another window's route still to come, or this
 * deploy without it) are left out - checked at request time against the live Express router, not a
 * hardcoded guess, so the list is always honest about what this server can actually answer right now.
 */
const { buildHealth } = require('./health');
const { buildMorningCard } = require('./morningCard');

const CANDIDATE_LINKS = [
  { path: '/api/paper/health', label: 'Health', desc: 'is everything scanning right now' },
  { path: '/api/paper/report', label: 'Report', desc: 'NSE + crypto trades and P&L' },
  { path: '/api/paper/scalp-report', label: 'Scalp report', desc: '1-minute crypto scalps' },
  { path: '/api/paper/bots-report', label: 'Bots report', desc: 'per-bot breakdown' },
  { path: '/api/paper/exhaustion-report', label: 'Exhaustion-only bot', desc: "CC3's exhaustion_only bot, measured alone" },
  { path: '/api/paper/replay-report', label: 'Replay report', desc: 'candle-accurate replay' },
  { path: '/api/paper/news-check', label: 'News check', desc: 'which news sources answered' },
  { path: '/api/paper/universe', label: 'Universe', desc: 'what the bot scans' },
  { path: '/api/paper/summaries', label: 'Summaries (JSON)', desc: 'daily summaries' },
];

/** True when `app` has a GET route registered at exactly this path. Express 4 internals (app._router.stack); a missing _router (nothing mounted yet) is treated as "not registered". */
function routeExists(app, path) {
  const stack = (app._router && app._router.stack) || [];
  return stack.some((layer) => layer.route && layer.route.path === path && layer.route.methods && layer.route.methods.get);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BOT_LABELS = { nse: 'NSE', nse_scalp: 'NSE scalp', crypto: 'Crypto', crypto_scalp: 'Crypto scalp', crypto_wide_scalp: 'Crypto wide scalp' };

/** Round 3 item 3: the morning card, plain words, big numbers, green/red. */
function htmlMorningCard(card, dataSources, replayStatus) {
  if (!card) return '';
  const botRows = card.perBot.length
    ? card.perBot.map((b) => {
        const netColor = b.netInr > 0 ? '#1a7f37' : b.netInr < 0 ? '#c23' : '#444';
        const reasons = b.topSkipReasons.map((r) => `${r.count}x ${esc(r.reason)}`).join('<br>') || 'none';
        return `<div style="padding:8px 0;border-top:1px solid #eee">
          <div style="font-weight:600">${esc(BOT_LABELS[b.bot] || b.bot)}</div>
          <div style="font-size:14px">${b.trades} trade(s)${b.open ? ` (${b.open} open)` : ''} &middot; ${b.wins}W/${b.losses}L &middot; <b style="color:${netColor}">${b.netInr >= 0 ? '+' : ''}&#8377;${Math.abs(b.netInr).toLocaleString('en-IN')}</b></div>
          <div style="font-size:13px;color:#666">${b.skips} skip(s) - top reasons: ${reasons}</div>
        </div>`;
      }).join('')
    : '<div style="color:#999;font-size:13px">No trades or skips by any bot since the window started.</div>';
  const sourceLine = Object.entries(dataSources || {}).map(([name, s]) => `${name}: ${s.status === 'ok' ? '🟢' : s.status === 'failing' ? '🔴' : '⚪'} ${s.status}`).join(' &middot; ');
  const replayLine = replayStatus
    ? (replayStatus.error ? `error: ${esc(replayStatus.error)}` : `${esc(replayStatus.status)} (${esc(replayStatus.trigger)}, finished ${esc(replayStatus.finishedAt || 'in progress')})`)
    : 'no run yet';
  return `<div style="margin-bottom:16px;padding:12px 14px;border:1px solid #ddd;border-radius:10px;background:#f7f9fc">
    <div style="font-weight:700;font-size:15px;margin-bottom:4px">Since 18:00 IST yesterday${card.approxSkipWindow ? ' (skip counts: from yesterday\'s date, not the exact hour)' : ''}</div>
    ${botRows}
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid #eee;font-size:13px;color:#444">Data sources: ${sourceLine}</div>
    <div style="font-size:13px;color:#444">Replay last run: ${replayLine}</div>
  </div>`;
}

function htmlHome({ status, reason, links, latestSummary, recentAlerts = [], morningCard = null, dataSources = {}, replayStatus = null }) {
  const color = status === 'ALIVE' ? '#1a7f37' : status === 'DEGRADED' ? '#b8860b' : '#c23';
  // No ?key= in these hrefs: cookieAuth.js (src/paper/ops/cookieAuth.js) already set the HttpOnly cookie
  // on this same visit, so the browser carries it to every link below with no secret in the page source.
  const linkRows = links.map((l) => `<a href="${esc(l.path)}" style="display:block;padding:12px 14px;margin:8px 0;border:1px solid #ddd;border-radius:10px;text-decoration:none;color:#111">
    <div style="font-weight:600;font-size:16px">${esc(l.label)}</div>
    <div style="color:#666;font-size:13px">${esc(l.desc)}</div>
  </a>`).join('');
  const summaryBlock = latestSummary
    ? `<div style="margin-top:8px;padding:12px 14px;border:1px solid #ddd;border-radius:10px;background:#fafafa">
        <div style="font-weight:600">Latest summary</div>
        <div style="color:#666;font-size:13px">${esc(latestSummary.market || '')} &middot; ${esc(latestSummary.summary_date || '')}</div>
      </div>`
    : `<div style="margin-top:8px;color:#999;font-size:13px">No summary stored yet.</div>`;
  const alertsBlock = recentAlerts.length
    ? `<div style="margin-top:8px;padding:12px 14px;border:1px solid #f3c;border-radius:10px;background:#fff4f6">
        <div style="font-weight:600;color:#c23">${recentAlerts.length} alert(s)</div>
        <div style="color:#666;font-size:13px">${esc(recentAlerts[0].message)}</div>
      </div>`
    : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Paper bot</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:16px">
${htmlMorningCard(morningCard, dataSources, replayStatus)}
<h1 style="color:${color};font-size:32px;margin:4px 0">${esc(status)}</h1>
<p style="color:#444">${esc(reason)}</p>
${alertsBlock}
${summaryBlock}
<h2 style="font-size:16px;color:#666;margin-top:20px">Pages</h2>
${linkRows}
</body></html>`;
}

/** Mounts GET /api/paper/home. Same secret check as the other /api/paper/ admin routes. */
function attachHomeRoute(app, { secret, okSecret, tracker, state }) {
  app.get('/api/paper/home', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    const key = req.get('x-paper-secret') || req.query.key;
    if (!okSecret(key)) return res.status(401).type('text').send('Unauthorized');
    try {
      const h = await buildHealth({ tracker, store: state.store, state, now: Date.now() });
      const links = CANDIDATE_LINKS.filter((l) => routeExists(app, l.path));
      let latestSummary = null;
      let morningCard = null;
      if (state.store) {
        try { const rows = await state.store.listSummaries(1); latestSummary = rows[0] || null; } catch (e) { /* home page still loads without it */ }
        try { morningCard = await buildMorningCard({ store: state.store, now: Date.now() }); } catch (e) { /* home page still loads without it */ }
      }
      let replayStatus = null;
      if (state.replay && typeof state.replay.getLastRunStatus === 'function') {
        try { replayStatus = await state.replay.getLastRunStatus(); } catch (e) { /* home page still loads without it */ }
      }
      res.type('html').send(htmlHome({ status: h.status, reason: h.reason, links, latestSummary, recentAlerts: h.recentAlerts, morningCard, dataSources: h.dataSources, replayStatus }));
    } catch (e) {
      res.status(500).type('text').send('could not build the home page');
    }
  });
}

module.exports = { attachHomeRoute, routeExists, htmlHome, CANDIDATE_LINKS };
