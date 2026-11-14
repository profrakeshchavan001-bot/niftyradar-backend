'use strict';
// Fair value gaps and retests: the candle-pattern detector (paperbot/patterns.js
// fvgRetest) and the level list (paperbot/cryptoLevels.js fvgLevels) -
// re-exported under src/paper/lib/smc/ (CC2 round 2 item 2), not rewritten.
const { fvgRetest } = require('../../../../paperbot/patterns');
const { fvgLevels } = require('../levels');

module.exports = { fvgRetest, fvgLevels };
