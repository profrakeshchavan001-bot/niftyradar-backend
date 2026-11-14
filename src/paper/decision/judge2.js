'use strict';
// JUDGE V2 (CC2 round 2 item 3): a PARALLEL scorer, run alongside the live
// judge (judge.js) but never used for a live entry/exit decision. Weights:
//   R factor 25, pattern 25, SMC/levels 15, EMA/trend 10, sector 10, news/event 10, time/session 5
// When a helper does not apply (sector/news for crypto) or answers null, it
// is EXCLUDED and the remaining weights are rescaled to sum to 100 - this is
// deliberately different from judge.js's "half credit" convention; see
// docs/decisions/CC2.md for why both exist side by side.
// Take at 65+. Store judge2_score / judge2_take / judge2_contributions /
// judge2_basis with every trade and skip, for the report to show both
// judges side by side. Weights never change themselves - owner only.
const {
  scoreR, scorePattern, scoreSector, scoreNews, scoreTrend, scoreTime, clamp, r1, sideOf, merge,
} = require('./judge');

const HELPERS2 = ['r_factor', 'pattern', 'smc', 'ema_trend', 'sector', 'news', 'time'];

const JUDGE2_DEFAULTS = {
  weights: { r_factor: 25, pattern: 25, smc: 15, ema_trend: 10, sector: 10, news: 10, time: 5 },
  take_threshold: 65,
  r_zero: 1, r_full: 3,
  smc_full_tags: 3, // this many direction-aligned SMC tags earn the full 15
  ema_frac: { fresh_with: 1, confirmed_with: 0.75, mixed: 0.5, confirmed_against: 0.25, fresh_against: 0, fresh_flat: 0.5 },
  news_block: -40, news_block_mirror: true,
  avoid_first_min: 15, avoid_last_min: 30, open_min: 555, close_min: 930,
  pattern_extra: 0.1,
  pattern_strength: {
    order_block: 0.9, fvg_retest: 0.85, liquidity_sweep: 0.85, exhaustion_reversal: 0.8, morning_star: 0.75, evening_star: 0.75,
    bullish_engulfing: 0.7, bearish_engulfing: 0.7, hammer: 0.6, shooting_star: 0.6, inside_bar_breakout: 0.55,
  },
  pattern_default: 0.5,
};

// SMC/levels helper: counts smc_tags (src/paper/lib/smc) aligned WITH vs. AGAINST the trade's raw
// direction ('up'/'down'). A tag ending `_up`/`_down` matches directly; 'discount' favours a long,
// 'premium' a short (ICT: buy in a discount zone, sell in a premium zone). `smc_full_tags` aligned
// tags earn the full score; each opposing tag cancels half of one.
function scoreSmc(tags, rawDir, cfg) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return { frac: 0, na: true, note: 'no SMC tags on this setup' };
  const otherDir = rawDir === 'up' ? 'down' : 'up';
  const withSet = rawDir === 'up' ? 'discount' : 'premium';
  const againstSet = rawDir === 'up' ? 'premium' : 'discount';
  const withCount = list.filter((t) => t.endsWith(`_${rawDir}`) || t === withSet).length;
  const againstCount = list.filter((t) => t.endsWith(`_${otherDir}`) || t === againstSet).length;
  const frac = clamp((withCount - 0.5 * againstCount) / cfg.smc_full_tags, 0, 1);
  return { frac, note: `${withCount} SMC tag${withCount === 1 ? '' : 's'} with the trade, ${againstCount} against (${list.join(', ')})` };
}

// EMA/trend helper: src/paper/lib/emaCross.js's label, mapped to a 0..1 fraction.
function scoreEmaTrend(label, cfg) {
  if (!label || !(label in cfg.ema_frac)) return { frac: 0.5, na: true, note: 'no EMA cross reading' };
  return { frac: cfg.ema_frac[label], note: `EMA cross: ${label}` };
}

