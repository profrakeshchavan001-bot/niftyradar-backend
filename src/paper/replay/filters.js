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

function runFilterStudy({ symbol, candles1m, candles5m, cfg, fxRate, baseTrades }) {
  return {
    note: 'Suggestions only; nothing here changes the live bot automatically.',
    minRrGate: minRrGateStudy({ symbol, candles1m, candles5m, cfg, fxRate }),
    byPatternDescriptive: {
      note: 'Descriptive only, NOT an ablation: these are the trades the live rules already took, grouped by pattern. '
        + 'The pattern/SMC-tag list and the trend+VWAP agreement check are hard-coded in the imported analyse(), not config knobs, so they cannot be switched off here.',
      ...byPatternBreakdown(baseTrades),
    },
  };
}

module.exports = { runFilterStudy, minRrGateStudy, byPatternBreakdown };
