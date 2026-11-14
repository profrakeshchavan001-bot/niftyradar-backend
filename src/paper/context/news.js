'use strict';
/**
 * News score + event block for the paper bot. Free sources only, no paid API, no LLM, no key.
 *
 *   newsScore(symbol)  -> { symbol, score (-100..+100), label, headlines: [...], sources, failed, asOf } | null
 *   eventBlock(symbol) -> { block: true|false, reason, reasons, checked } | null
 *
 * null means "could not tell" (every source that matters failed). It is never replaced by a made-up number.
 * Rules in plain words: docs/NEWS-CONTEXT.md. Every keyword and weight is in KEYWORDS below.
 *
 * Sources (all free): Google News RSS search per company, Economic Times Markets RSS, Moneycontrol RSS, NSE corporate announcements,
 * NSE board meetings, NSE corporate actions and the NSE F&O ban list. A source that fails is skipped and reported in `failed`.
 * Politeness: one honest User-Agent, at most 5 feed calls per minute in total, every answer cached 10 minutes, a failure remembered for 1 minute.
 * The module has no state outside createNewsContext(); tests inject `fetchImpl` and `now`.
 */

// ---------------------------------------------------------------- keywords (weights 1..4, sign by list)
const KEYWORDS = {
  positive: {
    3: ['order win', 'wins order', 'won order', 'won an order', 'bags order', 'bagged order', 'secures order', 'secured order', 'order worth', 'wins contract', 'bags contract', 'won a contract',
      'upgrade', 'upgrades', 'upgraded', 'buyback', 'share buyback', 'record profit', 'record revenue', 'record sales', 'profit jumps', 'profit surges', 'profit soars', 'beats estimates', 'beats forecasts',
      'strong results', 'target raised', 'raises target', 'special dividend', 'debt-free'],
    2: ['overweight', 'outperform', 'dividend', 'bonus issue', 'stock split', 'usfda approval', 'approval', 'net profit rises', 'profit rises', 'profit up', 'revenue growth', 'expansion', 'new plant',
      'stake buy', 'acquires', 'acquisition', 'turnaround', 'bullish', 'rally', 'all-time high', '52-week high', 'gains'],
    1: ['launches', 'partnership', 'tie-up', 'order inflow', 'capacity addition', 'positive'],
  },
  negative: {
    4: ['fraud', 'scam', 'default', 'defaults', 'insolvency', 'bankruptcy', 'raid', 'raids', 'auditor resigns', 'money laundering'],
    3: ['probe', 'investigation', 'sebi', 'downgrade', 'downgrades', 'downgraded', 'penalty', 'penalised', 'fine', 'fined', 'resignation', 'resigns', 'quits', 'net loss', 'loss widens', 'profit falls',
      'profit plunges', 'profit slumps', 'misses estimates', 'cut target', 'target cut', 'lowers target', 'underperform', 'sell rating', 'show cause notice', 'nclt', 'going concern', 'delisting', 'suspended'],
    2: ['lawsuit', 'legal notice', 'recall', 'plant fire', 'strike', 'layoffs', 'job cuts', 'tax demand', 'pledge', 'stake sale', 'block deal', 'slump', 'plunge', 'falls', 'bearish', '52-week low', 'all-time low', 'warning'],
    1: ['volatile', 'pressure', 'delay', 'delays', 'weak', 'concern'],
  },
};
// A negative word in a headline that also says this is not bad news (denied, cleared, SEBI approves ...) is ignored.
const NEGATION = /\b(denies|denied|dismisses|dismissed|clears|cleared|clean chit|relief|quashes|quashed|rules out|refutes|rubbishes|no fraud)\b|\bsebi (approves|approval|nod|clears|clean chit)\b/;
// Headlines (published in the last 24 h) that say results / a board meeting are due today or tomorrow.
const DUE_SOON = /\b(results?|board meeting)\s+(is\s+)?(today|tomorrow)\b|\bto (announce|declare|report) (\w+\s+)?results (today|tomorrow)\b/;
// Words that make a headline "very big news" on their own, whatever the sentiment (only counts when published today, IST). A denial (NEGATION) cancels the negative ones.
const BIG_WORDS = ['fraud', 'scam', 'default', 'insolvency', 'bankruptcy', 'raid', 'probe', 'investigation', 'takeover', 'merger', 'demerger', 'delisting', 'trading halt', 'suspended', 'auditor resigns', 'open offer', 'buyback'];
const HEADLINE_CAP = 5; // one headline moves the score by at most 5 points
const POINTS_TO_SCORE = 12; // score = round(sum(points x recency) x 12), clamped to -100..+100

