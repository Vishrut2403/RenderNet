import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import {
  getJob,
  updateJobProgress,
  recordFrameUpload,
  recordFrameFailure,
  leaseNextFrame,
  renewFrameLease,
  releaseFrameLease
} from '../queue.js';
import { getLease } from '../db.js';
import path from 'path';
import { dataPath } from '../paths.js';
import { parseFormats, primaryOf, extensionOf } from '../formats.js';
import { announceWorker } from '../worker-registry.js';

const router = express.Router();

// Read lazily: index.js may generate the secret at boot, after this import.
function requireWorker(req, res, next) {
  const expected = process.env.WORKER_SECRET;

  if (!expected) {
    return res.status(503).json({ error: 'Worker callbacks are not configured' });
  }

  const provided = req.headers['x-worker-secret'];

  if (typeof provided !== 'string') {
    return res.status(401).json({ error: 'Invalid worker credentials' });
  }

  // Digests rather than the raw values: timingSafeEqual throws on a length
  // mismatch, and header characters outside ASCII do not encode one byte each.
  const match = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(provided).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );

  if (!match) {
    return res.status(401).json({ error: 'Invalid worker credentials' });
  }

  next();
}

// A worker whose claim has lapsed could otherwise upload over the frame somebody
// else is now rendering.
function requireLease(req, res, next) {
  const leaseId = req.headers['x-lease-id'];
  const lease = typeof leaseId === 'string' ? getLease(leaseId) : null;

  if (!lease
    || lease.jobId !== req.jobId
    || lease.frame !== Number(req.params.frame)
    || new Date(lease.expiresAt) <= new Date()) {
    return res.status(409).json({ error: `Frame ${req.params.frame} is not leased to you` });
  }

  req.leaseId = leaseId;
  next();
}

// Runs before multer so a bad id is a clean 404, not a storage-engine error.
function loadJob(req, res, next) {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  req.jobId = jobId;
  req.job = job;
  next();
}

// Runs before multer so a callback for a cancelled job cannot recreate the
// output folder that cancellation just deleted.
function requireRendering(req, res, next) {
  if (req.job.status !== 'rendering') {
    return res.status(409).json({
      error: `Job ${req.jobId} is ${req.job.status}, not rendering`
    });
  }

  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const folder = dataPath(req.job.outputFolder);
      fs.mkdirSync(folder, { recursive: true });
      cb(null, folder);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    // From the URL and the filename, not the body: multer only exposes text
    // fields sent before the file, which is a fragile ordering to depend on.
    const frame = Number(req.params.frame);
    const extension = path.extname(file.originalname).toLowerCase();
    const allowed = parseFormats(req.job.formats).map(extensionOf);

    if (!allowed.includes(extension)) {
      cb(new Error(`Job ${req.jobId} did not ask for a ${extension || 'nameless'} file`));
      return;
    }

    cb(null, `frame_${String(frame).padStart(4, '0')}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

function validFrame(req, res, next) {
  const frame = Number(req.params.frame);

  if (!Number.isInteger(frame) || frame < req.job.frameStart || frame > req.job.frameEnd) {
    return res.status(400).json({
      error: `Frame ${req.params.frame} is outside job range ${req.job.frameStart}-${req.job.frameEnd}`
    });
  }

  next();
}

router.use(requireWorker);

router.post('/lease', (req, res) => {
  const workerId = typeof req.body?.workerId === 'string' ? req.body.workerId : 'worker';

  // Said again with every request rather than registered once: a worker that
  // stops asking stops counting, which is all the liveness this needs.
  announceWorker({
    workerId,
    name: typeof req.body?.name === 'string' ? req.body.name : null,
    engines: req.body?.engines,
    device: typeof req.body?.device === 'string' ? req.body.device : null
  });

  const lease = leaseNextFrame(workerId);

  // 204 rather than an error: having no work is the ordinary answer.
  if (!lease) return res.status(204).end();

  res.json({ lease });
});

router.post('/leases/:leaseId/renew', (req, res) => {
  const result = renewFrameLease(req.params.leaseId);

  if (result.ok) return res.json({ expiresAt: result.expiresAt });

  res.status(409).json({ error: `Lease ${result.reason}`, stopped: result.reason === 'stopped' });
});

router.post('/leases/:leaseId/release', (req, res) => {
  res.json({ released: releaseFrameLease(req.params.leaseId) });
});

// For a worker on another machine. Worker-authenticated; the browser downloads
// live under /api/download.
router.get('/jobs/:id/blend', loadJob, (req, res) => {
  const blend = dataPath(req.job.filePath);

  if (!req.job.filePath || !fs.existsSync(blend)) {
    return res.status(404).json({ error: `Job ${req.jobId} has no .blend on disk` });
  }

  res.sendFile(blend);
});

router.post('/jobs/:id/frames/:frame', loadJob, requireRendering, validFrame, requireLease, upload.single('frame'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No frame file uploaded' });
  }

  const frame = Number(req.params.frame);
  const isPrimary = path.extname(req.file.filename).toLowerCase()
    === extensionOf(primaryOf(req.job.formats));

  // Only the primary marks the frame done. The others are the same image in
  // another format, and counting them would put progress past 100%.
  const job = isPrimary
    ? recordFrameUpload(req.jobId, frame, req.file.filename)
    : getJob(req.jobId);

  // Cancellation can land while the frame is still streaming in.
  if (!job || job.status !== 'rendering') {
    fs.rmSync(req.file.path, { force: true });
    return res.status(409).json({ error: `Job ${req.jobId} is no longer rendering` });
  }

  if (isPrimary) {
    console.log(`Frame ${frame} received for job ${req.jobId} (${job.progress}%)`);
  }

  res.json({
    success: true,
    frame,
    stored: req.file.filename,
    progress: job.progress
  });
});


router.post('/jobs/:id/frames/:frame/failed', loadJob, requireRendering, validFrame, requireLease, (req, res) => {
  const frame = Number(req.params.frame);
  const { error } = req.body;

  const recorded = recordFrameFailure(req.jobId, frame, error || 'Unknown error');

  if (!recorded) {
    return res.status(409).json({ error: `Job ${req.jobId} is no longer rendering` });
  }

  const { job, frame: record } = recorded;
  const retry = record?.status === 'pending';

  console.warn(
    `Frame ${frame} failed for job ${req.jobId} (attempt ${record?.attempts}): ${error}` +
    (retry ? ' - will retry' : '')
  );

  res.json({ success: true, frame, retry, attempts: record?.attempts, failedFrames: job.failedFrames });
});

router.post('/jobs/:id/progress', loadJob, requireRendering, (req, res) => {
  const currentFrame = Number(req.body.currentFrame);

  if (!Number.isInteger(currentFrame)) {
    return res.status(400).json({ error: 'currentFrame must be an integer' });
  }

  const job = updateJobProgress(req.jobId, currentFrame);

  if (!job) {
    return res.status(409).json({ error: `Job ${req.jobId} is no longer rendering` });
  }

  res.json({ success: true, progress: job.progress, currentFrame: job.currentFrame });
});


// Multer rejects (an unexpected format, an oversized frame) surface here.
router.use((error, req, res, _next) => {
  if (req.file?.path) fs.rmSync(req.file.path, { force: true });

  console.warn(`Worker upload rejected: ${error.message}`);
  res.status(400).json({ error: error.message });
});

export default router;
