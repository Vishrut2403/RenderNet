import {
  recentFrameDurations, frameDurationsFor, jobDurationsBy, liveLeases
} from './db.js';

const CACHE_TTL_MS = 10 * 1000;

let frameRate = { at: 0, value: null };

const perJob = new Map();

export function forgetTiming(jobId) {
  perJob.delete(jobId);
}

export function typicalFrameMs() {
  if (Date.now() - frameRate.at < CACHE_TTL_MS) return frameRate.value;

  const durations = recentFrameDurations().sort((a, b) => a - b);

  if (durations.length === 0) return null;

  const value = durations[Math.floor(durations.length / 2)];
  frameRate = { at: Date.now(), value };

  return value;
}

function median(values) {
  return values.length === 0 ? null : [...values].sort((a, b) => a - b)[values.length >> 1];
}

export function machineFrameMs(jobId, workerId) {
  return workerId ? median(jobDurationsBy(jobId, workerId)) : null;
}

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

export function queueWaits(running, queued) {
  const waits = new Map();
  const typical = typicalFrameMs();

  if (typical === null) return waits;

  const workers = Math.max(new Set(liveLeases().map(lease => lease.leasedBy)).size, 1);

  const timings = frameTimings([...running, ...queued].map(job => job.id));
  const costOf = job => framesLeft(job) * (timings.get(job.id)?.medianMs ?? typical);

  let ahead = 0;

  for (const job of running) ahead += costOf(job);

  for (const job of queued) {
    waits.set(job.id, Math.round(ahead / workers));
    ahead += costOf(job);
  }

  return waits;
}
