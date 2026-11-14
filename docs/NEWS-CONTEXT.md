# News score and event block (for the paper bot)

**Problem it solves:** the paper bot needs to know, for any NSE stock, whether the news is good or bad and whether today is a risky day (results, ex-date, F&O ban, very big news), and it has to do this without paying for any API.

File: `src/paper/context/news.js` (plain Node, no new package, no key, no paid service, no LLM). Tests: `test/newsContext.test.js` with fixture feeds in `test/fixtures/news/`.

```js
const { newsScore, eventBlock } = require('./src/paper/context/news');
const n = await newsScore('RELIANCE');   // { score: -100..+100, label, headlines: [...], sources, failed, asOf } or null
const e = await eventBlock('RELIANCE');  // { block: true|false, reason, reasons, checked, unchecked } or null
```

`null` means "could not find out" (the sources that matter did not answer). It never means "all fine". Nothing is ever made up: a stock with no recent headline gets score 0 and an empty list, but only when at least one news source really answered.

## newsScore: how the number is made

1. Headlines are collected from the free sources below and kept only if the headline names the company (company name, a short name like "Airtel", or the NSE symbol). NSE announcements are already for the symbol and are always kept.
2. The same story from two feeds is counted once (headline compared without the " - Publisher" tail).
3. Each headline gets **points** from the keyword lists below: the points of every matched word are added, then limited to -5..+5. Longer phrases are matched first and their words are used up ("bags order" is not also counted as "order"). Whole words only ("fraudulent" is not "fraud").
4. If the headline also says the bad thing is denied or cleared (denies, dismisses, clears, clean chit, relief, quashes, rules out, refutes, rubbishes, no fraud, "SEBI approves / approval / nod / clears"), its bad words are ignored.
5. Each headline is weighted by how old it is: **last 24 hours counts fully (1.0)**, 24-48 h counts 0.5, 48-72 h counts 0.25, 3-7 days counts 0.1, older than 7 days counts nothing.
6. `score = round( sum(points x recency weight) x 12 )`, limited to -100..+100. Worked example: one fresh headline "upgraded" (+3, 2 hours old) = 3 x 1.0 x 12 = **+36**; the same headline 25 hours old = 3 x 0.5 x 12 = **+18**.
7. `label` is `positive` at +20 or more, `negative` at -20 or less, otherwise `neutral`.

Every headline used is returned with its points, recency, contribution and the exact words that matched, so the bot (and you) can see why.

## The keyword list

Good news words (the number is the points added for one match):

| Points | Words and phrases |
|---|---|
| +3 | order win, wins order, won order, won an order, bags order, bagged order, secures order, secured order, order worth, wins contract, bags contract, won a contract, upgrade, upgrades, upgraded, buyback, share buyback, record profit, record revenue, record sales, profit jumps, profit surges, profit soars, beats estimates, beats forecasts, strong results, target raised, raises target, special dividend, debt-free |
| +2 | overweight, outperform, dividend, bonus issue, stock split, usfda approval, approval, net profit rises, profit rises, profit up, revenue growth, expansion, new plant, stake buy, acquires, acquisition, turnaround, bullish, rally, all-time high, 52-week high, gains |
| +1 | launches, partnership, tie-up, order inflow, capacity addition, positive |

Bad news words:

| Points | Words and phrases |
|---|---|
| -4 | fraud, scam, default, defaults, insolvency, bankruptcy, raid, raids, auditor resigns, money laundering |
| -3 | probe, investigation, sebi, downgrade, downgrades, downgraded, penalty, penalised, fine, fined, resignation, resigns, quits, net loss, loss widens, profit falls, profit plunges, profit slumps, misses estimates, cut target, target cut, lowers target, underperform, sell rating, show cause notice, nclt, going concern, delisting, suspended |
| -2 | lawsuit, legal notice, recall, plant fire, strike, layoffs, job cuts, tax demand, pledge, stake sale, block deal, slump, plunge, falls, bearish, 52-week low, all-time low, warning |
| -1 | volatile, pressure, delay, delays, weak, concern |

