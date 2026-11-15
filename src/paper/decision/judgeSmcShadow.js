'use strict';
// JUDGE SMC SHADOW (Task Group B, docs/decisions/GROUP-A-MONDAY-READINESS.md item 3: "SMC/ICT tags
// feed judge2.js ... but not the live Judge's weight scheme ... flagged rather than redesigned on a
// deadline task"). This module answers that: it computes a SECOND, parallel decision for the SAME
// candidate the live Judge (judge.js) sees, with SMC/ICT tags scored as an added helper - and NOTHING
// ELSE. It never feeds a real take/skip decision. The only caller (paperbot/bot.js) only ever LOGS its
// result into its own table (paper_judge_shadows, sql/paper_bot.sql) next to what the real, unchanged
// Judge decided, for the owner to compare later.
//
// Gated end to end by JUDGE_SMC_LIVE (default OFF/false): with the flag off, paperbot/bot.js never
// requires or calls this module at all, so judge.js's real createJudge(), its weights and the ~20
// hand-worked tests in test/paperJudge.test.js stay byte-identical - flag or no flag, this file makes
// no change whatsoever to the live Judge itself.
//
// Weight choice (a judgment call, picked for simplicity - see the PR description): add `smc` as a 7th
// helper at weight 15, the SAME weight judge2.js already gives its own parallel SMC helper (chosen for
// consistency between the two parallel scorers, not picked fresh), and let it go through the EXACT
// SAME proportional renormalization every helper in judge.js's createJudge() already gets
// (`weight / totalW * 100`, copied below unchanged). This is "add a 7th helper and renormalize" - the
// simpler of the two options the task offered over hand-tuning every existing weight. With the
// defaults (25/25/20/10/10/10) plus smc's 15, totalW becomes 115, so the other six keep their relative
// shares and are all scaled down by the same 100/115 factor; nothing is subtracted from any one helper
// on purpose.
//
// SMC detection itself is NOT reimplemented: `scoreSmc` is reused as-is from judge2.js (which itself
// scores the `smc_tags` array paperbot/bot.js already builds from src/paper/lib/smc's tagSmc()).
// Every other helper scorer (R factor, pattern, sector, news, Nifty trend, time) is reused as-is from
// judge.js, via its existing additive exports.
const {
  scoreR, scorePattern, scoreSector, scoreNews, scoreTrend, scoreTime, clamp, r1, sideOf, merge, JUDGE_DEFAULTS,
} = require('./judge');
const { scoreSmc } = require('./judge2');

const SHADOW_HELPERS = ['r_factor', 'pattern', 'sector', 'news', 'market_trend', 'time', 'smc'];
const SMC_SHADOW_WEIGHT = 15; // matches judge2.js JUDGE2_DEFAULTS.weights.smc - see file comment above

const SHADOW_DEFAULTS = merge(JUDGE_DEFAULTS, { weights: { smc: SMC_SHADOW_WEIGHT }, smc_full_tags: 3 });

// Same module-loading convention as judge.js's defaultHelpers(): a missing module (not yet on this
// branch) just means that helper answers "unavailable" / neutral, never a thrown error.
function defaultHelpers() {
  const load = (p) => { try { return require(p); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return null; throw e; } };
  const sector = load('../context/sector');
  const news = load('../context/news');
  return { stockSectorView: sector && sector.stockSectorView, newsScore: news && news.newsScore, eventBlock: news && news.eventBlock };
}

