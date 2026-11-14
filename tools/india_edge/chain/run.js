// Usage: node tools/india_edge/chain/run.js <snapshot.json> [previous-snapshot.json]
import fs from 'node:fs';
import { runChain } from './engine.js';

const [cur, prev] = process.argv.slice(2);
if (!cur) {
  console.error('usage: run.js <snapshot.json> [previous.json]');
  process.exit(1);
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(JSON.stringify(runChain(read(cur), prev ? read(prev) : null), null, 2));
