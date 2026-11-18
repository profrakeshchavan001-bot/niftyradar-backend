'use strict';
// confluence_flow (Bot B) rules: Bot A's config plus the order-flow agreement gate. Stored under its own
// "confluence_flow" key in the main paper_config table - same convention as every other bot's config.js.
const { merge } = require('../../../../paperbot/config');
const { CONFLUENCE_DEFAULTS } = require('../confluence/config');

const CONFLUENCE_FLOW_DEFAULTS = {
  ...CONFLUENCE_DEFAULTS,
  capital_usdt: 1000, // own virtual balance, independent of confluence (Bot A) and every other bot
};

async function loadConfluenceFlowConfig(store) {
  const rows = await store.getConfig();
  if (!('confluence_flow' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('confluence_flow', CONFLUENCE_FLOW_DEFAULTS);
  return merge(CONFLUENCE_FLOW_DEFAULTS, rows.confluence_flow);
}

module.exports = { CONFLUENCE_FLOW_DEFAULTS, loadConfluenceFlowConfig };
