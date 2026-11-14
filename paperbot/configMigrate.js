'use strict';
// CC3 urgent fix item 3: one clear precedence rule, decided and documented here - the stored paper_config row ALWAYS wins over the
// code default (docs/SCALP.md etc already say this: "the table wins"). The actual bug was not the rule, it was that `scalp`'s
// row was created with min_rr: 1.3 BEFORE PR #25 lowered the code default to 1.0 - setConfigIfMissing only ever writes once, on
// the very first run, so that stale 1.3 was stuck in the database forever afterwards, silently overriding the new 1.0 default on
// every later deploy. This runs once at startup and migrates ONLY that one known-stale value, idempotently: it checks the stored
// value is still exactly the old default before touching it, so running it twice (or on a database that was already fixed by
// hand) is always a safe no-op, and it never touches a value the owner changed on purpose to something else.
const STALE_DEFAULTS = [
  { key: 'scalp', field: 'min_rr', from: 1.3, to: 1.0, reason: 'PR #25 lowered the code default from 1.3 to 1.0; the stored row predated that PR' },
];

async function migrateStaleConfigDefaults(store, log = console.log) {
  const rows = await store.getConfig();
  const migrated = [];
  for (const { key, field, from, to, reason } of STALE_DEFAULTS) {
    const stored = rows[key];
    if (stored && stored[field] === from) {
      await store.setConfig(key, { ...stored, [field]: to });
      log(`[paperbot] config migration: paper_config.${key}.${field} was the stale default ${from}, set to ${to} (${reason})`);
      migrated.push({ key, field, from, to });
    }
  }
  return migrated;
}

module.exports = { migrateStaleConfigDefaults, STALE_DEFAULTS };
