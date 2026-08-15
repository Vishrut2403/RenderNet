import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import {
  getJob,
  updateJobProgress,
  recordFrameUpload,
  recordFrameFailure,
  completeJob
} from '../queue.js';

const router = express.Router();

// Read lazily: index.js may generate the secret at boot, after this import.
function requireWorker(req, res, next) {
  const expected = process.env.WORKER_SECRET;

  if (!expected) {
    return res.status(503).json({ error: 'Worker callbacks are not configured' });
  }

  const provided = req.headers['x-worker-secret'];

  if (typeof provided !== 'string' || provided.length !== expected.length) {
    return res.status(401).json({ error: 'Invalid worker credentials' });
  }

  const match = crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(expected)
  );

  if (!match) {
    return res.status(401).json({ error: 'Invalid worker credentials' });
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      fs.mkdirSync(req.job.outputFolder, { recursive: true });
      cb(null, req.job.outputFolder);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    // From the URL, not the body: multer only exposes text fields sent before
    // the file, which is a fragile ordering to depend on.
    const frame = Number(req.params.frame);
    cb(null, `frame_${String(frame).padStart(4, '0')}.png`);
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

router.post('/jobs/:id/frames/:frame', loadJob, validFrame, upload.single('frame'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No frame file uploaded' });
  }

  const frame = Number(req.params.frame);
  const job = recordFrameUpload(req.jobId, frame, req.file.filename);

  console.log(`Frame ${frame} received for job ${req.jobId} (${job.progress}%)`);

  res.json({
    success: true,
    frame,
    stored: req.file.filename,
    progress: job.progress
  });
});

router.post('/jobs/:id/frames/:frame/failed', loadJob, validFrame, (req, res) => {
  const frame = Number(req.params.frame);
  const { error } = req.body;

  const job = recordFrameFailure(req.jobId, frame, error || 'Unknown error');

  console.warn(`Frame ${frame} failed for job ${req.jobId}: ${error}`);

  res.json({ success: true, frame, failedFrames: job.failedFrames });
});

router.post('/jobs/:id/progress', loadJob, (req, res) => {
  const currentFrame = Number(req.body.currentFrame);

  if (!Number.isInteger(currentFrame)) {
    return res.status(400).json({ error: 'currentFrame must be an integer' });
  }

  const job = updateJobProgress(req.jobId, currentFrame);

  res.json({ success: true, progress: job.progress, currentFrame: job.currentFrame });
});

router.post('/jobs/:id/complete', loadJob, (req, res) => {
  const successfulFrames = Number(req.body.successfulFrames) || 0;
  const failedFrames = Number(req.body.failedFrames) || 0;

  const job = completeJob(req.jobId, { successfulFrames, failedFrames });

  res.json({
    success: true,
    status: job.status,
    completedFrames: job.completedFrames,
    failedFrames: job.failedFrames
  });
});

export default router;
