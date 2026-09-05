import express from 'express';
import multer from 'multer';
import fs from 'fs';
import {
  recordComposite,
  updateJobProgress,
  recordFrameUpload,
  recordFrameFailure,
  leaseNextFrame,
  renewFrameLease,
  releaseFrameLease
} from '../queue.js';
import { getJob } from '../job-views.js';
import { getLease, getCompositeLease, liveLeases } from '../db.js';
import path from 'path';
import { dataPath, MAX_FRAME_BYTES } from '../paths.js';
import { parseFormats, primaryOf, extensionOf } from '../formats.js';
import { isTiled } from '../tiles.js';
import { tileName, tilesPath, compositeName } from '../tiles.js';
import { announceWorker } from '../worker-registry.js';
import { machineFor } from '../worker-tokens.js';

const router = express.Router();

function requireWorker(req, res, next) {
  const machine = machineFor(req.headers['x-worker-token']);

  if (!machine) {
    return res.status(401).json({ error: 'Invalid worker credentials' });
  }

  req.machine = machine;
  next();
}

// One credential covers every worker process on a machine, so each names the
// slot it is: the frames of one machine's slots never mix with another's.
function identityOf(req) {
  const slot = typeof req.body?.workerId === 'string'
    ? req.body.workerId.replace(/[^\w.-]/g, '').slice(0, 64)
    : '';

  return slot ? `${req.machine.id}:${slot}` : req.machine.id;
}

function heldBy(lease, machineId) {
  return lease.leasedBy === machineId || !!lease.leasedBy?.startsWith(`${machineId}:`);
}

function ownedLease(req) {
  const lease = getLease(req.params.leaseId);

  return lease && heldBy(lease, req.machine.id) ? lease : null;
}

// A worker whose claim has lapsed could otherwise upload over the frame somebody
// else is now rendering.
function requireLease(req, res, next) {
  const leaseId = req.headers['x-lease-id'];
  const lease = typeof leaseId === 'string' ? getLease(leaseId) : null;

  if (!lease
    || lease.jobId !== req.jobId
    || !lease.frames.includes(Number(req.params.frame))
    || !heldBy(lease, req.machine.id)
    || new Date(lease.expiresAt) <= new Date()) {
    return res.status(409).json({ error: `Frame ${req.params.frame} is not leased to you` });
  }

  req.leaseId = leaseId;
  next();
}

// The machine putting a still back together holds a claim on the job rather
// than on a frame, and it is the only one that may fetch the pieces or hand the
// picture back.
function requireComposite(req, res, next) {
  const leaseId = req.headers['x-lease-id'];
  const lease = typeof leaseId === 'string' ? getCompositeLease(leaseId) : null;

  if (!lease
    || lease.jobId !== req.jobId
    || !heldBy(lease, req.machine.id)
    || new Date(lease.expiresAt) <= new Date()) {
    return res.status(409).json({ error: `Job ${req.jobId} is not yours to put together` });
  }

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
      // Tiles are working parts, not output: kept aside so the listing and the
      // ZIP show the finished picture rather than the pieces of it.
      const folder = isTiled(req.job)
        ? dataPath(tilesPath(req.job.outputFolder))
        : dataPath(req.job.outputFolder);
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

    cb(null, isTiled(req.job)
      ? tileName(frame) + extension
      : `frame_${String(frame).padStart(4, '0')}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FRAME_BYTES }
});

function validFrame(req, res, next) {
  const frame = Number(req.params.frame);

  // A tiled still is claimed by region, so the number names a tile rather than
  // a frame of the scene.
  const [lowest, highest] = isTiled(req.job)
    ? [1, req.job.tiles]
    : [req.job.frameStart, req.job.frameEnd];

  if (!Number.isInteger(frame) || frame < lowest || frame > highest) {
    return res.status(400).json({
      error: `Frame ${req.params.frame} is outside job range ${lowest}-${highest}`
    });
  }

  next();
}

router.use(requireWorker);

router.post('/lease', (req, res) => {
  const workerId = identityOf(req);

  // Said again with every request rather than registered once: a worker that
  // stops asking stops counting, which is all the liveness this needs.
  announceWorker({
    workerId,
    name: req.machine.name,
    engines: req.body?.engines,
    device: typeof req.body?.device === 'string' ? req.body.device : null
  });

  const lease = leaseNextFrame(workerId);

  // 204 rather than an error: having no work is the ordinary answer.
  if (!lease) return res.status(204).end();

  res.json({ lease });
});

router.post('/leases/:leaseId/renew', (req, res) => {
  if (!ownedLease(req)) {
    return res.status(409).json({ error: 'Lease unknown', stopped: true });
  }

  const result = renewFrameLease(req.params.leaseId);

  if (result.ok) return res.json({ expiresAt: result.expiresAt });

  res.status(409).json({ error: `Lease ${result.reason}`, stopped: result.reason === 'stopped' });
});

router.post('/leases/:leaseId/release', (req, res) => {
  if (!ownedLease(req)) return res.json({ released: false });

  res.json({ released: releaseFrameLease(req.params.leaseId) });
});

// For a worker on another machine. Worker-authenticated; the browser downloads
// live under /api/download.
router.get('/jobs/:id/blend', loadJob, (req, res) => {
  // A machine is entitled to the scenes it is rendering and no others.
  if (!liveLeases().some(lease => lease.jobId === req.jobId && heldBy(lease, req.machine.id))) {
    return res.status(403).json({ error: `No claim on job ${req.jobId}` });
  }

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


// A machine that is not on the server's own disk fetches the pieces over HTTP,
// the way it fetches the scene.
router.get('/jobs/:id/tiles/:index', loadJob, requireRendering, requireComposite, (req, res) => {
  const index = Number(req.params.index);

  if (!Number.isInteger(index) || index < 1 || index > req.job.tiles) {
    return res.status(400).json({ error: `Tile ${req.params.index} is not one of this still's` });
  }

  const file = dataPath(tilesPath(req.job.outputFolder),
    tileName(index) + extensionOf(primaryOf(req.job.formats)));

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: `Tile ${index} of job ${req.jobId} is not on disk` });
  }

  res.sendFile(file);
});

const composite = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const folder = dataPath(req.job.outputFolder);
        fs.mkdirSync(folder, { recursive: true });
        cb(null, folder);
      } catch (error) {
        cb(error);
      }
    },
    // Named here rather than taken from what arrived: it is the one frame of
    // the scene, in the format the job asked for.
    filename: (req, file, cb) => cb(null, compositeName(req.job))
  }),
  limits: { fileSize: MAX_FRAME_BYTES }
});

router.post('/jobs/:id/composite', loadJob, requireRendering, requireComposite,
  composite.single('composite'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No picture uploaded' });
    }

    const job = recordComposite(req.jobId, null);

    if (!job) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(409).json({ error: `Job ${req.jobId} is no longer rendering` });
    }

    res.json({ success: true, stored: req.file.filename });
  });

router.post('/jobs/:id/composite/failed', loadJob, requireRendering, requireComposite,
  (req, res) => {
    recordComposite(req.jobId, req.body?.error || 'Unknown error');
    res.json({ success: true });
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

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `A frame may not exceed ${Math.round(MAX_FRAME_BYTES / 1024 / 1024)}MB`
    });
  }

  res.status(400).json({ error: error.message });
});

export default router;