The lists live in `KEYWORDS` at the top of `news.js`; `test/newsContext.test.js` fails if this page and the code disagree.

## eventBlock: when the bot should stay out

`block: true` (with a plain `reason`) when any of these is true:

| Check | Source | Reason text looks like |
|---|---|---|
| Results or a board meeting **today or tomorrow** | NSE board meetings | `Results tomorrow (Financial Results)` |
| **Ex-dividend, ex-bonus or ex-split today** | NSE corporate actions | `Ex-dividend today (Dividend - Rs 10 Per Share)` |
| Stock is in the **F&O ban list** | NSE `fo_secban.csv` | `Stock is in the F&O ban list today` |
| **Very big news today** (IST): a headline published today with one of these words, unless it is denied: fraud, scam, default, insolvency, bankruptcy, raid, probe, investigation, takeover, merger, demerger, delisting, trading halt, suspended, auditor resigns, open offer, buyback | the news sources | `Very big news today: "..."` |
| A headline from the last 24 h says results / a board meeting are due **today or tomorrow** | the news sources | `Headline says results or a board meeting are due: "..."` |

`block: false` is returned only when the three NSE checks (board meetings, corporate actions, ban list) all answered and found nothing. If any of the three could not be read and nothing was found, the answer is `null` (unknown), not "safe". If something was found, `block: true` is returned even when other checks failed; `unchecked` lists what could not be read.

"Tomorrow" means the next calendar day in IST (not the next trading day). Dates are IST.

## Sources (free only) and manners

| Source | URL | Used for |
|---|---|---|
| Google News RSS search, one search per company | `news.google.com/rss/search?q=<company> stock when:7d` | headlines |
| Economic Times Markets (stocks) RSS | `economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms` | headlines (shared by all symbols) |
| Moneycontrol buzzing stocks RSS | `moneycontrol.com/rss/buzzingstocks.xml` | headlines (shared) |
| NSE corporate announcements | `nseindia.com/api/corporate-announcements?...&symbol=` | headlines (one call per symbol) |
| NSE board meetings | `nseindia.com/api/corporate-board-meetings?...&symbol=` | results / board meeting |
| NSE corporate actions | `nseindia.com/api/corporates-corporateActions?...&symbol=` | ex-dates |
| NSE F&O ban list | `nsearchives.nseindia.com/content/fo/fo_secban.csv` | ban (shared) |

- **At most 5 feed calls per minute in total.** A call outside the budget is skipped, never queued; the bot gets what is cached, or `null`. A full first look at one new stock needs up to 7 calls (3 of them shared by all stocks), so ask for the few stocks the bot is really considering, not the whole basket.
- **Everything is cached for 10 minutes.** An answer with a source missing is kept for 1 minute only. A failed feed is not retried for 1 minute. If a refresh fails, a copy under 60 minutes old is used; older than that, the source counts as failed.
- **User-Agent:** `NiftyRadarPaperBot/1.0 (research; low-rate RSS reader; ...)`. No e-mail or personal data in it.
- NSE's website often refuses plain server requests (it wants a browser session). If it does, the NSE checks are simply "not available" and the answer follows the rules above. Nothing tries to get around that.
- A source that fails is listed in `failed` (score) or `unchecked` (event block).

## Limits

- Keyword rules are crude on purpose (transparent, free). A headline can be read wrongly ("Reliance falls" can be about a sector). The score is context for the bot, not a signal by itself.
- Company names are built in for the NIFTY 50. For any other symbol pass `{ name: 'Company Name' }`, or only the symbol is matched.
- The feed URLs above were written from public documentation and could not be tested from the build machine (no internet). The tests use hand-made fixture feeds in the real feed shapes, not recordings. First live run: check `failed` / `unchecked` in the answer.
