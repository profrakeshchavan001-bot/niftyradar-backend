'use strict';
// Plugin loader for the paper-trading bot (CC2, item 1b, docs/BOT-INTERFACE.md).
//
// Any folder with a register.js directly under src/paper/bots/, src/paper/ops/
// or src/paper/replay/ is auto-loaded. This lets other windows (CC3: bots/ +
// scalp/, CC4: ops/ + context/, CC5: replay/) add a scheduled job, routes
// under /api/paper/ and their own idempotent schema, without ever editing
// paperbot/index.js or server.js.
//
// register.js contract:
//   module.exports = {
//     name: 'my-plugin',              // used only in logs
//     schemaSql: path.join(__dirname, 'schema.sql'), // optional, idempotent DDL
//     register(ctx) { ... },          // optional: app routes, cron jobs
//   };
// or simply: module.exports = function register(ctx) { ... };
//
// ctx passed to register(): { app, cron, env, log, state, store, guarded, tz, pool }
// A plugin that throws while loading or registering is logged and skipped;
// it never stops the server or the other plugins from loading.
const fs = require('fs');
const path = require('path');

const ROOTS = ['bots', 'ops', 'replay'];

function findPluginDirs(baseDir, log) {
  const found = [];
  for (const root of ROOTS) {
    const rootDir = path.join(baseDir, root);
    let names;
    try {
      names = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch (e) {
      continue; // root does not exist yet - fine, nothing to load
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(rootDir, entry.name);
      const registerPath = path.join(dir, 'register.js');
      if (fs.existsSync(registerPath)) found.push({ root, name: entry.name, dir, registerPath });
    }
  }
  return found;
}

async function runSchema(plugin, mod, pool, log) {
  const schemaPath = mod.schemaSql || (fs.existsSync(path.join(plugin.dir, 'schema.sql')) ? path.join(plugin.dir, 'schema.sql') : null);
  if (!schemaPath || !pool) return;
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    log(`[paper-plugins] ${plugin.root}/${plugin.name}: schema applied`);
  } catch (e) {
    log(`[paper-plugins] ${plugin.root}/${plugin.name}: schema failed - ${e.message}`);
  }
}

// Loads every plugin found under src/paper/{bots,ops,replay}/*/register.js.
// `ctx` is handed to each plugin's register() unchanged, plus a `pool`
// (optional pg Pool, so a plugin can run its own idempotent schema.sql).
async function loadPlugins(ctx = {}) {
  const log = ctx.log || console.log;
  const baseDir = ctx.baseDir || path.join(__dirname); // src/paper/
  const pool = ctx.pool || null;
  const plugins = findPluginDirs(baseDir, log);
  const loaded = [];
  for (const plugin of plugins) {
    try {
      const mod = require(plugin.registerPath);
      const register = typeof mod === 'function' ? mod : mod.register;
      await runSchema(plugin, mod, pool, log);
      if (typeof register === 'function') await register(ctx);
      loaded.push(`${plugin.root}/${plugin.name}`);
      log(`[paper-plugins] loaded ${plugin.root}/${plugin.name}`);
    } catch (e) {
      log(`[paper-plugins] ${plugin.root}/${plugin.name} failed to load: ${e.message}`);
    }
  }
  return { loaded };
}

module.exports = { loadPlugins, findPluginDirs };