// createShadowJudge({ config, stockSectorView, newsScore, eventBlock }) -> shadowJudge(candidate).
// `candidate` takes the same shape createJudge()'s judge(candidate) does (symbol, market, direction,
// rFactor, patterns, niftyTrend, time, and optionally already-resolved sectorView/newsScore/eventBlock),
// plus two SMC-only fields: `smcTags` (the smc_tags array paperbot/bot.js already computed via
// src/paper/lib/smc's tagSmc - never recomputed here) and `rawDir` ('up'/'down'; derived from
// `direction` when left out).
function createShadowJudge(opts = {}) {
  const def = opts.stockSectorView || opts.newsScore || opts.eventBlock ? {} : defaultHelpers();
  const stockSectorView = opts.stockSectorView || def.stockSectorView || null;
  const newsScoreFn = opts.newsScore || def.newsScore || null;
  const eventBlockFn = opts.eventBlock || def.eventBlock || null;
  const cfg = merge(SHADOW_DEFAULTS, opts.config);

  async function shadowJudge(candidate) {
    const c = candidate || {};
    const side = sideOf(c.direction);
    const unavailable = [];
    const weights = cfg.weights;
    const totalW = SHADOW_HELPERS.reduce((s, h) => s + Math.max(0, Number(weights[h]) || 0), 0) || 100;
    const blocks = [];
    const notes = {};
    const frac = {};

    if (!side) {
      return {
        score: 0, take: false, basis: 'Shadow (SMC) not taken: the trade direction is missing, so nothing can be judged.',
        contributions: Object.fromEntries(SHADOW_HELPERS.map((h) => [h, 0])), blocked: 'no direction', unavailable: [], threshold: cfg.take_threshold,
      };
    }

    // event block (hard) - same convention as judge.js
    let ev = null;
    if (typeof c.eventBlock === 'object' && c.eventBlock) ev = c.eventBlock;
    else if (eventBlockFn) { try { ev = await eventBlockFn(c.symbol); } catch { ev = null; } }
    if (ev && ev.block) blocks.push(`event block: ${ev.reason || 'an event is due'}`);

    const r = scoreR(c, cfg); if (r.unavailable) unavailable.push('r_factor');
    const p = scorePattern(c, cfg, side);
    let view = c.sectorView; if (view === undefined && stockSectorView) { try { view = await stockSectorView(c.symbol); } catch { view = null; } }
    const sc = scoreSector(view, side); if (sc.unavailable) unavailable.push('sector');
    let n = c.newsScore; if (n === undefined && newsScoreFn) { try { n = await newsScoreFn(c.symbol); } catch { n = null; } }
    const nw = scoreNews(n, side, cfg); if (nw.unavailable) unavailable.push('news');
    const tr = scoreTrend(c.niftyTrend, side); if (tr.unavailable) unavailable.push('market_trend');
    const tm = scoreTime(c, cfg); if (tm.unavailable) unavailable.push('time');
    const rawDir = c.rawDir || (side === 'long' ? 'up' : 'down');
    // judge2.js's scoreSmc() answers { frac: 0, na: true } when there are no SMC tags at all - its own
    // "exclude and rescale" convention (see judge2.js's file comment), which is DIFFERENT from judge.js's
    // (docs/JUDGE.md: an unavailable helper earns HALF its points, same as r_factor/sector/news/trend/time
    // here). Since this module extends the live Judge's scheme, not judge2's, a "no tags" reading is
    // normalised to that same half-credit convention rather than judge2's zero/na, so `smc` behaves like
    // every other helper in this file.
    const smcRaw = scoreSmc(c.smcTags, rawDir, cfg);
    const smc = smcRaw.na ? { frac: 0.5, note: smcRaw.note, unavailable: true } : smcRaw;
    if (smc.unavailable) unavailable.push('smc');

    Object.assign(frac, { r_factor: r.frac, pattern: p.frac, sector: sc.frac, news: nw.frac, market_trend: tr.frac, time: tm.frac, smc: smc.frac });
    Object.assign(notes, { r_factor: r.note, pattern: p.note, sector: sc.note, news: nw.note, market_trend: tr.note, time: tm.note, smc: smc.note });

    if (sc.against) blocks.push(`sector block: ${sc.note}, against a ${side}`);
    if (nw.blocked) blocks.push(`news block: ${nw.note}, against a ${side}`);

    const contributions = {};
    let sum = 0;
    for (const h of SHADOW_HELPERS) {
      const w = Math.max(0, Number(weights[h]) || 0) / totalW * 100; // same proportional renormalization as judge.js
      contributions[h] = r1(frac[h] * w);
      sum += frac[h] * w;
    }
    const score = clamp(r1(sum), 0, 100);
    const blocked = blocks.length ? blocks.join('; ') : null;
    const take = !blocked && score >= cfg.take_threshold;
    const parts = SHADOW_HELPERS.map((h) => `${h.replace('_', ' ')} ${contributions[h]}`).join(', ');
    const basis = blocked
      ? `Shadow (SMC) not taken: ${blocked}. Score would have been ${score}/100 (${parts}).`
      : `Shadow (SMC): ${side} scores ${score}/100, needs ${cfg.take_threshold} (${parts}). ${take ? 'Would take.' : 'Would not take.'} Shadow logging only (JUDGE_SMC_LIVE) - never a live decision.`;
    return { score, take, basis, contributions, blocked, unavailable, threshold: cfg.take_threshold };
  }
  shadowJudge.config = cfg;
  return shadowJudge;
}

module.exports = { createShadowJudge, SHADOW_HELPERS, SHADOW_DEFAULTS, SMC_SHADOW_WEIGHT };
