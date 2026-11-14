'use strict';
// CC3 round 3 item 1: measures, with fixtures and a throwaway Postgres, the scan time, DB query count and memory use of ONE full
// cycle (scan + monitor) of every bot, run back to back as they would be on a live Render Free instance. Writes nothing live:
// candles come from hand-built fixtures (no Binance/Yahoo), the store is a real Postgres the caller points PAPER_DATABASE_URL at.
// Usage: PAPER_DATABASE_URL=postgres://... node tools/stability-check.js
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.env.PAPER_DATABASE_URL;
  if (!url) { console.error('Set PAPER_DATABASE_URL to a throwaway Postgres first.'); process.exit(1); }
  const pool = new Pool({ connectionString: url, max: 2 });
  let queryCount = 0;
  const rawQuery = pool.query.bind(pool);
  pool.query = (...args) => { queryCount += 1; return rawQuery(...args); };

  for (const f of ['sql/paper_bot.sql', 'src/paper/bots/exhaustion_only/schema.sql', 'src/paper/bots/trend_smc/schema.sql', 'src/paper/shadow/schema.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  }
  queryCount = 0; // schema setup does not count towards a scan cycle's own cost

  const { createPgStore } = require('../paperbot/store');
  const { createPgExhaustionStore } = require('../src/paper/bots/exhaustion_only/store');
  const { createPgTrendSmcStore } = require('../src/paper/bots/trend_smc/store');
  const { createPgShadowStore } = require('../src/paper/shadow/store');
  const { createScalpBot } = require('../src/paper/scalp/bot');
  const { createExhaustionBot } = require('../src/paper/bots/exhaustion_only/bot');
  const { createTrendSmcBot } = require('../src/paper/bots/trend_smc/bot');
  const { EXHAUSTION_ONLY_DEFAULTS } = require('../src/paper/bots/exhaustion_only/config');
  const { TREND_SMC_DEFAULTS } = require('../src/paper/bots/trend_smc/config');
  const { scene, sceneWide } = require('../test/scalpFixtures');

  const mainStore = createPgStore(pool);
  const shadowStore = createPgShadowStore(pool);

  // Fixtures: the same hand-built candles the test suite already uses, no network, deterministic.
  const s1 = scene();
  const sw = sceneWide();
  const MIN = 60000; const FIVE = 5 * MIN;
  const eoPadded = (() => {
    const pad = Array.from({ length: 12 }, (_, i) => ({ t: i * FIVE, o: 110, h: 110.01, l: 109.99, c: 110, v: 1 }));
    const out = []; let px = 102.0; let t = 12 * FIVE;
    for (let i = 0; i < 32; i++) { out.push({ t, o: px, h: px + 0.025, l: px - 0.075, c: px - 0.05, v: 10 }); px = +(px - 0.05).toFixed(4); t += FIVE; }
    out.push({ t, o: 100.40, h: 100.405, l: 100.38, c: 100.39, v: 10 }); t += FIVE;
    out.push({ t, o: 100.39, h: 100.45, l: 100.385, c: 100.44, v: 10 });
    return [...pad, ...out];
  })();
  const eoNow = eoPadded[eoPadded.length - 1].t + FIVE + 5000;

  const results = [];
  async function measure(name, fn) {
    const before = process.memoryUsage().rss;
    const qBefore = queryCount;
    const t0 = Date.now();
    await fn();
    const ms = Date.now() - t0;
    const after = process.memoryUsage().rss;
    results.push({ name, ms, queries: queryCount - qBefore, rssDeltaMb: ((after - before) / 1048576).toFixed(2) });
  }

  // scalp (tight + wide)
  {
    const crypto = { candles: async () => s1.c5raw, usdtInr: async () => ({ rate: 88, source: 'x' }) };
    const source1m = { candles1m: async () => s1.c1raw };
    const bot = createScalpBot({ store: mainStore, crypto, source1m, shadowStore, now: () => s1.now, log: () => {} });
    await measure('scalp scan', () => bot.cryptoScalpScan());
    await measure('scalp monitor', () => bot.cryptoScalpMonitor());
    const cryptoW = { candles: async () => sw.c5raw, usdtInr: async () => ({ rate: 88, source: 'x' }) };
    const botW = createScalpBot({ store: mainStore, crypto: cryptoW, source1m, shadowStore, now: () => sw.now, log: () => {} });
    await measure('scalp_wide scan', () => botW.cryptoScalpWideScan());
    await measure('scalp_wide monitor', () => botW.cryptoScalpWideMonitor());
  }
  // exhaustion_only
  {
    const eStore = createPgExhaustionStore(pool);
    const crypto = { candles: async () => eoPadded, hourly: async () => [], usdtInr: async () => ({ rate: 88, source: 'x' }) };
    const bot = createExhaustionBot({ store: eStore, crypto, loadCfg: async () => EXHAUSTION_ONLY_DEFAULTS, shadowStore, now: () => eoNow, log: () => {} });
    await measure('exhaustion_only scan', () => bot.scan());
    await measure('exhaustion_only monitor', () => bot.monitor());
  }
  // trend_smc (reuses test/trendSmc.test.js's own fixture builders inline, kept small here)
  {
    const tStore = createPgTrendSmcStore(pool);
    const FIFTEEN = 900000;
    const pad = Array.from({ length: 21 }, (_, i) => ({ t: i * FIVE, o: 140, h: 150, l: 130, c: 140, v: 100 }));
    const rows = [[100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 104.2, 100, 104], [104, 105.2, 103.8, 105], [101.5, 102.6, 101, 102.5]];
    const c5 = [...pad, ...rows.map(([o, h, l, c], i) => ({ t: (21 + i) * FIVE, o, h, l, c, v: 100 }))];
    const nowMs = c5[c5.length - 1].t + FIVE + 5000;
    const ramp = Array.from({ length: 40 }, (_, i) => { const px = 90 + i * 0.25; const hh = i === 30 ? 130 : px + 0.2; return { t: i * FIFTEEN, o: px - 0.1, h: hh, l: px - 0.2, c: px + 0.1, v: 50 }; });
    const flat = Array.from({ length: 20 }, (_, i) => ({ t: (40 + i) * FIFTEEN, o: 100, h: 100.5, l: 99.5, c: 100, v: 50 }));
    const c15raw = [...ramp, ...flat];
    const shift = nowMs - FIFTEEN - c15raw[c15raw.length - 1].t;
    const c15 = c15raw.map((k) => ({ ...k, t: k.t + shift }));
    const crypto = { candles: async () => c5, hourly: async () => [], usdtInr: async () => ({ rate: 88, source: 'x' }) };
    const crypto15 = { candles15: async () => c15 };
    const bot = createTrendSmcBot({ store: tStore, crypto, crypto15, loadCfg: async () => TREND_SMC_DEFAULTS, shadowStore, now: () => nowMs, log: () => {} });
    await measure('trend_smc scan', () => bot.scan());
    await measure('trend_smc monitor', () => bot.monitor());
  }
  // shadow monitor pass (resolves any open shadows left by the scans above - already run as part of each bot's own monitor() above,
  // measured separately here to isolate its own cost on an otherwise-idle cycle)
  await measure('shadow: openShadows x3 bots (idle check)', async () => { await shadowStore.openShadows('scalp'); await shadowStore.openShadows('scalp_wide'); await shadowStore.openShadows('exhaustion_only'); await shadowStore.openShadows('trend_smc'); });

  const totalMs = results.reduce((s, r) => s + r.ms, 0);
  const totalQ = results.reduce((s, r) => s + r.queries, 0);
  console.log('\n| Job | ms | DB queries | RSS delta (MB) |');
  console.log('|---|---|---|---|');
  for (const r of results) console.log(`| ${r.name} | ${r.ms} | ${r.queries} | ${r.rssDeltaMb} |`);
  console.log(`| **TOTAL (one full cycle, all bots)** | **${totalMs}** | **${totalQ}** | - |`);
  console.log(`\nProcess RSS at end: ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
