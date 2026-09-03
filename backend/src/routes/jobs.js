import express from 'express';
import {
  cancelJob, getQueueStatus, getQueuePosition, deleteJobAndFiles, setJobPriority, rerunJob
} from '../queue.js';
import { getJob, listJobs, jobsSummary, DEFAULT_PAGE, MAX_PAGE } from '../job-views.js';
import { usageFor, usageByOwner } from '../storage.js';
import { startVideo } from '../video.js';
import { requireAdmin } from '../auth.js';

const router = express.Router();

const STATUSES = ['pending', 'rendering', 'completed', 'failed', 'cancelled'];

function canAccess(job, user) {
  return job.owner === user.username || user.role === 'admin';
}

function pageRequest(query) {
  const status = query.status === undefined || query.status === 'all' ? null : query.status;

  if (status !== null && !STATUSES.includes(status)) {
    return { error: `status must be all or one of ${STATUSES.join(', ')}` };
  }

  const limit = query.limit === undefined ? DEFAULT_PAGE : Number(query.limit);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    return { error: `limit must be a whole number from 1 to ${MAX_PAGE}` };
  }

  const before = query.before === undefined ? null : Number(query.before);

  if (before !== null && (!Number.isInteger(before) || before < 1)) {
    return { error: 'before must be a job id' };
  }

  return { status, limit, before };
}

// Declared before /:id, which would otherwise take "summary" for a job id.
router.get('/summary', (req, res) => {
  res.json({
    ...jobsSummary(req.user),
    usage: usageFor(req.user.username)
  });
});

router.get('/:id', (req, res) => {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const queuePosition = job.status === 'pending' ? getQueuePosition(jobId) : null;

  res.json({
    ...job,
    queuePosition
  });
});

router.get('/', (req, res) => {
  const asked = pageRequest(req.query);

  if (asked.error) {
    return res.status(400).json({ error: asked.error });
  }

  const page = listJobs({ viewer: req.user, ...asked });

  res.json({
    total: page.counts.all,
    ...page,
    usage: usageFor(req.user.username)
  });
});

router.get('/usage/all', requireAdmin, (req, res) => {
  res.json({ usage: usageByOwner() });
});

router.post('/:id/cancel', (req, res) => {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'You can only cancel your own jobs' });
  }
  
  const result = cancelJob(jobId);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

router.delete('/:id', (req, res) => {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'You can only delete your own jobs' });
  }

  const result = deleteJobAndFiles(jobId);

  res.status(result.success ? 200 : 400).json(result);
});

router.post('/:id/rerun', (req, res) => {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const result = rerunJob(jobId);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result);
});

router.post('/:id/priority', (req, res) => {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'You can only reprioritise your own jobs' });
  }

  const priority = Number(req.body?.priority);

  if (!Number.isInteger(priority) || priority < 0 || priority > 1) {
    return res.status(400).json({ error: 'priority must be 0 (normal) or 1 (urgent)' });
  }

  const result = setJobPriority(jobId, priority);

  res.status(result.success ? 200 : 400).json(result);
});

// Made on request rather than for every job: encoding wants the same processor
// the renders do, and most jobs are downloaded as frames.
router.post('/:id/video', (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const fps = req.body?.fps === undefined ? undefined : Number(req.body.fps);
  const started = startVideo(job.id, fps);

  if (started.status !== 202) {
    return res.status(started.status).json({ error: started.error });
  }

  res.status(202).json({ status: 'encoding', frames: started.frames });
});

router.get('/queue/status', (req, res) => {
  const status = getQueueStatus();

  res.json({
    ...status,
    queue: status.queue.filter(entry => {
      const job = getJob(entry.id);
      return job && canAccess(job, req.user);
    })
  });
});

export default router;