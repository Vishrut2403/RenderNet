import {
  recentFrameDurations, frameDurationsFor, jobDurationsBy, liveLeases
} from './db.js';

const CACHE_TTL_MS = 10 * 1000;

let frameRate = { at: 0, value: null };

// A job's timings only change when one of its own frames does, and a finished
// job's never change again - so they are worked out once each and forgotten
// only when that job's frames move.
const perJob = new Map();

export function forgetTiming(jobId) {
  perJob.delete(jobId);
}

// Median, so one pathological frame does not move the estimate for the rest.
export function typicalFrameMs() {
  if (Date.now() - frameRate.at < CACHE_TTL_MS) return frameRate.value;

  const durations = recentFrameDurations().sort((a, b) => a - b);

  // Not cached: holding this answer would outlast the first frames arriving.
  if (durations.length === 0) return null;

  const value = durations[Math.floor(durations.length / 2)];
  frameRate = { at: Date.now(), value };

  return value;
}

function median(values) {
  return values.length === 0 ? null : [...values].sort((a, b) => a - b)[values.length >> 1];
}

// What a frame of this job costs this machine, from its own frames of it and
// nothing else. Comparing a machine's recent rate with the farm's looked like
// it would answer this without waiting for a measurement, and does not: the two
// medians are taken over different sets of frames - one job's, and the farm's
// last few hundred - so whichever machine rendered most of them recently pulls
// both towards itself and the comparison says every machine is average. Null
// until this machine has rendered a frame of this job, which is what measures
// it.
export function machineFrameMs(jobId, workerId) {
  return workerId ? median(jobDurationsBy(jobId, workerId)) : null;
}

// Only the jobs asked about: working out every job in the farm to render a
// list of them is what made this expensive.
export function frameTimings(jobIds) {
  const timings = new Map();

  for (const jobId of jobIds) {
    if (!perJob.has(jobId)) perJob.set(jobId, timingFor(jobId));

    const timing = perJob.get(jobId);
    if (timing) timings.set(jobId, timing);
  }

  return timings;
}

function timingFor(jobId) {
  const measured = frameDurationsFor(jobId);

  if (measured.length === 0) return null;

  const slowest = measured[measured.length - 1];

  return {
    measured: measured.length,
    medianMs: measured[Math.floor(measured.length / 2)].durationMs,
    slowestMs: slowest.durationMs,
    slowestFrame: slowest.frame
  };
}

function framesLeft(job) {
  return Math.max(0, job.totalFrames - job.completedFrames);
}

// The running jobs and the queued ones in the order they will run: the caller
// owns that order, and handing it over keeps this from reaching back into the
// scheduler for it.
export function queueWaits(running, queued) {
  const waits = new Map();
  const typical = typicalFrameMs();

  if (typical === null) return waits;

  // Frames render side by side, so the work ahead is shared between workers.
  const workers = Math.max(new Set(liveLeases().map(lease => lease.leasedBy)).size, 1);

  let ahead = 0;

  for (const job of running) ahead += framesLeft(job) * typical;

  for (const job of queued) {
    waits.set(job.id, Math.round(ahead / workers));
    ahead += framesLeft(job) * typical;
  }

  return waits;
}
