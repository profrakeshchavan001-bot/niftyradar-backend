'use strict';
// News score + event block: recorded-style fixture feeds (hand-made in the real feed shapes; no network), a fake clock and hand-worked numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('../src/paper/context/news');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'news', name), 'utf8');
// "now" = Mon 16 Nov 2026 05:30 UTC = 11:00 IST. Today (IST) is 2026-11-16, tomorrow 2026-11-17.
const NOW = Date.parse('2026-11-16T05:30:00Z');

/** Fake fetch: routes -> body. `down` lists URL parts that fail (HTTP 503 or a thrown error). Records every call. */
function makeFetch({ down = [], throwFor = [], log = [] } = {}) {
  const symbolOf = (u) => (/[?&]symbol=([^&]+)/.exec(u) || [])[1] || '';
  return async (url, opts) => {
    log.push({ url, headers: opts && opts.headers });
    if (throwFor.some((d) => url.includes(d))) throw new Error('network down');
    if (down.some((d) => url.includes(d))) return { ok: false, status: 503, text: async () => '' };
    const body = (s) => ({ ok: true, status: 200, text: async () => s });
    if (url.includes('news.google.com')) return body(fx('google-reliance.xml'));
    if (url.includes('economictimes')) return body(fx('et-markets.xml'));
    if (url.includes('moneycontrol')) return body(fx('moneycontrol-buzzing.xml'));
    if (url.includes('corporate-announcements')) return body(symbolOf(url) === 'RELIANCE' ? fx('nse-announcements-reliance.json') : '[]');
    if (url.includes('corporate-board-meetings')) return body({ RELIANCE: fx('nse-board-meetings-reliance.json'), HDFCBANK: fx('nse-board-meetings-hdfcbank.json') }[symbolOf(url)] || '[]');
    if (url.includes('corporates-corporateActions')) return body(symbolOf(url) === 'TCS' ? fx('nse-actions-tcs.json') : fx('nse-actions-empty.json'));
    if (url.includes('fo_secban')) return body(fx('fo_secban.csv'));
    return { ok: false, status: 404, text: async () => '' };
  };
}
const ctxWith = (extra = {}, fetchOpts = {}) => { const log = fetchOpts.log || []; const clock = { t: NOW }; const c = N.createNewsContext({ fetchImpl: makeFetch({ ...fetchOpts, log }), now: () => clock.t, maxCallsPerMinute: 100, ...extra }); return { c, log, clock }; };

test('RSS parser: CDATA, entities, tags stripped, undated or untitled items dropped', () => {
  const items = N.parseRss(fx('google-reliance.xml'));
  assert.equal(items.length, 7); // 8 items, the one without a date is dropped
  assert.equal(items.find((i) => i.link.endsWith('/g7')).title, 'Reliance Industries & Jio in talks on new tie-up'); // CDATA + <b> removed
  assert.equal(items.find((i) => i.link.endsWith('/g6')).title, 'Nifty ends flat as Sensex slips 40 points & banks drag'); // &amp; decoded
  assert.equal(items[0].publishedMs, Date.parse('2026-11-16T03:30:00Z'));
  assert.deepEqual(N.parseRss('not xml at all'), []); assert.deepEqual(N.parseRss(null), []);
});

test('headline points: keyword weights, longest phrase first, cap of 5, negation', () => {
  assert.equal(N.scoreHeadline('Reliance bags order worth Rs 4,000 crore').points, 3); // "order worth" +3 (one match, "bags order" is part of it)
  assert.equal(N.scoreHeadline('Brokerage upgrades Reliance Industries to overweight').points, 5); // upgrades +3, overweight +2
  assert.equal(N.scoreHeadline('Reliance Industries faces SEBI probe over disclosures').points, -5); // probe -3 + sebi -3 = -6, capped at -5
  assert.equal(N.scoreHeadline('Reliance Industries net profit falls 12% in Q2').points, -3); // "profit falls" -3 (not also "falls" -2: the words are used up once)
  assert.equal(N.scoreHeadline('Infosys wins order and company posts record profit').points, 5); // wins order +3 + record profit +3 = 6, capped at 5
  assert.equal(N.scoreHeadline('Nifty ends flat').points, 0);
  const denied = N.scoreHeadline('SEBI clears Wipro of fraud allegations'); // a denial: the negative words do not count
  assert.deepEqual([denied.points, denied.negated, denied.big], [0, true, false]);
  assert.equal(N.scoreHeadline('SEBI approval for Reliance unit').points, 2); // "approval" +2; the SEBI exception cancels "sebi" -3
  assert.equal(N.scoreHeadline('Fraudulent claims').points, 0); // whole words only: "fraudulent" is not "fraud"
});