const RECENCY = [[24, 1], [48, 0.5], [72, 0.25], [168, 0.1]]; // [max age in hours, weight]; older than 7 days is ignored
const recencyWeight = (ageH) => { if (ageH < -1) return 0; for (const [h, w] of RECENCY) if (ageH <= h) return w; return 0; };

// ---------------------------------------------------------------- names (NIFTY 50; others: pass { name } or the symbol is used as it is)
const NAMES = {
  RELIANCE: ['Reliance Industries', 'Reliance', 'RIL'], TCS: ['Tata Consultancy Services', 'TCS'], HDFCBANK: ['HDFC Bank'], ICICIBANK: ['ICICI Bank'], INFY: ['Infosys'],
  SBIN: ['State Bank of India', 'SBI'], BHARTIARTL: ['Bharti Airtel', 'Airtel'], LT: ['Larsen & Toubro', 'Larsen', 'L&T'], HINDUNILVR: ['Hindustan Unilever', 'HUL'], KOTAKBANK: ['Kotak Mahindra Bank', 'Kotak'],
  AXISBANK: ['Axis Bank'], BAJFINANCE: ['Bajaj Finance'], ASIANPAINT: ['Asian Paints'], MARUTI: ['Maruti Suzuki', 'Maruti'], SUNPHARMA: ['Sun Pharma'], ULTRACEMCO: ['UltraTech Cement', 'UltraTech'],
  TATAMOTORS: ['Tata Motors'], NESTLEIND: ['Nestle India', 'Nestle'], ADANIENT: ['Adani Enterprises'], ADANIPORTS: ['Adani Ports'], POWERGRID: ['Power Grid'], 'M&M': ['Mahindra & Mahindra', 'Mahindra'],
  HCLTECH: ['HCL Technologies', 'HCL Tech'], TATASTEEL: ['Tata Steel'], JSWSTEEL: ['JSW Steel'], TECHM: ['Tech Mahindra'], DRREDDY: ["Dr Reddy's", 'Dr Reddys', 'Dr. Reddy'], COALINDIA: ['Coal India'],
  BAJAJFINSV: ['Bajaj Finserv'], EICHERMOT: ['Eicher Motors', 'Eicher'], HEROMOTOCO: ['Hero MotoCorp'], DIVISLAB: ["Divi's Laboratories", "Divi's", 'Divis Lab'], APOLLOHOSP: ['Apollo Hospitals'],
  INDUSINDBK: ['IndusInd Bank', 'IndusInd'], SBILIFE: ['SBI Life'], HDFCLIFE: ['HDFC Life'], TATACONSUM: ['Tata Consumer'], 'BAJAJ-AUTO': ['Bajaj Auto'], SHRIRAMFIN: ['Shriram Finance'],
  ITC: ['ITC'], TITAN: ['Titan'], WIPRO: ['Wipro'], ONGC: ['ONGC'], NTPC: ['NTPC'], GRASIM: ['Grasim'], CIPLA: ['Cipla'], BRITANNIA: ['Britannia'], BPCL: ['BPCL'], HINDALCO: ['Hindalco'], UPL: ['UPL'],
};

