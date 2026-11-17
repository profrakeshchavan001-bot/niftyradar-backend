'use strict';
// GBPINR config: own paper_config row ("ccy_gbpinr"), same CCY_WIDE_DEFAULTS every ccy_* pair starts from
// (src/paper/lib/currencyConfig.js) - the table wins once the owner changes a row, same convention as every
// other bot's config.js.
const { CCY_WIDE_DEFAULTS, loadCurrencyConfig } = require('../../lib/currencyConfig');

const PAIR_KEY = 'ccy_gbpinr';

async function loadConfig(store) {
  return loadCurrencyConfig(store, PAIR_KEY);
}

module.exports = { CCY_GBPINR_DEFAULTS: CCY_WIDE_DEFAULTS, PAIR_KEY, loadConfig };
