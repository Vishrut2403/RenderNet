import { getFailedFrames, getAllFailedFrames } from './db.js';
import { jobs } from './job-store.js';
import { frameTimings } from './estimates.js';
import { queueWaits } from './queue.js';

// What a job looks like to the API: the record, plus the things that are only
// known by asking somewhere else.
function parseMissing(stored) {
  if (!stored) return null;

  try {
    return JSON.parse(stored).map(file => file.split(/[\\/]/).pop());
  } catch {
    return null;
  }
}

function asFrameError(row) {
  return { frame: row.frame, error: row.error, at: row.updatedAt };
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  return {
    ...job,
    missingAssets: parseMissing(job.missingAssets),
    frameErrors: getFailedFrames(jobId).map(asFrameError),
    timing: frameTimings([jobId]).get(jobId) ?? null,
    startsIn: queueWaits().get(jobId) ?? null
  };
}

// One query rather than one per job: the dashboard polls this every few seconds.
export function getAllJobs() {
  const errorsByJob = new Map();

  for (const row of getAllFailedFrames()) {
    if (!errorsByJob.has(row.jobId)) errorsByJob.set(row.jobId, []);
    errorsByJob.get(row.jobId).push(asFrameError(row));
  }

  const waits = queueWaits();
  const timings = frameTimings(jobs.keys());

  return Array.from(jobs.values()).map(job => ({
    ...job,
    missingAssets: parseMissing(job.missingAssets),
    timing: timings.get(job.id) ?? null,
    frameErrors: errorsByJob.get(job.id) ?? [],
    startsIn: waits.get(job.id) ?? null
  }));
}