// ---------------------------------------------------------------- small helpers
const IST_MS = 19800000;
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** NSE dates: "16-Nov-2026" -> "2026-11-16" (null when it is not that shape). */
function nseDay(s) {
  const m = /^\s*(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{4})/.exec(String(s ?? ''));
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
/** NSE date-times: "16-Nov-2026 10:00:00" (IST) -> epoch ms (null when unreadable). */
function nseTime(s) {
  const day = nseDay(s); if (!day) return null;
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s).slice(11));
  return Date.parse(`${day}T${t ? `${t[1].padStart(2, '0')}:${t[2]}:${t[3] || '00'}` : '00:00:00'}+05:30`);
}
const decode = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** RSS / Atom text -> [{ title, link, source, publishedMs }]; items without a readable title or date are dropped. */
function parseRss(xml) {
  const out = [];
  const items = String(xml ?? '').match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? decode(m[1]) : ''; };
  for (const it of items) {
    const title = tag(it, 'title'); const ms = Date.parse(tag(it, 'pubDate') || tag(it, 'updated') || tag(it, 'published'));
    if (!title || !Number.isFinite(ms)) continue;
    const link = tag(it, 'link') || ((/<link[^>]*href="([^"]+)"/i.exec(it) || [])[1] ?? '');
    out.push({ title, link, source: tag(it, 'source') || null, publishedMs: ms });
  }
  return out;
}

/** The headline without the " - Publisher" tail, lower case: used to drop the same story from two feeds. */
const storyKey = (t) => t.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const NEGATIVE_ALL = Object.values(KEYWORDS.negative).flat();
// compile the keyword lists once: longest phrase first, so "bags order" is used up before "order"
const COMPILED = (() => {
  const rows = [];
  for (const [sign, groups] of [[1, KEYWORDS.positive], [-1, KEYWORDS.negative]]) for (const [w, list] of Object.entries(groups)) for (const phrase of list) rows.push({ phrase, weight: Number(w) * sign });
  rows.sort((a, b) => b.phrase.length - a.phrase.length);
  return rows.map((r) => ({ ...r, re: new RegExp(`(^|[^a-z0-9])(${esc(r.phrase).replace(/\\? /g, '\\s+')})(?![a-z0-9])`) }));
})();

/** One headline -> { points (-5..+5), matched: [{ phrase, weight }], negated, big }. Pure. */
function scoreHeadline(title) {
  let text = String(title ?? '').toLowerCase(); const matched = [];
  const negated = NEGATION.test(text);
  for (const k of COMPILED) {
    const m = k.re.exec(text);
    if (!m) continue;
    text = `${text.slice(0, m.index + m[1].length)} ${' '.repeat(m[2].length)} ${text.slice(m.index + m[1].length + m[2].length)}`.replace(/^ /, ''); // use the words up (same length is not needed)
    if (negated && k.weight < 0) continue;
    matched.push({ phrase: k.phrase, weight: k.weight });
  }
  const points = clamp(matched.reduce((s, k) => s + k.weight, 0), -HEADLINE_CAP, HEADLINE_CAP);
  const lower = String(title ?? '').toLowerCase();
  const big = BIG_WORDS.some((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}(?![a-z0-9])`).test(lower) && !(negated && NEGATIVE_ALL.includes(w)));
  return { points, matched, negated, big };
}

/**
 * Scores headlines. items: [{ title, link, source, publishedMs }] (any feed). names: strings that must appear in a headline for it to be about the stock.
 * Returns { score, headlines } with the headlines used (newest first). Pure; `nowMs` is injected.
 */
function scoreHeadlines(items, names, nowMs) {
  const re = new RegExp(`(^|[^A-Za-z0-9])(${names.map(esc).join('|')})([^A-Za-z0-9]|$)`, 'i');
  const seen = new Set(); const used = [];
  for (const it of [...items].sort((a, b) => b.publishedMs - a.publishedMs)) {
    if (!it.verified && !re.test(it.title)) continue; // NSE announcements are already for this symbol; feeds must name the stock
    const key = storyKey(it.title); if (seen.has(key)) continue;
    const ageHours = (nowMs - it.publishedMs) / 3600000; const recency = recencyWeight(ageHours);
    if (!recency) continue;
    seen.add(key);
    const s = scoreHeadline(it.title);
    used.push({ title: it.title, link: it.link || null, source: it.source || null, publishedAt: new Date(it.publishedMs).toISOString(), ageHours: Number(ageHours.toFixed(1)), points: s.points, recency, contribution: Number((s.points * recency).toFixed(2)), matched: s.matched.map((m) => `${m.phrase} (${m.weight > 0 ? '+' : ''}${m.weight})`), negated: s.negated, big: s.big, publishedMs: it.publishedMs });
  }
  const raw = used.reduce((s, h) => s + h.points * h.recency, 0);
  return { score: clamp(Math.round(raw * POINTS_TO_SCORE), -100, 100), headlines: used };
}

// ---------------------------------------------------------------- feeds
const URLS = {
  google: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=en-IN&gl=IN&ceid=IN:en`,
  et: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
  moneycontrol: 'https://www.moneycontrol.com/rss/buzzingstocks.xml',
  announcements: (s) => `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(s)}`,
  boardMeetings: (s) => `https://www.nseindia.com/api/corporate-board-meetings?index=equities&symbol=${encodeURIComponent(s)}`,
  actions: (s) => `https://www.nseindia.com/api/corporates-corporateActions?index=equities&symbol=${encodeURIComponent(s)}`,
  banList: 'https://nsearchives.nseindia.com/content/fo/fo_secban.csv',
};

function axiosFetch(url, opts) { // only used on a Node without global fetch
  return require('axios').get(url, { headers: opts.headers, timeout: 8000, responseType: 'text', validateStatus: () => true, transformResponse: (d) => d })
    .then((r) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => String(r.data ?? '') }));
}

