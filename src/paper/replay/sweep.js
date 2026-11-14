'use strict';
// Parameter sweep (brief "if time allows" item): stop/target multiplier grid, out-of-sample column next
// to in-sample, suggestions only -- nothing here changes the live config. Reuses the already-tested
// replayScalp()/buildReport()/splitInOutSample(), just varies the two real config knobs that scale the
// stop and target caps (stop_cap_pct, target_cap_pct); every number still comes from the real, imported
// analyse()/evaluateExit()/settle().
const { replayScalp } = require('./simulator');
const { buildReport, splitInOutSample } = require('./stats');

const DAY = 86400000;
const DEFAULT_MULTIPLIERS = [0.5, 0.75, 1, 1.25, 1.5];

// One cell of the sweep: `cfg` with stop_cap_pct/target_cap_pct scaled by `stopMult`/`targetMult`.
function sweepCell({ symbol, candles1m, candles5m, cfg, fxRate, stopMult, targetMult, windowStartMs, inSampleDays }) {
  const cellCfg = { ...cfg, stop_cap_pct: cfg.stop_cap_pct * stopMult, target_cap_pct: cfg.target_cap_pct * targetMult };
  const trades = replayScalp({ symbol, candles1m, candles5m, cfg: cellCfg, fxRate });
  const { inSample, outSample } = splitInOutSample(trades, { windowStartMs, inSampleDays });
  return { stopMult, targetMult, inSample: buildReport(inSample).overall, outSample: buildReport(outSample).overall };
}

// Runs the full grid for one symbol's already-loaded candle history. `multipliers` defaults to a modest
// 5x5 grid (25 cells) so a sweep stays cheap even on Render Free.
function runSweep({ symbol, candles1m, candles5m, cfg, fxRate = 88, windowStartMs, inSampleDays = 20, multipliers = DEFAULT_MULTIPLIERS }) {
  const grid = [];
  for (const stopMult of multipliers) {
    for (const targetMult of multipliers) {
      grid.push(sweepCell({ symbol, candles1m, candles5m, cfg, fxRate, stopMult, targetMult, windowStartMs, inSampleDays }));
    }
  }
  return { symbol, note: 'Suggestions only; nothing here changes the live config. Read the out-of-sample column, not the in-sample one.', grid };
}

module.exports = { runSweep, sweepCell, DEFAULT_MULTIPLIERS, DAY };
