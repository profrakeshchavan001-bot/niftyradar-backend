'use strict';
// JPYINR orchestration: thin wrapper around the shared src/paper/lib/currencyBot.js factory - see that
// file's header for why the real logic (scalp_wide's analyseWide/evaluateExit, lot sizing, settlement) is
// not duplicated here. PAPER ONLY.
const { createCurrencyBot } = require('../../lib/currencyBot');

const MARKET = 'ccy_jpyinr';
const PAIR = 'JPYINR';

function createBot({ store, fx, loadCfg, loadHolidays, shadowStore, now, log }) {
  return createCurrencyBot({ pair: PAIR, label: MARKET, store, fx, loadCfg, loadHolidays, shadowStore, now, log });
}

module.exports = { createBot, MARKET, PAIR };
