'use strict';
// Filter study (brief item 7): suggestions only, nothing is applied automatically.
//
// Only min_rr (the reward/risk gate) is an actual on/off switch in the live scalp config
// (src/paper/scalp/config.js), so only that one gets a real "with it vs without it" replay run below.
// The 5-minute trend/VWAP agreement check and the pattern/SMC-tag list are hard-coded inside the real,
// imported analyse() (src/paper/scalp/engine.js) -- not config knobs -- so they cannot be switched off
// without forking that function, which the brief and docs/REPLAY.md both rule out ("import, never copy").
// For those, this reports a descriptive breakdown instead (how the trades that WERE taken did, grouped by
// which pattern fired), which is not a true ablation and is labelled as such everywhere it is shown.
const { replayScalp } = require('./simulator');
const { buildReport } = require('./stats');
const { classifyEmaCross } = require('../lib/emaCross');
const { aggregate } = require('../../../paperbot/engine');

const SMC_TAGS = ['order_block', 'fvg_retest', 'liquidity_sweep'];
const FIVE_MIN = 5 * 60000;

function minRrGateStudy({ symbol, candles1m, candles5m, cfg, fxRate }) {
  const on = replayScalp({ symbol, candles1m, candles5m, cfg, fxRate });
  const off = replayScalp({ symbol, candles1m, candles5m, cfg: { ...cfg, min_rr: 0 }, fxRate });
  return { withGate: buildReport(on), withoutGate: buildReport(off) };
}

// Descriptive only (see header): groups the trades a full run actually took by their first pattern name.
function byPatternBreakdown(trades) {
  const groups = new Map();
  for (const t of trades) {
    const key = (t.patterns && t.patterns[0]) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = {};
  for (const [k, rows] of groups) out[k] = buildReport(rows).overall;
  return out;
}

// Round 2 item 3: "each SMC tag, with/without" -- still descriptive (see header: SMC tags are not a config
// knob), but now a real with/without split per tag, not just a first-pattern grouping.
function bySmcTagBreakdown(trades) {
  const out = {};
  for (const tag of SMC_TAGS) {
    const has = trades.filter((t) => (t.patterns || []).includes(tag));
    const without = trades.filter((t) => !(t.patterns || []).includes(tag));
    out[tag] = { withTag: buildReport(has).overall, withoutTag: buildReport(without).overall };
  }
  return out;
}

// Round 2 item 3: EMA cross with/without, using the REAL, imported classifyEmaCross() (src/paper/lib/emaCross.js,
// CC2) recomputed at each trade's own trigger candle from the stored history -- descriptive (the live bot
// never hard-blocks on this either, "a warning, never certain", docs/BOT-INTERFACE.md item 5), grouping
// trades into whether the EMA cross agreed with the trade's direction at entry or not.
function byEmaCrossBreakdown(trades, candles5m) {
  const groups = { fresh_with: [], confirmed_with: [], fresh_against: [], confirmed_against: [], mixed: [], fresh_flat: [], unknown: [] };
  for (const t of trades) {
    const upto = candles5m.filter((k) => k.t + FIVE_MIN <= t.entry_t);
    const c15 = aggregate(upto);
    const c1h = aggregate(upto, FIVE_MIN, 3600000);
    const direction = t.direction === 'LONG' ? 'up' : 'down';
    const label = classifyEmaCross({ direction, c5: upto, c15, c1h });
    (groups[label] || (groups[label] = [])).push(t);
  }
  const out = {};
  for (const [label, rows] of Object.entries(groups)) out[label] = buildReport(rows).overall;
  return out;
}

function runFilterStudy({ symbol, candles1m, candles5m, cfg, fxRate, baseTrades }) {
  return {
    note: 'Suggestions only; nothing here changes the live bot automatically.',
    minRrGate: minRrGateStudy({ symbol, candles1m, candles5m, cfg, fxRate }),
    byPatternDescriptive: {
      note: 'Descriptive only, NOT an ablation: these are the trades the live rules already took, grouped by pattern. '
        + 'The pattern/SMC-tag list and the trend+VWAP agreement check are hard-coded in the imported analyse(), not config knobs, so they cannot be switched off here.',
      ...byPatternBreakdown(baseTrades),
    },
    bySmcTag: { note: 'Descriptive only: with vs without each SMC tag present on the trade.', ...bySmcTagBreakdown(baseTrades) },
    byEmaCross: { note: 'Descriptive only: the live bot never hard-blocks on EMA cross, only warns ("a warning, never certain").', ...byEmaCrossBreakdown(baseTrades, candles5m) },
  };
}

module.exports = { runFilterStudy, minRrGateStudy, byPatternBreakdown, bySmcTagBreakdown, byEmaCrossBreakdown };