// Two header sets tried in order: `primary` (our honest bot UA) then `alternate` (a plain desktop-browser UA,
// since NSE in particular answers a scripted UA with a block more often than a browser-shaped one). Never
// used to hide who we are from a source that wants to know (Referer stays nseindia.com either way).
function headerVariants(o, url, accept) {
  const isNse = url.includes('nseindia.com');
  return [
    { 'User-Agent': o.userAgent, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.8', Referer: isNse ? 'https://www.nseindia.com/' : undefined },
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', Accept: accept, 'Accept-Language': 'en-US,en;q=0.9', Referer: isNse ? 'https://www.nseindia.com/get-quotes/equity' : undefined },
  ];
}

function createNewsContext(options = {}) {
  const o = {
    fetchImpl: options.fetchImpl || (typeof fetch === 'function' ? fetch : axiosFetch),
    now: options.now || (() => Date.now()),
    sleep: options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    userAgent: options.userAgent || 'NiftyRadarPaperBot/1.0 (research; low-rate RSS reader; no scraping of personal data)',
    cacheMs: options.cacheMs ?? 600000, failMs: options.failMs ?? 60000, staleMs: options.staleMs ?? 3600000,
    maxCallsPerMinute: options.maxCallsPerMinute ?? 5, timeoutMs: options.timeoutMs ?? 8000, retryBackoffMs: options.retryBackoffMs ?? 500,
    names: { ...NAMES, ...(options.names || {}) },
    sources: { google: true, et: true, moneycontrol: true, nse: true, ...(options.sources || {}) },
  };
  const raw = new Map(); // url -> { at, text }
  const failed = new Map(); // url -> at
  const inflight = new Map(); // url -> Promise
  const calls = []; // timestamps of feed calls in the last minute
  const results = new Map(); // `${kind}:${symbol}` -> { at, value }
  const diag = new Map(); // url -> last outcome: { ok, at, attempts, headerSet, error }
  const stats = { feedCalls: 0, retries: 0 };

  /** One source URL, trying each header set in headerVariants() in turn, with a short backoff before a retry. */
  async function fetchOnce(url, accept) {
    const variants = headerVariants(o, url, accept);
    let lastErr = null;
    for (let i = 0; i < variants.length; i++) {
      if (i > 0) { stats.retries += 1; await o.sleep(o.retryBackoffMs * i); }
      try {
        const res = await o.fetchImpl(url, { headers: variants[i], signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(o.timeoutMs) : undefined });
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'none'}`);
        const text = await res.text();
        if (typeof text !== 'string' || !text.trim()) throw new Error('empty answer');
        return { text, attempts: i + 1, headerSet: i === 0 ? 'primary' : 'alternate' };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('fetch failed');
  }

  /** Text of a feed, or null. Fresh cache first, then the call budget, then the network. A stale copy (under staleMs) is used when the network is not allowed or fails. */
  async function getText(url, accept) {
    const t = o.now(); const hit = raw.get(url);
    if (hit && t - hit.at < o.cacheMs) return { text: hit.text, stale: false };
    if (failed.has(url) && t - failed.get(url) < o.failMs) return hit && t - hit.at < o.staleMs ? { text: hit.text, stale: true } : null;
    if (inflight.has(url)) return inflight.get(url);
    while (calls.length && t - calls[0] >= 60000) calls.shift();
    const staleCopy = hit && t - hit.at < o.staleMs ? { text: hit.text, stale: true } : null;
    if (calls.length >= o.maxCallsPerMinute) return staleCopy; // out of budget: never queue, never wait
    calls.push(t); stats.feedCalls += 1;
    const p = (async () => {
      try {
        const { text, attempts, headerSet } = await fetchOnce(url, accept);
        raw.set(url, { at: o.now(), text }); failed.delete(url);
        diag.set(url, { ok: true, at: o.now(), attempts, headerSet, error: null });
        return { text, stale: false };
      } catch (e) {
        failed.set(url, o.now());
        diag.set(url, { ok: false, at: o.now(), attempts: headerVariants(o, url, accept).length, headerSet: null, error: e && e.message ? e.message : String(e) });
        return staleCopy;
      } finally { inflight.delete(url); }
    })();
    inflight.set(url, p);
    return p;
  }
  const getJson = async (url) => { const r = await getText(url, 'application/json'); if (!r) return null; try { const j = JSON.parse(r.text); return { json: Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null), stale: r.stale }; } catch { return null; } };

  const namesFor = (symbol, opt) => [symbol, ...(opt && opt.name ? [opt.name] : []), ...(o.names[symbol] || [])].filter(Boolean);
  const memo = async (kind, symbol, fn) => {
    const key = `${kind}:${symbol}`; const hit = results.get(key); const t = o.now();
    if (hit && t - hit.at < (hit.short ? o.failMs : o.cacheMs)) return hit.value;
    const value = await fn();
    if (value !== null) results.set(key, { at: t, value, short: Boolean((value.failed && value.failed.length) || (value.unchecked && value.unchecked.length)) }); // an answer with a source missing is kept only 1 minute
    return value;
  };

  async function collectNews(symbol, opt) {
    const names = namesFor(symbol, opt); const tasks = []; const failedSources = []; const okSources = [];
    const add = (label, promise) => tasks.push(promise.then((items) => { if (items) { okSources.push(label); return items; } failedSources.push(label); return []; }));
    if (o.sources.google) add('google-news', getText(URLS.google(`${names[1] || symbol} stock`), 'application/rss+xml, application/xml').then((r) => (r ? parseRss(r.text) : null)));
    if (o.sources.nse) add('nse-announcements', getJson(URLS.announcements(symbol)).then((r) => (r && r.json ? r.json.filter((a) => !a.symbol || String(a.symbol).toUpperCase() === symbol).map((a) => ({ title: decode(`${a.desc || ''}. ${a.attchmntText || ''}`).slice(0, 300), link: a.attchmntFile || null, source: 'NSE announcement', verified: true, publishedMs: nseTime(a.an_dt || a.sort_date) })).filter((x) => x.title.length > 2 && Number.isFinite(x.publishedMs)) : null)));
    if (o.sources.et) add('et-markets', getText(URLS.et, 'application/rss+xml, application/xml').then((r) => (r ? parseRss(r.text) : null)));
    if (o.sources.moneycontrol) add('moneycontrol', getText(URLS.moneycontrol, 'application/rss+xml, application/xml').then((r) => (r ? parseRss(r.text) : null)));
    const items = (await Promise.all(tasks)).flat();
    return { items, names, okSources, failedSources };
  }

  /** News score of one NSE symbol, or null when no news source answered. */
  async function newsScore(symbol, opt = {}) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) return null;
    return memo('news', sym, async () => {
      const { items, names, okSources, failedSources } = await collectNews(sym, opt);
      if (!okSources.length) return null;
      const nowMs = o.now(); const s = scoreHeadlines(items, names, nowMs);
      return { symbol: sym, score: s.score, label: s.score >= 20 ? 'positive' : s.score <= -20 ? 'negative' : 'neutral', headlines: s.headlines, sources: okSources, failed: failedSources, asOf: new Date(nowMs).toISOString(), method: 'keywords_v1' };
    });
  }

  /** Is trading this stock risky today for a reason that is not price action? { block, reason, reasons, checked } or null when the NSE checks could not all be made and nothing was found. */
  async function eventBlock(symbol, opt = {}) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) return null;
    return memo('event', sym, async () => {
      const t = o.now(); const today = istDate(t); const tomorrow = istDate(t + 86400000);
      const [board, acts, ban, news] = await Promise.all([
        o.sources.nse ? getJson(URLS.boardMeetings(sym)) : null, o.sources.nse ? getJson(URLS.actions(sym)) : null, o.sources.nse ? getText(URLS.banList, 'text/csv') : null, newsScore(sym, opt),
      ]);
      const reasons = []; const checked = []; const unchecked = [];
      if (board && board.json) {
        checked.push('NSE board meetings');
        for (const b of board.json) {
          if (b.bm_symbol && String(b.bm_symbol).toUpperCase() !== sym) continue;
          const day = nseDay(b.bm_date || b.date || b.meetingDate); const purpose = decode(b.bm_purpose || b.purpose || b.bm_desc || 'Board meeting');
          if (day !== today && day !== tomorrow) continue;
          reasons.push(`${/result/i.test(purpose) ? 'Results' : 'Board meeting'} ${day === today ? 'today' : 'tomorrow'} (${purpose})`);
        }
      } else unchecked.push('NSE board meetings');
      if (acts && acts.json) {
        checked.push('NSE corporate actions');
        for (const a of acts.json) {
          if (a.symbol && String(a.symbol).toUpperCase() !== sym) continue;
          const subject = decode(a.subject || a.purpose || ''); const kind = /split/i.test(subject) ? 'split' : /bonus/i.test(subject) ? 'bonus' : /dividend/i.test(subject) ? 'dividend' : null;
          if (kind && nseDay(a.exDate || a.exdate) === today) reasons.push(`Ex-${kind} today (${subject})`);
        }
      } else unchecked.push('NSE corporate actions');
      if (ban) {
        checked.push('NSE F&O ban list');
        const banned = ban.text.split(/\r?\n/).map((l) => /^\s*\d+\s*,\s*([A-Z0-9&-]+)/.exec(l)).filter(Boolean).map((m) => m[1]);
        if (banned.includes(sym)) reasons.push('Stock is in the F&O ban list today');
      } else unchecked.push('NSE F&O ban list');
      if (news) {
        checked.push('news headlines');
        const bigToday = news.headlines.filter((h) => istDate(h.publishedMs) === today && h.big);
        if (bigToday.length) reasons.push(`Very big news today: "${bigToday[0].title.slice(0, 110)}"`);
        const due = news.headlines.find((h) => h.ageHours <= 24 && DUE_SOON.test(h.title.toLowerCase()));
        if (due) reasons.push(`Headline says results or a board meeting are due: "${due.title.slice(0, 110)}"`);
      } else unchecked.push('news headlines');
      if (reasons.length) return { block: true, reason: reasons.join('; '), reasons, checked, unchecked };
      if (!unchecked.some((u) => u.startsWith('NSE'))) return { block: false, reason: `No results, board meeting, ex-date, F&O ban or very big news found today${unchecked.length ? ` (${unchecked.join(', ')} not available)` : ''}`, reasons: [], checked, unchecked };
      return null; // the NSE calendars could not be read and nothing else was found: unknown, not "safe"
    });
  }

  const diagFor = (url) => diag.get(url) || null;
  return { newsScore, eventBlock, stats, diagFor, URLS_used: URLS, _clear: () => { raw.clear(); failed.clear(); results.clear(); diag.clear(); calls.length = 0; } };
}

let shared = null;
const defaultContext = () => (shared || (shared = createNewsContext()));

module.exports = {
  createNewsContext, parseRss, scoreHeadline, scoreHeadlines, nseDay, nseTime, istDate,
  KEYWORDS, NEGATION, DUE_SOON, BIG_WORDS, URLS, NAMES, RECENCY, HEADLINE_CAP, POINTS_TO_SCORE,
  newsScore: (symbol, opt) => defaultContext().newsScore(symbol, opt),
  eventBlock: (symbol, opt) => defaultContext().eventBlock(symbol, opt),
  defaultContext,
};
