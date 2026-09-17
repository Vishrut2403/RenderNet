import path from 'path';
import { loadJobs, saveJob } from './db.js';
import { SCRATCH_DIR } from './paths.js';

export const jobs = new Map();

let lastJobId = 0;

for (const job of loadJobs()) {
  // An encode does not outlive the process that ran it.
  if (job.video === 'encoding') {
    job.video = null;
    saveJob(job);
  }

  jobs.set(job.id, job);
  lastJobId = Math.max(lastJobId, job.id);
}

export function nextJobId() {
  const now = Date.now();
  lastJobId = now > lastJobId ? now : lastJobId + 1;
  return lastJobId;
}

export function workerScratchDir(jobId) {
  return path.join(SCRATCH_DIR, `job_${jobId}`);
}
