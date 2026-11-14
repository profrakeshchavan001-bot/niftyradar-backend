'use strict';
// GET /api/paper/news-check (src/paper/context/newsCheck.js) and the retry/alternate-header addition to
// news.js's getText (src/paper/context/news.js). Fixtures only - the sandbox has no outbound access to
// Google News, ET, Moneycontrol or nseindia.com (see newsCheck.js file header).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { checkNewsSources, attachNewsCheckRoute, DEFAULT_SYMBOLS } = require('../src/paper/context/newsCheck');
const { createNewsContext } = require('../src/paper/context/news');

test('default symbols: 8 liquid NSE names', () => {
  assert.equal(DEFAULT_SYMBOLS.length, 8);
  assert.deepEqual(DEFAULT_SYMBOLS, ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'SBIN', 'BHARTIARTL', 'LT']);
});

test('aggregation: one symbol ok is enough to mark a source ok overall (ok beats failed beats unchecked)', async () => {
  const calls = [];
  const newsScore = async (symbol) => {
    calls.push(symbol);
    // google-news ok for RELIANCE, failed for everyone else: source is still "ok" overall
    if (symbol === 'RELIANCE') return { score: 10, label: 'positive', sources: ['google-news'], failed: ['et-markets', 'moneycontrol'] };
    return { score: 0, label: 'neutral', sources: [], failed: ['google-news', 'et-markets', 'moneycontrol'] };
  };
  const eventBlock = async () => ({ block: false, reason: 'none', checked: [], unchecked: ['NSE board meetings', 'NSE corporate actions', 'NSE F&O ban list', 'news headlines'] });
  const result = await checkNewsSources({ newsScore, eventBlock }, { symbols: ['RELIANCE', 'TCS'] });
  assert.deepEqual(calls.sort(), ['RELIANCE', 'TCS']);
  assert.equal(result.sources['google-news'], 'ok');
  assert.equal(result.sources['et-markets'], 'failed');
  assert.equal(result.sources.moneycontrol, 'failed');
  assert.equal(result.sources['NSE board meetings'], 'failed'); // never checked ok by anyone -> stays at "failed" (unchecked reported by eventBlock)
  assert.equal(result.perSymbol.length, 2);
});

test('a source neither symbol ever reports stays "unchecked" (never guessed into ok or failed)', async () => {
  const newsScore = async () => null; // nothing answered for this symbol
  const eventBlock = async () => null;
  const result = await checkNewsSources({ newsScore, eventBlock }, { symbols: ['RELIANCE'] });
  for (const label of Object.keys(result.sources)) assert.equal(result.sources[label], 'unchecked');
  assert.equal(result.fallbackNote, null);
});

test('fallbackNote: NSE refused but another source answered -> says so and names what was refused', async () => {
  const newsScore = async () => ({ score: 5, label: 'neutral', sources: ['google-news'], failed: ['nse-announcements'] });
  const eventBlock = async () => ({ block: false, reason: 'none', checked: ['news headlines'], unchecked: ['NSE board meetings', 'NSE corporate actions', 'NSE F&O ban list'] });
  const result = await checkNewsSources({ newsScore, eventBlock }, { symbols: ['RELIANCE'] });
  assert.match(result.fallbackNote, /NSE refused/);
  assert.match(result.fallbackNote, /nse-announcements/);
  assert.match(result.fallbackNote, /falling back/);
});

test('a thrown error from newsScore/eventBlock does not crash the check (treated as that symbol not answering)', async () => {
  const newsScore = async () => { throw new Error('boom'); };
  const eventBlock = async () => { throw new Error('boom'); };
  const result = await checkNewsSources({ newsScore, eventBlock }, { symbols: ['RELIANCE'] });
  assert.equal(result.perSymbol[0].news, null);
  assert.equal(result.perSymbol[0].event, null);
});

test('route: 401 without the secret, 200 with it, ?symbols= overrides the default 8', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = (given) => given === secret;
  const newsScore = async (symbol) => ({ score: 1, label: 'neutral', sources: ['google-news'], failed: [], symbol });
  const eventBlock = async () => ({ block: false, reason: 'none', checked: ['news headlines'], unchecked: [] });
  attachNewsCheckRoute(app, { secret, okSecret, newsScore, eventBlock });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const noKey = await fetch(`http://localhost:${port}/api/paper/news-check`);
    assert.equal(noKey.status, 401);
    const withKey = await fetch(`http://localhost:${port}/api/paper/news-check?key=shh&symbols=tcs,infy`);
    assert.equal(withKey.status, 200);
    const body = await withKey.json();
    assert.deepEqual(body.symbols, ['TCS', 'INFY']);
    assert.equal(body.perSymbol.length, 2);
  } finally { server.close(); }
});

test('news.js retry: a source failing on the primary header set succeeds on the alternate one', async () => {
  let call = 0;
  const fetchImpl = async (url, opts) => {
    call += 1;
    if (opts.headers.Referer === 'https://www.nseindia.com/') return { ok: false, status: 403, text: async () => '' }; // primary blocked
    return { ok: true, status: 200, text: async () => '[]' }; // alternate header set works (empty NSE announcements list)
  };
  const ctx = createNewsContext({ fetchImpl, sleep: async () => {}, sources: { google: false, et: false, moneycontrol: false, nse: true } });
  const news = await ctx.newsScore('RELIANCE');
  assert.ok(news); // the NSE announcements call used the alternate headers and "succeeded" (empty RSS, but a 200)
  assert.equal(call, 2); // one failed attempt (primary), one retry (alternate)
});

test('news.js retry: both header sets failing is reported as that source failed (never invented data)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '' });
  const ctx = createNewsContext({ fetchImpl, sleep: async () => {}, sources: { google: false, et: false, moneycontrol: false, nse: true } });
  const news = await ctx.newsScore('RELIANCE');
  assert.equal(news, null); // every source failed: null, not a guess
});
