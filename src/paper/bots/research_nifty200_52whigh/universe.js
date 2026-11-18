'use strict';
// Same Nifty200-like proxy universe the backtest used (research/strategies/universe.py) - this repo has
// no official Nifty 200 constituent list (nseindia.com unreachable), so S6's live demo bot reuses the
// exact same ~129-name hand-built liquid large/mid-cap list the backtest ran on, for an apples-to-apples
// comparison between the backtested numbers and what this live bot actually does.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', '..', '..', 'data');

function loadFnoUniverse() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'nse-fno-top60.json'), 'utf8')).symbols;
}

// Copied verbatim from research/strategies/universe.py's _EXTRA_LARGE_MID_CAPS - keep the two lists in
// sync if either changes, so the live bot and the backtest never silently diverge.
const EXTRA_LARGE_MID_CAPS = [
  'LTIM', 'DABUR', 'GODREJCP', 'PIDILITIND', 'SIEMENS', 'ABB', 'HAVELLS', 'VOLTAS', 'CROMPTON',
  'AMBUJACEM', 'SHREECEM', 'ACC', 'GODREJPROP', 'OBEROIRLTY', 'PRESTIGE', 'LUPIN', 'ZYDUSLIFE',
  'AUROPHARMA', 'TORNTPHARM', 'ALKEM', 'MPHASIS', 'PERSISTENT', 'COFORGE', 'LTTS', 'PAGEIND',
  'COLPAL', 'MARICO', 'UBL', 'BERGEPAINT', 'ICICIPRULI', 'ICICIGI', 'CHOLAFIN', 'MUTHOOTFIN',
  'PFC', 'RECLTD', 'IRFC', 'GAIL', 'IOC', 'PETRONET', 'NMDC', 'SAIL', 'JINDALSTEL', 'ASHOKLEY',
  'TVSMOTOR', 'BOSCHLTD', 'MOTHERSON', 'BHARATFORG', 'SRF', 'PIIND', 'DEEPAKNTR', 'AUBANK',
  'BANDHANBNK', 'FEDERALBNK', 'IDFCFIRSTB', 'YESBANK', 'ZOMATO', 'NYKAA', 'POLYCAB', 'DIXON',
  'ABCAPITAL', 'LICHSGFIN', 'INDIGO', 'CONCOR', 'GMRINFRA', 'ADANIGREEN', 'ADANIPOWER',
  'ADANIENSOL', 'JSWENERGY', 'TATACOMM', 'IDEA', 'INDUSTOWER', 'LODHA', 'PHOENIXLTD',
];

function loadNifty200Like() {
  const seen = new Set(); const out = [];
  for (const s of [...loadFnoUniverse(), ...EXTRA_LARGE_MID_CAPS]) {
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

module.exports = { loadNifty200Like };
