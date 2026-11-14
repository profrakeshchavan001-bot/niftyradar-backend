'use strict';
// Shared support/resistance + level-based exit planning (CC2, item 1a).
// Re-exported from paperbot/ (swing levels from rfactor.js, order
// blocks/FVG/previous-period levels and trade planning from cryptoLevels.js)
// so other bots can reuse the same levels without duplicating the logic.
const { swingLevels, prevDayLevels } = require('../../../paperbot/rfactor');
const CL = require('../../../paperbot/cryptoLevels');

module.exports = {
  swingLevels,
  prevDayLevels,
  previousPeriods: CL.previousPeriods,
  orderBlockLevels: CL.orderBlockLevels,
  fvgLevels: CL.fvgLevels,
  collectLevels: CL.collectLevels,
  planTrade: CL.planTrade,
  manageTrade: CL.manageTrade,
  legacyLevels: CL.legacyLevels,
  legacyOutcome: CL.legacyOutcome,
};
