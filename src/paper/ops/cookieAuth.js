'use strict';
/**
 * Overnight brief item 5: PAPER_ADMIN_SECRET in a plain ?key= URL is weak (browser history, server logs,
 * shared-link screenshots). On the first visit with a valid ?key=, set an HttpOnly cookie and redirect to
 * the clean URL (?key= stripped, every other query param kept); ?key= keeps working for scripts/monitoring
 * that hit the URL directly every time. Applied once, as one app-level middleware ahead of every
 * /api/paper/ route (paperbot/index.js, scalp, health, home, news-check, and any future ops/bots/replay
 * plugin route), so no individual route file needed to change.
 *
 * Every existing /api/paper/ route already checks `okSecret(req.get('x-paper-secret') || req.query.key)`.
 * This middleware only ever sets `req.query.key` when it was empty and a valid cookie exists - it never
 * touches a route's own auth check, so a route added after this file is written is protected automatically
 * as long as it keeps using that same pattern.
 */
const COOKIE_NAME = 'paper_key';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 days

/** Minimal Cookie-header parser (no cookie-parser dependency: only one cookie to read here). */
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (name) { try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* malformed cookie value: ignore it */ } }
  }
  return out;
}

/** Mounts cookie auth ahead of every /api/paper/ route. `okSecret` is the same timing-safe check the routes use. */
function attachCookieAuth(app, { okSecret, secure = process.env.NODE_ENV === 'production', log = () => {} } = {}) {
  if (typeof app.use !== 'function') { log('[paper-cookie-auth] app has no .use() (a minimal fake app, likely a unit test): cookie auth skipped, ?key= still works exactly as before'); return; }
  app.use('/api/paper', (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const givenKey = req.query.key;
    if (typeof givenKey === 'string' && givenKey && okSecret(givenKey)) {
      res.cookie(COOKIE_NAME, givenKey, { httpOnly: true, path: '/api/paper', maxAge: MAX_AGE_MS, sameSite: 'strict', secure });
      if (cookies[COOKIE_NAME] !== givenKey) {
        const clean = new URL(req.originalUrl, 'http://internal');
        clean.searchParams.delete('key');
        return res.redirect(302, clean.pathname + (clean.search || ''));
      }
    } else if (!givenKey && cookies[COOKIE_NAME]) {
      req.query.key = cookies[COOKIE_NAME]; // every route's own okSecret(... || req.query.key) check picks this up unchanged
    }
    next();
  });
}

module.exports = { attachCookieAuth, parseCookies, COOKIE_NAME };
