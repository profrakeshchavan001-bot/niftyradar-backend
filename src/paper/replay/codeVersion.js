'use strict';
// A short hash of the real decision files this replay runs, so "run again when a bot's code version
// changes" (brief item 6) can compare against the last stored run without guessing a version number.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WATCHED = [
  path.join(__dirname, '..', 'scalp', 'engine.js'),
  path.join(__dirname, '..', 'scalp', 'config.js'),
  path.join(__dirname, '..', '..', '..', 'paperbot', 'engine.js'),
  path.join(__dirname, '..', '..', '..', 'paperbot', 'patterns.js'),
];

function codeVersion() {
  const h = crypto.createHash('sha256');
  for (const f of WATCHED) { try { h.update(fs.readFileSync(f)); } catch (e) { h.update(`missing:${f}`); } }
  return h.digest('hex').slice(0, 16);
}

module.exports = { codeVersion, WATCHED };
