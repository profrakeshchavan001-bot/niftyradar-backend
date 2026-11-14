'use strict';
// Single entry point for the shared paper-bot library (CC2, item 1a).
// Other windows: require('../lib') (or the relative path to src/paper/lib)
// instead of reaching into paperbot/ directly.
module.exports = {
  ...require('./indicators'),
  ...require('./levels'),
  ...require('./candleCache'),
  ...require('./exitSim'),
};
