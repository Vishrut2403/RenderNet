import express from 'express';
import { getQueueStatus, jobsNoWorkerCanRender } from '../queue.js';
import { getJob } from '../job-views.js';
import { freeBytes } from '../utils/file-utils.js';
import { optionalAuth } from '../auth.js';
import { DATA_DIR, MIN_FREE_BYTES } from '../paths.js';

// Three widths of the same answer: anyone may ask whether the farm works, a
// session sees the counts, and a job is only named to its owner or an admin.
export function healthRouter(blenderPath) {
  const router = express.Router();

  router.get('/', optionalAuth, (req, res) => {
    const queue = getQueueStatus();
    const free = freeBytes(DATA_DIR);
    const lowOnDisk = free !== null && free < MIN_FREE_BYTES;
    const blenderAvailable = !!blenderPath;

    const problems = [];

    if (!blenderAvailable) {
      problems.push('Blender was not found on this machine, so no job can render');
    }

    if (queue.heldForDisk) problems.push(queue.heldForDisk);
    else if (lowOnDisk) problems.push('Free disk has fallen below the reserve');

    for (const job of jobsNoWorkerCanRender()) {
      problems.push(`Job ${job.id} needs ${job.renderEngine} and no worker here offers it`);
    }

    const body = {
      status: problems.length > 0 ? 'degraded' : 'ok',
      blenderAvailable,
      uptimeSeconds: Math.round(process.uptime())
    };

    if (req.user) {
      Object.assign(body, {
        problems,
        queue: {
          rendering: queue.isRendering,
          waiting: queue.queueLength,
          totalJobs: queue.totalJobs
        },
        disk: { freeBytes: free, minFreeBytes: MIN_FREE_BYTES, low: lowOnDisk },
        active: queue.activeJobs.map(id => jobSummary(id, req.user)).filter(Boolean),
        workers: queue.workers,
        lastFailure: visibleFailure(queue.lastFailure, req.user)
      });
    }

    // 200 while degraded: a status code a monitor reads as unreachable would hide
    // the reason.
    res.json(body);
  });

  return router;
}

function jobSummary(jobId, user) {
  const job = getJob(jobId);

  if (!job) return null;

  const summary = {
    id: job.id,
    frame: job.currentFrame,
    progress: job.progress,
    completedFrames: job.completedFrames,
    totalFrames: job.totalFrames,
    startedAt: job.startedAt
  };

  if (job.owner === user.username || user.role === 'admin') {
    summary.filename = job.originalFilename;
    summary.owner = job.owner;
  }

  return summary;
}

function visibleFailure(failure, user) {
  if (!failure) return null;

  const job = getJob(failure.id);

  return job && (job.owner === user.username || user.role === 'admin')
    ? failure
    : { id: failure.id, at: failure.at, error: null };
}
