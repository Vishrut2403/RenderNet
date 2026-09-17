import express from 'express';
import multer from 'multer';
import fs from 'fs';
import {
  recordBake,
  recordComposite,
  updateJobProgress,
  recordFrameUpload,
  recordFrameFailure,
  leaseNextFrame,
  renewFrameLease,
  releaseFrameLease
} from '../queue.js';
import { getJob } from '../job-views.js';
import { getLease, getCompositeLease, getBakeLease, liveLeases, liveComposites, liveBakes } from '../db.js';
import path from 'path';
import { dataPath, MAX_FRAME_BYTES, MAX_UPLOAD_BYTES } from '../paths.js';
import { workerScratchDir } from '../job-store.js';
import { startsWith } from '../utils/file-utils.js';
import { assetsDir } from '../supplied-assets.js';
import { bakedScenePath } from '../baking.js';
import { parseFormats, primaryOf, extensionOf, signatureFor } from '../formats.js';
import { isTiled } from '../tiles.js';
import { tileName, tilesPath, compositeName } from '../tiles.js';
import { announceWorker } from '../worker-registry.js';
import { machineFor } from '../worker-tokens.js';
import { waitFor, WORK } from '../bus.js';

const router = express.Router();

function requireWorker(req, res, next) {
  const machine = machineFor(req.headers['x-worker-token']);

  if (!machine) {
    return res.status(401).json({ error: 'Invalid worker credentials' });
  }

  req.machine = machine;
  next();
}

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
  const lease = getLease(req.params.leaseId)
    ?? getCompositeLease(req.params.leaseId)
    ?? getBakeLease(req.params.leaseId);

  return lease && heldBy(lease, req.machine.id) ? lease : null;
}

function working(req) {
  return [...liveLeases(), ...liveComposites(), ...liveBakes()]
    .some(claim => claim.jobId === req.jobId && heldBy(claim, req.machine.id));
}

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

function requireRendering(req, res, next) {
  if (req.job.status !== 'rendering') {
    return res.status(409).json({
      error: `Job ${req.jobId} is ${req.job.status}, not rendering`
    });
  }

  next();
}

function folderFor(job) {
  const folder = isTiled(job) ? dataPath(tilesPath(job.outputFolder)) : dataPath(job.outputFolder);

  fs.mkdirSync(folder, { recursive: true });

  return folder;
}

function storedAs(job, frame, extension) {
  return isTiled(job)
    ? tileName(frame) + extension
    : `frame_${String(frame).padStart(4, '0')}${extension}`;
}

function askedFor(job, extension) {
  return parseFormats(job.formats).map(extensionOf).includes(extension);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, folderFor(req.job));
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const frame = Number(req.params.frame);
    const extension = path.extname(file.originalname).toLowerCase();

    if (!askedFor(req.job, extension)) {
      cb(new Error(`Job ${req.jobId} did not ask for a ${extension || 'nameless'} file`));
      return;
    }

    cb(null, storedAs(req.job, frame, extension));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FRAME_BYTES }
});

function unreadable(file) {
  const signature = signatureFor(path.extname(file.filename));

  if (file.size === 0) return 'it is empty';
  if (signature && !startsWith(file.path, signature)) {
    return `it does not begin the way a ${path.extname(file.filename)} does`;
  }

  return null;
}

function moveInto(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;

    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

function validFrame(req, res, next) {
  const frame = Number(req.params.frame);

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

const MAX_WAIT_MS = 60 * 1000;

function waitAsked(body) {
  const seconds = Number(body?.wait);

  if (!Number.isFinite(seconds) || seconds <= 0) return 0;

  return Math.min(seconds * 1000, MAX_WAIT_MS);
}

router.post('/lease', async (req, res) => {
  const workerId = identityOf(req);

  announceWorker({
    workerId,
    name: req.machine.name,
    engines: req.body?.engines,
    device: typeof req.body?.device === 'string' ? req.body.device : null,
    deviceWanted: typeof req.body?.deviceWanted === 'string' ? req.body.deviceWanted : null
  });

  const deadline = Date.now() + waitAsked(req.body);
  const giveUp = new AbortController();
  let gone = false;

  res.on('close', () => {
    gone = true;
    giveUp.abort();
  });

  for (;;) {
    const left = deadline - Date.now();

    // Listen before asking: asking can start the next job and announce it mid-call.
    const told = left > 0 && !gone ? waitFor(WORK, left, giveUp.signal) : null;
    const lease = leaseNextFrame(workerId, req.machine.isLocal);

    if (lease) {
      giveUp.abort();
      return res.json({ lease });
    }

    if (!told) break;

    await told;

    if (gone || Date.now() >= deadline) break;
  }

  if (!gone) res.status(204).end();
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

router.get('/jobs/:id/blend', loadJob, (req, res) => {
  if (!working(req)) {
    return res.status(403).json({ error: `No claim on job ${req.jobId}` });
  }

  const stored = req.job.bakedPath || req.job.filePath;
  const blend = stored && dataPath(stored);

  if (!stored || !fs.existsSync(blend)) {
    return res.status(404).json({ error: `Job ${req.jobId} has no .blend on disk` });
  }

  res.sendFile(blend);
});

router.get('/jobs/:id/assets/:filename', loadJob, (req, res) => {
  if (!working(req)) {
    return res.status(403).json({ error: `No claim on job ${req.jobId}` });
  }

  const directory = assetsDir(req.job);
  const file = path.resolve(directory, path.basename(req.params.filename));

  if (!file.startsWith(directory + path.sep) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'No such file for this job' });
  }

  res.sendFile(file);
});

router.post('/jobs/:id/frames/:frame', loadJob, requireRendering, validFrame, requireLease, upload.single('frame'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No frame file uploaded' });
  }

  const broken = unreadable(req.file);

  if (broken) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(422).json({ error: `Frame ${req.params.frame} was not stored because ${broken}` });
  }

  const frame = Number(req.params.frame);
  const isPrimary = path.extname(req.file.filename).toLowerCase()
    === extensionOf(primaryOf(req.job.formats));

  const job = isPrimary
    ? recordFrameUpload(req.jobId, frame, req.file.filename)
    : getJob(req.jobId);

  // A job put back for the disk still wants a frame it has already recorded.
  if (!job || job.status === 'cancelled') {
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
    filename: (req, file, cb) => cb(null, compositeName(req.job))
  }),
  limits: { fileSize: MAX_FRAME_BYTES }
});

