import path from 'path';
import { loadJobs } from './db.js';
import { SCRATCH_DIR } from './paths.js';

// Every job the server knows about, loaded once at boot and kept in step with
// the database by whoever changes one. Held here rather than in the scheduler
// so that disk accounting can read it without the two importing each other.
export const jobs = new Map();

let lastJobId = 0;

for (const job of loadJobs()) {
  jobs.set(job.id, job);
  lastJobId = Math.max(lastJobId, job.id);
}

// Milliseconds, so ids sort by age and survive a restart without a counter to
// persist. Two jobs in the same millisecond take the next number up.
export function nextJobId() {
  const now = Date.now();
  lastJobId = now > lastJobId ? now : lastJobId + 1;
  return lastJobId;
}

export function workerScratchDir(jobId) {
  return path.join(SCRATCH_DIR, `job_${jobId}`);
}