test('keyword table sanity: weights 1..4, no phrase on both sides', () => {
  const pos = Object.entries(N.KEYWORDS.positive).flatMap(([w, l]) => l.map((p) => [p, Number(w)])); const neg = Object.entries(N.KEYWORDS.negative).flatMap(([w, l]) => l.map((p) => [p, Number(w)]));
  for (const [, w] of [...pos, ...neg]) assert.ok(w >= 1 && w <= 4);
  const negSet = new Set(neg.map(([p]) => p)); assert.deepEqual(pos.filter(([p]) => negSet.has(p)), []);
  assert.ok(pos.length > 40 && neg.length > 40);
});

test('doc lists every keyword (docs/NEWS-CONTEXT.md cannot drift from the code)', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'NEWS-CONTEXT.md'), 'utf8').toLowerCase();
  for (const group of [N.KEYWORDS.positive, N.KEYWORDS.negative]) for (const list of Object.values(group)) for (const p of list) assert.ok(doc.includes(p.toLowerCase()), `missing in doc: ${p}`);
  for (const w of N.BIG_WORDS) assert.ok(doc.includes(w), `big word missing in doc: ${w}`);
});

test('recency: 24 h counts fully, then 0.5, 0.25, 0.1 up to 7 days, older and future-dated count nothing (hand worked)', () => {
  const at = (hoursAgo) => ({ title: 'Reliance Industries upgraded', publishedMs: NOW - hoursAgo * 3600000 });
  const one = (h) => { const r = N.scoreHeadlines([at(h)], ['Reliance'], NOW); return r.headlines.length ? r.headlines[0].recency : 0; };
  assert.deepEqual([one(1), one(24), one(25), one(48), one(60), one(72), one(100), one(168), one(169), one(-5)], [1, 1, 0.5, 0.5, 0.25, 0.25, 0.1, 0.1, 0, 0]);
  // "upgraded" is +3 points: 3 x 1 = 3 -> 36; at 25 h 3 x 0.5 = 1.5 -> 18; at 100 h 3 x 0.1 = 0.3 -> 3.6 -> 4
  assert.equal(N.scoreHeadlines([at(1)], ['Reliance'], NOW).score, 36); assert.equal(N.scoreHeadlines([at(25)], ['Reliance'], NOW).score, 18); assert.equal(N.scoreHeadlines([at(100)], ['Reliance'], NOW).score, 4);
});

test('score is clamped to -100..+100', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `Reliance fraud probe story ${i}`, publishedMs: NOW - 3600000 }));
  assert.equal(N.scoreHeadlines(many, ['Reliance'], NOW).score, -100); // 12 x -5 x 12 = -720 -> -100
  const good = Array.from({ length: 12 }, (_, i) => ({ title: `Reliance upgraded and wins order ${i}`, publishedMs: NOW - 3600000 }));
  assert.equal(N.scoreHeadlines(good, ['Reliance'], NOW).score, 100);
});

test('newsScore from Google News only: hand-worked 78 (other sources down, reported in "failed")', async () => {
  const { c } = ctxWith({}, { down: ['economictimes', 'moneycontrol', 'nseindia'] });
  const r = await c.newsScore('RELIANCE');
  // kept: g5/g1 (same story, one kept) "order worth" +3 x 1.0 (2 h) = 3; g2 upgrades +3 + overweight +2 = 5 x 1.0 (7 h) = 5;
  //       g3 probe -3 + sebi -3 = -6 -> cap -5 x 0.5 (25 h) = -2.5; g7 "tie-up" +1 x 1.0 (3 h) = 1; g4 is 10 days old (ignored); g6 does not name the stock.
  // sum = 3 + 5 - 2.5 + 1 = 6.5 ; 6.5 x 12 = 78
  assert.equal(r.score, 78); assert.equal(r.label, 'positive');
  assert.equal(r.headlines.length, 4);
  assert.deepEqual(r.headlines.map((h) => h.contribution).sort((a, b) => a - b), [-2.5, 1, 3, 5]);
  assert.deepEqual(r.sources, ['google-news']); assert.deepEqual(r.failed.sort(), ['et-markets', 'moneycontrol', 'nse-announcements']);
  assert.ok(r.headlines.every((h) => h.title && h.publishedAt && Array.isArray(h.matched)));
});