function createJudge2(opts = {}) {
  const def = opts.stockSectorView || opts.newsScore || opts.eventBlock ? {} : (() => {
    const load = (p) => { try { return require(p); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return null; throw e; } };
    const sector = load('../context/sector');
    const news = load('../context/news');
    return { stockSectorView: sector && sector.stockSectorView, newsScore: news && news.newsScore, eventBlock: news && news.eventBlock };
  })();
  const stockSectorView = opts.stockSectorView || def.stockSectorView || null;
  const newsScoreFn = opts.newsScore || def.newsScore || null;
  const eventBlockFn = opts.eventBlock || def.eventBlock || null;
  const cfg = merge(JUDGE2_DEFAULTS, opts.config);

  async function judge2(candidate) {
    const c = candidate || {};
    const side = sideOf(c.direction);
    if (!side) {
      return { score: 0, take: false, basis: 'Not taken: the trade direction is missing, so nothing can be judged.', contributions: Object.fromEntries(HELPERS2.map((h) => [h, null])), blocked: 'no direction', na: HELPERS2, threshold: cfg.take_threshold };
    }
    const rawDir = side === 'long' ? 'up' : 'down';
    const isCrypto = String(c.market || '').toLowerCase() === 'crypto';
    const blocks = [];

    let ev = null;
    if (!isCrypto) {
      if (typeof c.eventBlock === 'object' && c.eventBlock) ev = c.eventBlock;
      else if (eventBlockFn) { try { ev = await eventBlockFn(c.symbol); } catch { ev = null; } }
    }
    if (ev && ev.block) blocks.push(`event block: ${ev.reason || 'an event is due'}`);

    const r = scoreR(c, cfg);
    const p = scorePattern(c, cfg, side);
    const smc = scoreSmc(c.smcTags, rawDir, cfg);
    const ema = scoreEmaTrend(c.emaCross, cfg);
    let sector; let news;
    if (isCrypto) {
      sector = { frac: 0, na: true, note: 'sector does not apply to crypto' };
      news = { frac: 0, na: true, note: 'news/event does not apply to crypto' };
    } else {
      let view = c.sectorView; if (view === undefined && stockSectorView) { try { view = await stockSectorView(c.symbol); } catch { view = null; } }
      sector = scoreSector(view, side);
      let n = c.newsScore; if (n === undefined && newsScoreFn) { try { n = await newsScoreFn(c.symbol); } catch { n = null; } }
      news = scoreNews(n, side, cfg);
      if (sector.against) blocks.push(`sector block: ${sector.note}, against a ${side}`);
      if (news.blocked) blocks.push(`news block: ${news.note}, against a ${side}`);
    }
    const time = scoreTime(c, cfg);

    const results = { r_factor: r, pattern: p, smc, ema_trend: ema, sector, news, time };
    const na = HELPERS2.filter((h) => results[h].na || results[h].unavailable);
    const active = HELPERS2.filter((h) => !na.includes(h));
    const weights = cfg.weights;
    const totalW = active.reduce((s, h) => s + Math.max(0, Number(weights[h]) || 0), 0) || 100;

    const contributions = {};
    let sum = 0;
    for (const h of HELPERS2) {
      if (na.includes(h)) { contributions[h] = null; continue; }
      const w = Math.max(0, Number(weights[h]) || 0) / totalW * 100;
      contributions[h] = r1(results[h].frac * w);
      sum += results[h].frac * w;
    }
    const score = clamp(r1(sum), 0, 100);
    const blocked = blocks.length ? blocks.join('; ') : null;
    const take = !blocked && score >= cfg.take_threshold;
    const excluded = na.length ? ` (excluded, rescaled: ${na.map((h) => h.replace('_', ' ')).join(', ')})` : '';
    const parts = active.map((h) => `${h.replace('_', ' ')} ${contributions[h]}`).join(', ');
    const basis = blocked
      ? `Judge v2 not taken: ${blocked}. Score would have been ${score}/100 (${parts})${excluded}.`
      : `Judge v2: ${side} scores ${score}/100, needs ${cfg.take_threshold} (${parts})${excluded}. ${take ? 'Would take.' : 'Would not take.'} Parallel only - never used for a live decision.`;
    return { score, take, basis, contributions, blocked, na, threshold: cfg.take_threshold };
  }
  judge2.config = cfg;
  return judge2;
}

// What to store with the trade/skip row (new columns in sql/paper_bot.sql).
function tradeFields2(decision) {
  return { judge2_score: decision.score, judge2_take: decision.take, judge2_contributions: decision.contributions, judge2_basis: decision.basis };
}

let shared = null;
const judge2 = (candidate) => (shared || (shared = createJudge2()))(candidate);

module.exports = { judge2, createJudge2, tradeFields2, JUDGE2_DEFAULTS, HELPERS2, scoreSmc, scoreEmaTrend };
