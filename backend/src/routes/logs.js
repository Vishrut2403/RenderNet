import express from 'express';
import fs from 'fs';
import path from 'path';
import { LOGS_DIR } from '../paths.js';
import { listLogs } from '../logger.js';

const router = express.Router();
const DEFAULT_LINES = 200;
const MAX_LINES = 5000;

router.get('/', (req, res) => {
  const files = listLogs().map(name => {
    const stats = fs.statSync(path.join(LOGS_DIR, name));
    return { name, bytes: stats.size, modified: new Date(stats.mtimeMs).toISOString() };
  });

  res.json({ files });
});

router.get('/:name', (req, res) => {
  // Matched against the listing rather than sanitised, so nothing outside it
  // is reachable however the name is spelled.
  if (!listLogs().includes(req.params.name)) {
    return res.status(404).json({ error: 'No such log' });
  }

  const requested = Number(req.query.lines) || DEFAULT_LINES;
  const lines = Math.min(Math.max(requested, 1), MAX_LINES);
  const content = fs.readFileSync(path.join(LOGS_DIR, req.params.name), 'utf8');

  res.type('text/plain').send(content.split('\n').slice(-lines).join('\n'));
});

export default router;