test('newsScore from all four sources: hand-worked 60, duplicates counted once', async () => {
  const { c } = ctxWith();
  const r = await c.newsScore('RELIANCE');
  // Google 6.5 (above) ; ET "net profit falls" -3 x 1.0 (3 h) = -3 (the Moneycontrol copy is the same story: once) ;
  // Moneycontrol "Buzzing stocks: Reliance ... in focus" 0 points ; NSE announcement of 15 Nov 10:00 IST (25 h old) "buyback" +3 x 0.5 = 1.5
  // sum = 6.5 - 3 + 0 + 1.5 = 5 ; 5 x 12 = 60
  assert.equal(r.score, 60); assert.deepEqual(r.failed, []);
  assert.deepEqual(r.sources.sort(), ['et-markets', 'google-news', 'moneycontrol', 'nse-announcements']);
  assert.equal(r.headlines.filter((h) => /net profit falls/.test(h.title)).length, 1);
  assert.ok(r.headlines.some((h) => h.source === 'NSE announcement' && h.points === 3));
});

test('a stock with no recent headline scores 0 with an empty list (not null) while at least one source answered', async () => {
  const { c } = ctxWith();
  const r = await c.newsScore('ZYDUSLIFE', { name: 'Zydus Lifesciences' });
  assert.equal(r.score, 0); assert.deepEqual(r.headlines, []); assert.equal(r.label, 'neutral');
});

test('never fake data: every source down gives null for the score and for the event block', async () => {
  const { c } = ctxWith({}, { down: ['news.google', 'economictimes', 'moneycontrol', 'nseindia', 'nsearchives'] });
  assert.equal(await c.newsScore('RELIANCE'), null); assert.equal(await c.eventBlock('RELIANCE'), null);
  const t = ctxWith({}, { throwFor: ['http'] }); assert.equal(await t.c.newsScore('TCS'), null); // thrown network errors too
  assert.equal(await ctxWith().c.newsScore('not a symbol!'), null); assert.equal(await ctxWith().c.eventBlock(''), null);
});

test('event: results tomorrow (NSE board meetings)', async () => {
  const r = await ctxWith().c.eventBlock('RELIANCE');
  assert.equal(r.block, true); assert.match(r.reason, /Results tomorrow \(Financial Results\)/);
});

test('event: ex-dividend today; a bonus ex-date from last month does not count', async () => {
  const r = await ctxWith().c.eventBlock('TCS');
  assert.equal(r.block, true); assert.deepEqual(r.reasons, ['Ex-dividend today (Dividend - Rs 10 Per Share)']);
});

test('event: F&O ban list', async () => {
  const r = await ctxWith().c.eventBlock('RBLBANK');
  assert.equal(r.block, true); assert.match(r.reason, /F&O ban list/);
  assert.equal((await ctxWith().c.eventBlock('IDEA')).block, true);
});

test('event: very big news today, and a headline saying results are due', async () => {
  const big = await ctxWith().c.eventBlock('INFY');
  assert.equal(big.block, true); assert.match(big.reason, /Very big news today: "Infosys CEO resigns amid fraud probe"/);
  const due = await ctxWith().c.eventBlock('HDFCBANK'); // board meeting is 28 Nov (not near) but ET says "results today"
  assert.equal(due.block, true); assert.match(due.reason, /results or a board meeting are due/);
});

test('event: a clean day gives block false; a denial headline is not big news', async () => {
  const r = await ctxWith().c.eventBlock('WIPRO'); // only "SEBI clears Wipro of fraud allegations"
  assert.equal(r.block, false); assert.match(r.reason, /No results, board meeting, ex-date, F&O ban or very big news/); assert.deepEqual(r.reasons, []);
});

test('event: NSE unreachable and nothing found -> null (unknown, not "safe"); proof found in the news still blocks', async () => {
  const { c } = ctxWith({}, { down: ['nseindia'] });
  assert.equal(await c.eventBlock('WIPRO'), null);
  const b = await c.eventBlock('INFY'); assert.equal(b.block, true); assert.ok(b.unchecked.includes('NSE board meetings'));
  const ban = ctxWith({}, { down: ['nsearchives'] }); assert.equal(await ban.c.eventBlock('RELIANCE').then((x) => x.block), true); // board meeting evidence is enough
});