function requireBake(req, res, next) {
  const leaseId = req.headers['x-lease-id'];
  const lease = typeof leaseId === 'string' ? getBakeLease(leaseId) : null;

  if (!lease
    || lease.jobId !== req.jobId
    || !heldBy(lease, req.machine.id)
    || new Date(lease.expiresAt) <= new Date()) {
    return res.status(409).json({ error: `Job ${req.jobId} is not yours to bake` });
  }

  next();
}

const baked = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const folder = path.dirname(dataPath(bakedScenePath(req.job)));
        fs.mkdirSync(folder, { recursive: true });
        cb(null, folder);
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => cb(null, path.basename(bakedScenePath(req.job)))
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

router.post('/jobs/:id/baked', loadJob, requireRendering, requireBake,
  baked.single('scene'), (req, res) => {
    if (!req.file) {
      const inPlace = req.machine.isLocal === true
        && fs.existsSync(dataPath(bakedScenePath(req.job)));

      if (!inPlace) {
        return res.status(400).json({ error: 'No baked scene uploaded' });
      }
    } else if (req.file.size === 0) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(422).json({ error: 'The baked scene was empty' });
    }

    const job = recordBake(req.jobId, null);

    if (!job) {
      return res.status(409).json({ error: `Job ${req.jobId} is no longer rendering` });
    }

    res.json({ success: true });
  });

router.post('/jobs/:id/baked/failed', loadJob, requireRendering, requireBake,
  (req, res) => {
    recordBake(req.jobId, req.body?.error || 'Unknown error');
    res.json({ success: true });
  });

router.post('/jobs/:id/composite', loadJob, requireRendering, requireComposite,
  composite.single('composite'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No picture uploaded' });
    }

    const broken = unreadable(req.file);

    if (broken) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(422).json({ error: `The picture was not stored because ${broken}` });
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

router.post('/jobs/:id/frames/:frame/at', loadJob, requireRendering, validFrame, requireLease,
  (req, res) => {
    if (req.machine.isLocal !== true) {
      return res.status(403).json({ error: 'Only a renderer on this machine may hand over a path' });
    }

    const scratch = path.resolve(workerScratchDir(req.jobId));
    const rendered = path.resolve(String(req.body?.path ?? ''));

    if (!rendered.startsWith(scratch + path.sep)) {
      return res.status(400).json({ error: `That file is not in job ${req.jobId}'s scratch space` });
    }

    const extension = path.extname(rendered).toLowerCase();

    if (!askedFor(req.job, extension)) {
      return res.status(400).json({
        error: `Job ${req.jobId} did not ask for a ${extension || 'nameless'} file`
      });
    }

    let arrived;

    try {
      arrived = { path: rendered, filename: path.basename(rendered), size: fs.statSync(rendered).size };
    } catch {
      return res.status(404).json({ error: `No frame at ${rendered}` });
    }

    const broken = unreadable(arrived);

    if (broken) {
      return res.status(422).json({ error: `Frame ${req.params.frame} was not stored because ${broken}` });
    }

    const frame = Number(req.params.frame);
    const filename = storedAs(req.job, frame, extension);

    try {
      moveInto(rendered, path.join(folderFor(req.job), filename));
    } catch (error) {
      return res.status(500).json({ error: `Could not take the frame: ${error.message}` });
    }

    const isPrimary = extension === extensionOf(primaryOf(req.job.formats));
    const job = isPrimary ? recordFrameUpload(req.jobId, frame, filename) : getJob(req.jobId);

    if (!job || job.status === 'cancelled') {
      return res.status(409).json({ error: `Job ${req.jobId} is no longer rendering` });
    }

    res.json({ success: true, frame, stored: filename, progress: job.progress });
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
