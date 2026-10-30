// Read-only API for the scores engine. Serves ONLY the pre-built browser-safe JSON
// (tools/india_edge/out/public). Formulas and weights never leave the Python side.
const express = require('express');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'tools', 'india_edge', 'out', 'public');
const FILES = { desk: 'desk.json', scores: 'scores.json', screeners: 'screeners.json', edge: 'edge.json' };

const router = express.Router();

router.get('/:name', (req, res) => {
  const file = FILES[req.params.name];            // whitelist, no path from user input
  if (!file) return res.status(404).json({ error: 'not found' });
  fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', (err, txt) => {
    if (err) return res.status(503).json({ error: 'data not built yet' });
    res.set('Cache-Control', 'public, max-age=300').type('json').send(txt);
  });
});

module.exports = router;