test('cache: a second call within 10 minutes makes no feed call; after 10 minutes it refetches', async () => {
  const { c, log, clock } = ctxWith();
  await c.newsScore('RELIANCE'); const first = log.length; assert.equal(first, 4);
  await c.newsScore('RELIANCE'); assert.equal(log.length, first);
  clock.t += 9 * 60000; await c.newsScore('RELIANCE'); assert.equal(log.length, first);
  clock.t += 2 * 60000; await c.newsScore('RELIANCE'); assert.equal(log.length, first + 4); // 11 minutes: all four feeds again
});

test('shared feeds are fetched once for many symbols (ET, Moneycontrol, ban list)', async () => {
  const { c, log } = ctxWith();
  await c.newsScore('RELIANCE'); await c.newsScore('TCS'); await c.newsScore('INFY');
  assert.equal(log.filter((l) => l.url.includes('economictimes')).length, 1); assert.equal(log.filter((l) => l.url.includes('moneycontrol')).length, 1);
  assert.equal(log.filter((l) => l.url.includes('news.google')).length, 3); // one search per company
});

test('rate limit: at most 5 feed calls in any minute; a call out of budget is skipped, never queued; the window frees up after 60 s', async () => {
  const log = []; const clock = { t: NOW };
  const c = N.createNewsContext({ fetchImpl: makeFetch({ log }), now: () => clock.t }); // default budget: 5 per minute
  const r = await c.newsScore('RELIANCE'); assert.equal(log.length, 4); assert.ok(r); // 4 calls
  const e = await c.eventBlock('RELIANCE'); // needs board + actions + ban; only 1 call is left in the minute
  assert.equal(log.length, 5); // exactly the 5th call (board meetings) was made; actions and the ban list were out of budget
  assert.equal(e.block, true); assert.deepEqual(e.unchecked.sort(), ['NSE F&O ban list', 'NSE corporate actions']); // evidence found, the rest reported as not checked
  await c.eventBlock('TCS'); await c.newsScore('SBIN'); assert.equal(log.length, 5); // still inside the same minute: nothing more is called
  clock.t += 61000; await c.newsScore('SBIN'); assert.ok(log.length > 5 && log.length <= 10); // a new minute: calls are allowed again, still at most 5
  assert.equal(c.stats.feedCalls, log.length);
});

test('polite User-Agent: names the bot, no personal data; NSE calls carry the NSE referer', async () => {
  const { c, log } = ctxWith(); await c.eventBlock('RELIANCE');
  assert.ok(log.length >= 6);
  for (const l of log) { assert.match(l.headers['User-Agent'], /^NiftyRadarPaperBot\/\d/); assert.ok(!/@/.test(l.headers['User-Agent'])); }
  assert.equal(log.find((l) => l.url.includes('corporate-board-meetings')).headers.Referer, 'https://www.nseindia.com/');
});

test('failures are remembered for 1 minute (no hammering) and a stale copy is served when a refresh fails', async () => {
  const state = { fail: false }; const log = []; const clock = { t: NOW };
  const base = makeFetch({ log });
  const c = N.createNewsContext({ fetchImpl: async (u, o) => (state.fail ? (log.push({ url: u }), { ok: false, status: 503, text: async () => '' }) : base(u, o)), now: () => clock.t, maxCallsPerMinute: 100, sources: { et: false, moneycontrol: false, nse: false } });
  assert.equal((await c.newsScore('RELIANCE')).score, 78);
  clock.t += 11 * 60000; state.fail = true; // cache expired, the source is now down: the 11-minute-old copy is still under the 60-minute stale limit
  const again = await c.newsScore('RELIANCE'); assert.ok(again); // stale copy of the feed is used; headlines older than the new "now" are re-aged
  const n = log.length; await c.newsScore('RELIANCE'); assert.equal(log.length, n); // inside the 1-minute failure memory: no new call
  clock.t += 3 * 3600000; state.fail = true; assert.equal(await c.newsScore('RELIANCE'), null); // the copy is older than 60 minutes: unknown, not a guess
});

test('the shared default instance exports newsScore and eventBlock', () => {
  assert.equal(typeof N.newsScore, 'function'); assert.equal(typeof N.eventBlock, 'function');
});
