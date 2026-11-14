'use strict';
// Order blocks: the candle-pattern detector (paperbot/patterns.js orderBlock,
// fires on the last candle) and the level list (paperbot/cryptoLevels.js
// orderBlockLevels, every untested zone in the lookback) - re-exported under
// src/paper/lib/smc/ (CC2 round 2 item 2), not rewritten.
const { orderBlock } = require('../../../../paperbot/patterns');
const { orderBlockLevels } = require('../levels');

module.exports = { orderBlock, orderBlockLevels };
