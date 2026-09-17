import './env.js';
import { requestLogger } from './logger.js';
import express from 'express';
import { securityHeaders, crossOrigin } from './security.js';
import { tlsOptions } from './tls.js';
import { ensureDir } from './utils/file-utils.js';
import { findBlenderExecutable } from './utils/blender-check.js';
import { cleanupOldFiles } from './cleanup.js';
import authRouter from './routes/auth.js'
import { requireAuth, requireAdmin, ensureSignupCode } from './auth.js';
import { announceOnNetwork } from './announce.js';
import uploadRouter from './routes/upload.js';
import jobsRouter from './routes/jobs.js';
import { resumeInterruptedJobs, stopWorkers } from './queue.js';
import { startBus, stopBus } from './bus.js';
import downloadRouter from './routes/download.js';
import workerRouter from './routes/worker.js';
import logsRouter from './routes/logs.js';
import eventsRouter from './routes/events.js';
import machinesRouter from './routes/machines.js';
import { importSharedSecret } from './worker-tokens.js';
import { healthRouter } from './routes/health.js';
import { ENGINES } from './engines.js';
import {
  FORMATS, EXR_CODECS, EXR_DEPTHS,
  DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY
} from './formats.js';
import { backupDatabase } from './db.js';
import https from 'https';
import fs from 'fs';
import path from 'path';
import {
  UPLOADS_DIR, PARTIALS_DIR, RENDERS_DIR, SCRATCH_DIR, DATA_DIR, FRONTEND_DIST, RETENTION_DAYS
} from './paths.js';

if (importSharedSecret()) {
  console.warn('WORKER_SECRET is set: it now works as one shared machine credential.');
  console.warn('Issue each machine its own under Admin and revoke the shared one.');
}

const app = express();
const PORT = process.env.PORT || 5500;

if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);

  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  console.log(`Trusting X-Forwarded-For from ${process.env.TRUST_PROXY}`);
}

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
app.use('/api/events', requireAuth, eventsRouter);
app.use('/api/download', downloadRouter);
app.use('/api/worker', workerRouter);

app.use('/api/health', healthRouter(blenderPath));

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
app.use('/api/machines', requireAuth, requireAdmin, machinesRouter);

app.post('/api/cleanup', requireAuth, requireAdmin, (req, res) => {
  cleanupOldFiles();
  res.json({ message: 'Cleanup triggered' });
});

if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));

  app.get('*', (req, res, next) => {
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

app.use((error, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, error);

  if (res.headersSent) return next(error);

  res.status(500).json({ error: 'Something went wrong' });
});

let stopAnnouncing = () => {};

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopAnnouncing();
    stopWorkers();
    stopBus().finally(() => process.exit(0));
  });
}

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

const signup = ensureSignupCode();

server.listen(PORT, () => {
  console.log(`Render Farm started.
    Port: ${PORT}  , BlenderPath: ${blenderPath ? 'Found': 'Not Found'}
    Data:  ${DATA_DIR}
    UI:    ${fs.existsSync(FRONTEND_DIST) ? `${scheme}://localhost:${PORT}` : 'not built'}`);

  stopAnnouncing = announceOnNetwork(PORT);
  startBus();

  console.log(`    Code:  ${signup.code}${signup.fixed ? ' (from SIGNUP_CODE)' : ''}`
    + '  - what somebody types to create an account');

  if (!tls) {
    console.warn('Serving plain HTTP: passwords, session tokens and scenes cross the network in clear.');
    console.warn('Set TLS_KEY and TLS_CERT to turn on HTTPS.');
  }
});