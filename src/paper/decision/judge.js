'use strict';
// THE JUDGE: combines every helper into ONE decision with a 0-100 score.
//   judge(candidate) -> { score, take, basis, contributions, blocked, unavailable, threshold }
// Helpers and their default points (paper_config key "judge", the table wins, the bot NEVER changes it by itself):
//   r_factor 25 (real risk-reward), pattern 25 (candle / SMC), sector 20, news 10, market_trend 10 (Nifty 15-min), time 10.
// Hard blocks (the trade is not taken whatever the score): event block, news score below -40 against the trade, sector against the trade.
// Take only if score >= 65. Contributions are stored with every trade (see sql/paper_bot.sql) so ablation() can measure each helper later.
// Docs: docs/JUDGE.md. Plain CommonJS, no dependencies.
const { istParts } = require('../../../paperbot/time');

const HELPERS = ['r_factor', 'pattern', 'sector', 'news', 'market_trend', 'time'];

const JUDGE_DEFAULTS = {
  weights: { r_factor: 25, pattern: 25, sector: 20, news: 10, market_trend: 10, time: 10 },
  take_threshold: 65, // take a trade only when the score is at least this
  r_zero: 1, // risk-reward at or below this earns 0 points
  r_full: 3, // risk-reward at or above this earns all points
  news_block: -40, // a news score this bad AGAINST the trade is a hard block (long: below -40, short: above +40)
  news_block_mirror: true, // false = block any score below -40 whatever the direction
  avoid_first_min: 15, // minutes after the 09:15 IST open without points
  avoid_last_min: 30, // minutes before the 15:30 IST close without points
  open_min: 555, // 09:15 IST in minutes
  close_min: 930, // 15:30 IST in minutes
  pattern_extra: 0.1, // each further confirming pattern adds this to the strongest one (max 1)
  pattern_strength: {
    order_block: 0.9, fvg_retest: 0.85, liquidity_sweep: 0.85, exhaustion_reversal: 0.8, morning_star: 0.75, evening_star: 0.75,
    bullish_engulfing: 0.7, bearish_engulfing: 0.7, hammer: 0.6, shooting_star: 0.6, inside_bar_breakout: 0.55,
  },
  pattern_default: 0.5, // a pattern name that is not in the table
  support_fraction: 0.5, // ablation: a helper "supported" a trade when it earned at least this share of its points
  min_trades_for_conclusion: 20,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v)); // null must not count as 0
