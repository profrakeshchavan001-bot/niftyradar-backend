'use strict';
/**
 * Overnight item 4: a per-day CSV export of trades and skips.
 * GET /api/paper/export.csv?type=trades|skips&date=YYYY-MM-DD[&market=nse|nse_scalp|crypto|crypto_scalp|crypto_wide_scalp]
 * Same PAPER_ADMIN_SECRET as every other /api/paper/ route. `market` omitted = every market in
 * VARIANT_MARKETS (paperbot/report.js) combined, each row carrying its own `market` column, so the file
 * stays self-describing. exhaustion_only trades are not included (own table - see VARIANT_MARKETS's note).
 */
const { VARIANT_MARKETS } = require('../../../paperbot/report');

const ALL_MARKETS = ['nse', ...VARIANT_MARKETS.nse, 'crypto', ...VARIANT_MARKETS.crypto];
const TRADE_COLUMNS = ['market', 'symbol', 'trade_date', 'status', 'direction', 'entry_price', 'exit_price', 'pnl_inr', 'exit_reason', 'basis'];
const SKIP_COLUMNS = ['market', 'symbol', 'skip_date', 'reason'];

/** One CSV field, quoted only when it needs to be (comma, quote or newline). */
function csvEscape(value) {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: array of plain objects. columns: which fields, in which order. Always ends with one trailing newline. */
function toCsv(rows, columns) {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','))];
  return `${lines.join('\n')}\n`;
}

/** Builds the CSV text + a filename for one day, one type (trades|skips), optionally one market. */
async function exportCsv({ store, type, date, market = null }) {
  const markets = market ? [market] : ALL_MARKETS;
  if (type === 'skips') {
    const rows = (await Promise.all(markets.map((m) => store.skipsSince(date, m)))).flat().filter((s) => s.skip_date === date);
    return { filename: `paper-skips-${date}${market ? `-${market}` : ''}.csv`, csv: toCsv(rows, SKIP_COLUMNS) };
  }
  const rows = (await Promise.all(markets.map((m) => store.tradesForDay(m, date)))).flat();
  return { filename: `paper-trades-${date}${market ? `-${market}` : ''}.csv`, csv: toCsv(rows, TRADE_COLUMNS) };
}

/** Mounts GET /api/paper/export.csv. `state.store` is read fresh per request (same reason as health.js). */
function attachCsvRoute(app, { secret, okSecret, state }) {
  app.get('/api/paper/export.csv', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).type('text').send('Unauthorized');
    if (!state.store) return res.status(503).type('text').send('paper bot is starting');
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).type('text').send('date=YYYY-MM-DD is required');
    const type = req.query.type === 'skips' ? 'skips' : 'trades';
    const market = typeof req.query.market === 'string' && ALL_MARKETS.includes(req.query.market) ? req.query.market : null;
    try {
      const { filename, csv } = await exportCsv({ store: state.store, type, date, market });
      res.type('text/csv').set('Content-Disposition', `attachment; filename="${filename}"`).send(csv);
    } catch (e) {
      res.status(500).type('text').send('could not build the CSV');
    }
  });
}

module.exports = { toCsv, csvEscape, exportCsv, attachCsvRoute, TRADE_COLUMNS, SKIP_COLUMNS, ALL_MARKETS };
