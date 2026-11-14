'use strict';
// Single entry point for the SMC/ICT detectors (CC2 round 2 item 2).
const { classifyStructureBreak } = require('./structure');
const { equalHighsLows, liquiditySweep, previousPeriods } = require('./liquidity');
const { orderBlock, orderBlockLevels } = require('./orderBlocks');
const { fvgRetest, fvgLevels } = require('./fvg');
const { classifyPremiumDiscount } = require('./premiumDiscount');
const { isDisplacement } = require('./displacement');
const { cryptoSession, nseDaySession } = require('./sessions');

// Runs every detector against the closed candles and returns a flat list of
// tag strings for `smc_tags` (sql/paper_bot.sql already has the column).
// Each detector is wrapped so one failing (too little data, bad input) never
// stops the others - the tag list is simply shorter, never thrown away.
// `market` picks the session classifier ('nse' -> nseDaySession, else crypto).
function tagSmc({ c5, nowMs, market = 'crypto' } = {}) {
  const tags = [];
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };

  const structure = safe(() => classifyStructureBreak(c5));
  if (structure && structure.type) tags.push(`${structure.type}_${structure.direction}`);

  const sweep = safe(() => liquiditySweep(c5));
  if (sweep) tags.push(`liquidity_sweep_${sweep.direction}`);

  const pools = safe(() => equalHighsLows(c5));
  if (pools) {
    if (pools.equalHighs.length) tags.push('equal_highs');
    if (pools.equalLows.length) tags.push('equal_lows');
  }

  const ob = safe(() => orderBlock(c5));
  if (ob) tags.push(`order_block_${ob.direction}`);

  const fvg = safe(() => fvgRetest(c5));
  if (fvg) tags.push(`fvg_retest_${fvg.direction}`);

  const pd = safe(() => classifyPremiumDiscount(c5));
  if (pd) tags.push(pd.zone);

  const disp = safe(() => isDisplacement(c5));
  if (disp && disp.displaced) tags.push(`displacement_${disp.direction}`);

  const session = safe(() => (market === 'nse' ? nseDaySession(nowMs) : cryptoSession(nowMs)));
  if (session) tags.push(`session_${session}`);

  return tags;
}

module.exports = {
  classifyStructureBreak, equalHighsLows, liquiditySweep, previousPeriods,
  orderBlock, orderBlockLevels, fvgRetest, fvgLevels,
  classifyPremiumDiscount, isDisplacement, cryptoSession, nseDaySession,
  tagSmc,
};
