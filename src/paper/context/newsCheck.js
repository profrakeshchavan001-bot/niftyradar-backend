'use strict';
/**
 * GET /api/paper/news-check: runs newsScore + eventBlock for a handful of liquid NSE stocks and shows each
 * source as ok / failed / unchecked. No new scoring logic here - this only calls into news.js (which now
 * retries a failed source once with an alternate header set and a short backoff - see headerVariants() /
 * fetchOnce() in news.js) and reports what happened.
 *
 * Sandbox note: this process has no outbound access to Google News, Economic Times, Moneycontrol or
 * nseindia.com, so the retry/backoff/alternate-header behaviour is unit-tested against fixtures only
 * (test/newsContext.test.js, test/newsCheck.test.js) and was never exercised against the real sites -
 * "not verified live".
 */
const DEFAULT_SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'SBIN', 'BHARTIARTL', 'LT'];

// Every source label either function can report, mapped to whether it is served by nseindia.com (NSE blocking
// scripted requests is the known failure mode the overnight brief calls out).
const SOURCE_IS_NSE = {
  'google-news': false, 'et-markets': false, moneycontrol: false,
  'nse-announcements': true, 'NSE board meetings': true, 'NSE corporate actions': true, 'NSE F&O ban list': true, 'news headlines': false,
};

/** Runs newsScore + eventBlock for each symbol and folds the per-call ok/failed/unchecked lists into one status per source. */
async function checkNewsSources({ newsScore, eventBlock }, { symbols = DEFAULT_SYMBOLS } = {}) {
  const perSymbol = await Promise.all(symbols.map(async (symbol) => {
    const [news, event] = await Promise.all([newsScore(symbol).catch(() => null), eventBlock(symbol).catch(() => null)]);
    return { symbol, news, event };
  }));

  // ok beats failed beats unchecked: one symbol's success is enough to call a source ok overall.
  const RANK = { ok: 2, failed: 1, unchecked: 0 };
  const status = {};
  const raise = (label, level) => { if (!status[label] || RANK[level] > RANK[status[label]]) status[label] = level; };
  for (const label of Object.keys(SOURCE_IS_NSE)) status[label] = 'unchecked';

  for (const { news, event } of perSymbol) {
    if (news) { for (const s of news.sources) raise(s, 'ok'); for (const s of news.failed) raise(s, 'failed'); }
    if (event) { for (const s of event.checked) raise(s, 'ok'); for (const s of event.unchecked) raise(s, 'failed'); }
  }

  const nseBlocked = Object.entries(status).filter(([label, st]) => SOURCE_IS_NSE[label] && st === 'failed').map(([label]) => label);
  const otherOk = Object.entries(status).some(([label, st]) => !SOURCE_IS_NSE[label] && st === 'ok');
  const fallbackNote = nseBlocked.length
    ? (otherOk ? `NSE refused ${nseBlocked.length} source(s) (${nseBlocked.join(', ')}); falling back to the other sources, which answered.`
      : `NSE refused ${nseBlocked.length} source(s) (${nseBlocked.join(', ')}); no other source answered either.`)
    : null;

  return {
    checkedAt: new Date().toISOString(),
    symbols,
    sources: status,
    fallbackNote,
    perSymbol: perSymbol.map(({ symbol, news, event }) => ({
      symbol,
      news: news ? { score: news.score, label: news.label, sources: news.sources, failed: news.failed } : null,
      event: event ? { block: event.block, reason: event.reason, checked: event.checked, unchecked: event.unchecked } : null,
    })),
  };
}

/** Mounts GET /api/paper/news-check. Reuses the same secret check as the other /api/paper/ admin routes. */
function attachNewsCheckRoute(app, { secret, okSecret, newsScore, eventBlock }) {
  app.get('/api/paper/news-check', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).json({ error: 'PAPER_ADMIN_SECRET not configured' });
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const symbols = typeof req.query.symbols === 'string' && req.query.symbols.trim()
        ? req.query.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20)
        : undefined;
      const result = await checkNewsSources({ newsScore, eventBlock }, symbols ? { symbols } : {});
      res.json({ paperOnly: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'could not run the news check' });
    }
  });
}

module.exports = { checkNewsSources, attachNewsCheckRoute, DEFAULT_SYMBOLS };