const r1 = (x) => Math.round(x * 10) / 10;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (isObj(v) && isObj(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

// Reads the "judge" row of paper_config through the existing store API (getConfig / setConfigIfMissing) and lays it over the defaults.
async function loadJudgeConfig(store) {
  const rows = await store.getConfig();
  if (!('judge' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('judge', JUDGE_DEFAULTS);
  return merge(JUDGE_DEFAULTS, rows.judge);
}

function sideOf(direction) {
  const d = String(direction || '').toLowerCase();
  if (['long', 'call', 'up', 'buy'].includes(d)) return 'long';
  if (['short', 'put', 'down', 'sell'].includes(d)) return 'short';
  return null;
}

function istMinutes(time) {
  if (time && typeof time === 'object' && Number.isFinite(time.istMinutes)) return time.istMinutes;
  const ms = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : Date.parse(time);
  return Number.isFinite(ms) ? istParts(ms).minutes : null;
}

// ---- one scorer per helper: each returns { frac 0..1, note, unavailable? } ----------------------------------------------------------------
function scoreR(c, cfg) {
  const r = num(c.rFactor);
  if (!Number.isFinite(r)) return { frac: 0, note: 'no real R factor given', unavailable: true };
  const frac = clamp((r - cfg.r_zero) / (cfg.r_full - cfg.r_zero), 0, 1);
  return { frac, note: `reward is ${r1(r)}x the risk` };
}

function scorePattern(c, cfg, side) {
  const list = (c.patterns || []).map((p) => (typeof p === 'string' ? { name: p } : { name: p.name || p.pattern, direction: p.direction })).filter((p) => p.name);
  const aligned = list.filter((p) => !p.direction || sideOf(p.direction) === side);
  const against = list.length - aligned.length;
  if (!aligned.length) return { frac: 0, note: list.length ? 'the patterns point the other way' : 'no pattern' };
  const strengths = aligned.map((p) => (p.name in cfg.pattern_strength ? cfg.pattern_strength[p.name] : cfg.pattern_default)).sort((a, b) => b - a);
  const frac = clamp(strengths[0] + cfg.pattern_extra * (strengths.length - 1) - (against ? cfg.pattern_extra * against : 0), 0, 1);
  return { frac, note: `${aligned.map((p) => p.name.replace(/_/g, ' ')).join(' + ')}${against ? ` (${against} pattern${against > 1 ? 's' : ''} against)` : ''}` };
}

function scoreSector(view, side) {
  if (!view || !Number.isFinite(num(view.score))) return { frac: 0.5, note: 'no sector view', unavailable: true };
  const s = clamp(num(view.score), 0, 100);
  const label = String(view.label || '').toLowerCase();
  const weak = label === 'weak' || (!label && s < 35);
  const strong = label === 'strong' || (!label && s > 65);
  const frac = side === 'long' ? s / 100 : 1 - s / 100;
  const against = (side === 'long' && weak) || (side === 'short' && strong);
  return { frac, against, note: `${view.sector || 'sector'} is ${label || (weak ? 'weak' : strong ? 'strong' : 'neutral')} (${Math.round(s)}/100)` };
}

function scoreNews(n, side, cfg) {
  if (isObj(n)) n = n.score; // the news module answers { score, label, headlines ... } (null when no source answered); a plain number is accepted too
  if (!Number.isFinite(num(n))) return { frac: 0.5, note: 'no news score', unavailable: true };
  const v = clamp(num(n), -100, 100);
  const frac = side === 'long' ? (v + 100) / 200 : (100 - v) / 200;
  const blocked = cfg.news_block_mirror ? (side === 'long' ? v < cfg.news_block : v > -cfg.news_block) : v < cfg.news_block;
  return { frac, blocked, note: `news score ${Math.round(v)}` };
}

function scoreTrend(t, side) {
  const state = String((isObj(t) ? t.state || t.trend15 : t) || '').toLowerCase();
  if (!state) return { frac: 0.5, note: 'no Nifty trend', unavailable: true };
  const want = side === 'long' ? 'up' : 'down';
  if (state === want) return { frac: 1, note: `Nifty 15-min trend is ${state}, with the trade` };
  if (state === 'flat') return { frac: 0.5, note: 'Nifty 15-min trend is flat' };
  return { frac: 0, note: `Nifty 15-min trend is ${state}, against the trade` };
}

function scoreTime(c, cfg) {
  if (String(c.market || 'nse').toLowerCase() === 'crypto') return { frac: 0.5, note: 'crypto trades around the clock, time not scored' };
  const m = istMinutes(c.time);
  if (m === null) return { frac: 0.5, note: 'no time given', unavailable: true };
  const hh = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const from = cfg.open_min + cfg.avoid_first_min;
  const to = cfg.close_min - cfg.avoid_last_min;
  if (m < cfg.open_min || m >= cfg.close_min) return { frac: 0, note: `${hh} IST is outside market hours` };
  if (m < from) return { frac: 0, note: `${hh} IST is in the first ${cfg.avoid_first_min} minutes, avoided` };
  if (m >= to) return { frac: 0, note: `${hh} IST is in the last ${cfg.avoid_last_min} minutes, avoided` };
  return { frac: 1, note: `${hh} IST is in the steady part of the day` };
}

// Helpers come from the sector (CC4) and news (CC3) modules; if a module is not there yet the helper is "unavailable" and earns half its points.
function defaultHelpers() {
  const load = (p) => { try { return require(p); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return null; throw e; } };
  const sector = load('../context/sector');
  const news = load('../context/news');
  return { stockSectorView: sector && sector.stockSectorView, newsScore: news && news.newsScore, eventBlock: news && news.eventBlock };
}

// createJudge({ config, stockSectorView, newsScore, eventBlock }) -> judge(candidate). Stubs are passed in tests.
function createJudge(opts = {}) {
  const def = opts.stockSectorView || opts.newsScore || opts.eventBlock ? {} : defaultHelpers();
  const stockSectorView = opts.stockSectorView || def.stockSectorView || null;
  const newsScoreFn = opts.newsScore || def.newsScore || null;
  const eventBlockFn = opts.eventBlock || def.eventBlock || null;
  const cfg = merge(JUDGE_DEFAULTS, opts.config);

  async function judge(candidate) {
    const c = candidate || {};
    const side = sideOf(c.direction);
    const unavailable = [];
    const weights = cfg.weights;
    const totalW = HELPERS.reduce((s, h) => s + Math.max(0, Number(weights[h]) || 0), 0) || 100;
    const blocks = [];
    const notes = {};
    const frac = {};

    if (!side) return { score: 0, take: false, basis: 'Not taken: the trade direction is missing, so nothing can be judged.', contributions: Object.fromEntries(HELPERS.map((h) => [h, 0])), blocked: 'no direction', unavailable: [], threshold: cfg.take_threshold };

    // event block (hard)
    let ev = null;
    if (typeof c.eventBlock === 'object' && c.eventBlock) ev = c.eventBlock;
    else if (eventBlockFn) { try { ev = await eventBlockFn(c.symbol); } catch { ev = null; } }
    if (ev && ev.block) blocks.push(`event block: ${ev.reason || 'an event is due'}`);

    // helpers (each may be handed in already computed on the candidate, else asked from the module)
    const r = scoreR(c, cfg); if (r.unavailable) unavailable.push('r_factor');
    const p = scorePattern(c, cfg, side);
    let view = c.sectorView; if (view === undefined && stockSectorView) { try { view = await stockSectorView(c.symbol); } catch { view = null; } }
    const sc = scoreSector(view, side); if (sc.unavailable) unavailable.push('sector');
    let n = c.newsScore; if (n === undefined && newsScoreFn) { try { n = await newsScoreFn(c.symbol); } catch { n = null; } }
    const nw = scoreNews(n, side, cfg); if (nw.unavailable) unavailable.push('news');
    const tr = scoreTrend(c.niftyTrend, side); if (tr.unavailable) unavailable.push('market_trend');
    const tm = scoreTime(c, cfg); if (tm.unavailable) unavailable.push('time');
    Object.assign(frac, { r_factor: r.frac, pattern: p.frac, sector: sc.frac, news: nw.frac, market_trend: tr.frac, time: tm.frac });
    Object.assign(notes, { r_factor: r.note, pattern: p.note, sector: sc.note, news: nw.note, market_trend: tr.note, time: tm.note });

    if (sc.against) blocks.push(`sector block: ${sc.note}, against a ${side}`);
    if (nw.blocked) blocks.push(`news block: ${nw.note}, against a ${side}`);

    const contributions = {};
    let sum = 0;
    for (const h of HELPERS) {
      const w = Math.max(0, Number(weights[h]) || 0) / totalW * 100; // weights are scaled so the score is always 0-100
      contributions[h] = r1(frac[h] * w);
      sum += frac[h] * w;
    }
    const score = clamp(r1(sum), 0, 100);
    const blocked = blocks.length ? blocks.join('; ') : null;
    const take = !blocked && score >= cfg.take_threshold;

    const parts = HELPERS.map((h) => `${h.replace('_', ' ')} ${contributions[h]}`).join(', ');
    const basis = blocked
      ? `Not taken: ${blocked}. Score would have been ${score}/100 (${parts}).`
      : take
        ? `Taken: ${side} scores ${score}/100, needs ${cfg.take_threshold}. ${notes.r_factor}; ${notes.pattern}; ${notes.sector}; ${notes.news}; ${notes.market_trend}; ${notes.time}.`
        : `Not taken: ${side} scores ${score}/100, needs ${cfg.take_threshold}. Weakest: ${weakest(frac, weights, notes)}.`;
    return { score, take, basis, contributions, blocked, unavailable, threshold: cfg.take_threshold };
  }
  judge.config = cfg;
  return judge;
}

function weakest(frac, weights, notes) {
  const lost = HELPERS.map((h) => [h, (1 - frac[h]) * (Number(weights[h]) || 0)]).sort((a, b) => b[1] - a[1])[0][0];
  return `${lost.replace('_', ' ')} (${notes[lost]})`;
}

// What to store with the trade row (columns in sql/paper_bot.sql).
function tradeFields(decision) {
  return { judge_score: decision.score, judge_take: decision.take, judge_contributions: decision.contributions, judge_basis: decision.basis };
}

// ---- weekly ABLATION: does a helper add value? ------------------------------------------------------------------------------------------
// For every helper: closed trades where it SUPPORTED the trade (earned at least support_fraction of its points) versus the trades where it did not,
// with win rate and average P&L of each group. A comparison needs at least min_trades_for_conclusion trades in EACH group, otherwise it says
// "too few trades, no conclusion". It only suggests; it never changes a weight. The owner approves.
function ablation(closed, config = {}) {
  const cfg = merge(JUDGE_DEFAULTS, config);
  const min = cfg.min_trades_for_conclusion;
  const rows = (closed || []).filter((t) => t && t.status !== 'open' && Number.isFinite(Number(t.pnl_inr)) && isObj(t.judge_contributions));
  const stat = (list) => {
    const wins = list.filter((t) => Number(t.pnl_inr) > 0).length;
    return { trades: list.length, winRatePct: list.length ? r1((wins / list.length) * 100) : null, avgPnlInr: list.length ? Math.round((list.reduce((s, t) => s + Number(t.pnl_inr), 0) / list.length) * 100) / 100 : null };
  };
  const out = HELPERS.map((h) => {
    const w = Number(cfg.weights[h]) || 0;
    const have = rows.filter((t) => Number.isFinite(Number(t.judge_contributions[h])));
    const withH = have.filter((t) => w > 0 && Number(t.judge_contributions[h]) >= cfg.support_fraction * w);
    const without = have.filter((t) => !withH.includes(t));
    const a = stat(withH); const b = stat(without);
    const enough = a.trades >= min && b.trades >= min;
    let verdict; let suggestion;
    if (!enough) { verdict = 'too few trades, no conclusion'; suggestion = 'Keep the weight as it is.'; } else {
      const dWin = r1(a.winRatePct - b.winRatePct); const dPnl = Math.round((a.avgPnlInr - b.avgPnlInr) * 100) / 100;
      if (dWin >= 5 && dPnl > 0) { verdict = 'adds value'; suggestion = `Idea for the owner: keep, maybe raise the weight (now ${w}).`; } else if (dWin <= -5 && dPnl < 0) { verdict = 'does not add value (trades it liked did worse)'; suggestion = `Idea for the owner: consider lowering the weight (now ${w}).`; } else { verdict = 'no clear difference'; suggestion = 'Keep the weight as it is.'; }
    }
    return { helper: h, weight: w, with: a, without: b, trades: have.length, enough, verdict, suggestion,
      winRateEdgePts: enough ? r1(a.winRatePct - b.winRatePct) : null, avgPnlEdgeInr: enough ? Math.round((a.avgPnlInr - b.avgPnlInr) * 100) / 100 : null };
  });
  return out;
}

const inr = (x) => (x === null || x === undefined ? '-' : `Rs ${x >= 0 ? '+' : '-'}${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);

// Sunday text + data, same shape as the other reports ({ text, data }). Nothing in it is applied.
function weeklyAblationReport({ date, closed, config } = {}) {
  const cfg = merge(JUDGE_DEFAULTS, config);
  const rows = ablation(closed, cfg);
  const lines = ['NiftyRadar PAPER bot: which helper adds value (weekly)', `Week ending ${date || ''}`.trim(), 'Nothing below is applied. Weights change only when the owner says so.', ''];
  const judged = (closed || []).filter((t) => t && isObj(t.judge_contributions)).length;
  if (!judged) lines.push('No closed trades with judge points yet.');
  for (const r of rows) {
    lines.push(`${r.helper} (weight ${r.weight}): ${r.trades} trades.`);
    if (!r.enough) lines.push(`  Too few trades, no conclusion (with: ${r.with.trades}, without: ${r.without.trades}, each group needs ${cfg.min_trades_for_conclusion}).`);
    else {
      lines.push(`  With its points: ${r.with.trades} trades, win ${r.with.winRatePct}%, avg ${inr(r.with.avgPnlInr)}.`);
      lines.push(`  Without: ${r.without.trades} trades, win ${r.without.winRatePct}%, avg ${inr(r.without.avgPnlInr)}.`);
      lines.push(`  Verdict: ${r.verdict}. ${r.suggestion}`);
    }
  }
  return { text: lines.join('\n'), data: { date, helpers: rows } };
}

// Ready-made judge with the real helper modules (or neutral half points for a helper whose module is not on this branch yet). Returns a Promise.
let shared = null;
const judge = (candidate) => (shared || (shared = createJudge()))(candidate);

module.exports = {
  judge, createJudge, loadJudgeConfig, tradeFields, ablation, weeklyAblationReport, JUDGE_DEFAULTS, HELPERS, merge, sideOf,
  // Additive exports (CC2 round 2, judge2.js): the individual scorers, reused rather than duplicated.
  scoreR, scorePattern, scoreSector, scoreNews, scoreTrend, scoreTime, clamp, num, r1, isObj,
};
