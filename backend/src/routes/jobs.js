import express from 'express';
import { cancelJob, getJob, getAllJobs, getQueueStatus, getQueuePosition } from '../queue.js';

const router = express.Router();

function canAccess(job, user) {
  return job.owner === user.username || user.role === 'admin';
}

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
  const visible = getAllJobs().filter(job => canAccess(job, req.user));
  res.json({
    total: visible.length,
    jobs: visible
  });
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