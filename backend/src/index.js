import './env.js';
// Before the rest: it patches console on import, so what they log while loading
// lands in the file too.
import { requestLogger } from './logger.js';
import express from 'express';
import { securityHeaders, crossOrigin } from './security.js';
import { tlsOptions } from './tls.js';
import { ensureDir } from './utils/file-utils.js';
import { findBlenderExecutable } from './utils/blender-check.js';
import { cleanupOldFiles } from './cleanup.js';
import authRouter from './routes/auth.js'
import { requireAuth, requireAdmin } from './auth.js';
import uploadRouter from './routes/upload.js';
import jobsRouter from './routes/jobs.js';
import { resumeInterruptedJobs, stopWorkers } from './queue.js';
import downloadRouter from './routes/download.js';
import workerRouter from './routes/worker.js';
import logsRouter from './routes/logs.js';
import { healthRouter } from './routes/health.js';
import { ENGINES } from './engines.js';
import {
  FORMATS, EXR_CODECS, EXR_DEPTHS,
  DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY
} from './formats.js';
import { backupDatabase } from './db.js';
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import path from 'path';
import {
  UPLOADS_DIR, PARTIALS_DIR, RENDERS_DIR, SCRATCH_DIR, DATA_DIR, FRONTEND_DIST, RETENTION_DAYS
} from './paths.js';

// Ephemeral, so an unconfigured deployment never ships a known credential.
if (!process.env.WORKER_SECRET) {
  process.env.WORKER_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('WORKER_SECRET not set - generated a temporary one for this process.');
  console.warn('Remote workers will not be able to authenticate until you set it in .env');
}

const app = express();
const PORT = process.env.PORT || 5500;

app.use(securityHeaders);
app.use(crossOrigin());
app.use(express.json());
app.use(requestLogger);

ensureDir(UPLOADS_DIR);
ensureDir(PARTIALS_DIR);
ensureDir(RENDERS_DIR);
ensureDir(SCRATCH_DIR);

const blenderPath = findBlenderExecutable();
if (!blenderPath) {
  console.error('WARNING: Blender not found! Renders will fail.');
  console.error('Make sure Blender is installed and in your PATH');
} else {
  console.log('Blender found:', blenderPath);
}


app.use('/api/auth', authRouter);
app.use('/api/upload', requireAuth, uploadRouter);
app.use('/api/jobs', requireAuth, jobsRouter);
// Both authenticate inside their own routers.
app.use('/api/download', downloadRouter);
app.use('/api/worker', workerRouter);

app.use('/api/health', healthRouter(blenderPath));

// The upload form must offer exactly what the upload route will accept.
app.get('/api/engines', requireAuth, (req, res) => {
  res.json({
    engines: ENGINES,
    formats: FORMATS,
    exrCodecs: EXR_CODECS,
    exrDepths: EXR_DEPTHS,
    defaults: {
      exrCodec: DEFAULT_EXR_CODEC,
      exrDepth: DEFAULT_EXR_DEPTH,
      jpegQuality: DEFAULT_JPEG_QUALITY
    }
  });
});

app.use('/api/logs', requireAuth, requireAdmin, logsRouter);

app.post('/api/cleanup', requireAuth, requireAdmin, (req, res) => {
  cleanupOldFiles();
  res.json({ message: 'Cleanup triggered' });
});

// So a client needs nothing but a browser.
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));

  app.get('*', (req, res, next) => {
    // An unknown API route is a 404, not the app shell.
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
} else {
  console.warn('No frontend build found - run "npm run build" in frontend/ to serve the UI.');
}

const backup = backupDatabase();
if (backup) console.log(`Database backed up to ${backup}`);

cleanupOldFiles();
resumeInterruptedJobs();

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
console.log(`Auto-cleanup scheduled (runs every 24 hours, deletes files older than ${RETENTION_DAYS} days)`);

// Turns a throw the async route wrapper caught into a 500 rather than a hang.
app.use((error, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, error);

  if (res.headersSent) return next(error);

  res.status(500).json({ error: 'Something went wrong' });
});

// Workers are separate processes and outlive this one unless asked to stop.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopWorkers();
    process.exit(0);
  });
}

// Losing an unattended render to a stray rejection is worse than logging it and
// carrying on; jobs resume from their last frame anyway.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

let tls;

try {
  tls = tlsOptions();
} catch (error) {
  console.error(`TLS is configured but unusable: ${error.message}`);
  process.exit(1);
}

const scheme = tls ? 'https' : 'http';
const server = tls ? https.createServer(tls, app) : app;

server.listen(PORT, () => {
  console.log(`Render Farm started.
    Port: ${PORT}  , BlenderPath: ${blenderPath ? 'Found': 'Not Found'}
    Data:  ${DATA_DIR}
    UI:    ${fs.existsSync(FRONTEND_DIST) ? `${scheme}://localhost:${PORT}` : 'not built'}`);

  if (!tls) {
    console.warn('Serving plain HTTP: passwords, session tokens and scenes cross the network in clear.');
    console.warn('Set TLS_KEY and TLS_CERT to turn on HTTPS.');
  }
});