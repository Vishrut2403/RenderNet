import fs from 'fs';
import { ensureWorkers, stopWorkers } from './worker-pool.js';
import path from 'path';
import { ensureDir, freeBytes } from './utils/file-utils.js';
import { dataPath, DATA_DIR, SCRATCH_DIR, USER_QUOTA_BYTES, MIN_FREE_BYTES } from './paths.js';
import {
  saveJob, loadJobs, deleteJob,
  createFrames, getFrames, countFramesByStatus,
  markFrameDone, markFramePending, markFrameAttemptFailed, resetFailedFrames,
  getFailedFrames, getAllFailedFrames, recentFrameDurations, frameDurationsByJob,
  leaseFrame, renewLease, releaseLease, getLease, liveLeases, clearJobLeases
} from './db.js';
import { DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY } from './formats.js';

const MAX_FRAME_ATTEMPTS = 3;
const MAX_INTERRUPTIONS = 2;

const DISK_RECHECK_MS = 60 * 1000;

const jobs = new Map();
const renderQueue = [];
const active = new Set();
let heldForDisk = null;
let diskTimer = null;

// The worker renews this while a frame is still rendering.
const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS) || 2 * 60 * 1000;

const FAILFAST_FRAMES = 3;

const DRAIN_POLL_MS = 500;

let lastFailure = null;

function workerScratchDir(jobId) {
  return path.join(SCRATCH_DIR, `job_${jobId}`);
}

let lastJobId = 0;

for (const job of loadJobs()) {
  jobs.set(job.id, job);
  lastJobId = Math.max(lastJobId, job.id);
}

function nextJobId() {
  const now = Date.now();
  lastJobId = now > lastJobId ? now : lastJobId + 1;
  return lastJobId;
}

// The database can outlive the frames: cleanup removes them, or someone empties
// renders/ by hand.
function reconcileFrames(job) {
  if (getFrames(job.id).length === 0 && Number.isInteger(job.frameStart)) {
    createFrames(job.id, job.frameStart, job.frameEnd);
  }

  let done = 0;

  for (const frame of getFrames(job.id)) {
    if (frame.status !== 'done') continue;

    const present = job.outputFolder
      && frame.filename
      && fs.existsSync(dataPath(job.outputFolder, frame.filename));

    if (present) done++;
    else markFramePending(job.id, frame.frame);
  }

  return done;
}

// The workstation is shut down nightly, so interruption is routine: only a job
// interrupted repeatedly without ever advancing is abandoned.
export function resumeInterruptedJobs() {
  let resumed = 0;
  let abandoned = 0;

  for (const job of jobs.values()) {
    if (job.status !== 'rendering' && job.status !== 'pending') continue;

    const done = reconcileFrames(job);

    if (job.status === 'rendering') {
      job.interruptions = done > (job.framesAtResume ?? 0) ? 0 : (job.interruptions ?? 0) + 1;

      if (job.interruptions > MAX_INTERRUPTIONS) {
        job.status = 'failed';
        job.error = 'Abandoned after repeated restarts without rendering a frame';
        job.completedAt = new Date().toISOString();
        abandoned++;
        saveJob(job);
        continue;
      }
    }

    Object.assign(job, {
      status: 'pending',
      startedAt: null,
      currentFrame: null,
      error: null,
      framesAtResume: done
    });

    syncFrameCounts(job);
    saveJob(job);

    renderQueue.push(job.id);
    resumed++;
  }

  if (resumed || abandoned) {
    console.log(`Recovered ${resumed} interrupted job(s), abandoned ${abandoned}`);
  }

  if (resumed) processQueue();
}

export function addToQueue(jobData) {
  const jobId = nextJobId();
  const outputFolder = path.join('renders', `render_${jobId}`);
  ensureDir(dataPath(outputFolder));

  const job = {
    id: jobId,
    status: 'pending',
    filePath: jobData.filePath,
    outputPath: path.join(outputFolder, 'frame_####.png'),
    outputFolder,
    frameStart: jobData.frameStart,
    frameEnd: jobData.frameEnd,
    renderEngine: jobData.renderEngine || 'CYCLES',
    originalFilename: jobData.originalFilename,
    owner: jobData.owner || 'anonymous',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
    totalFrames: jobData.frameEnd - jobData.frameStart + 1,
    currentFrame: null,
    progress: 0,
    completedFrames: 0,
    failedFrames: 0,
    interruptions: 0,
    framesAtResume: 0,
    priority: Number(jobData.priority) || 0,
    pausedBy: null,
    resolutionPercent: jobData.resolutionPercent ?? 100,
    samples: jobData.samples ?? null,
    formats: jobData.formats || 'PNG',
    exrCodec: jobData.exrCodec || DEFAULT_EXR_CODEC,
    exrDepth: jobData.exrDepth || DEFAULT_EXR_DEPTH,
    jpegQuality: jobData.jpegQuality ?? DEFAULT_JPEG_QUALITY
  };

  jobs.set(jobId, job);
  createFrames(jobId, job.frameStart, job.frameEnd);
  saveJob(job);
  forgetUsage(job.owner);
  renderQueue.push(jobId);

  console.log(`Job ${jobId} added to queue. Queue length: ${renderQueue.length}`);

  if (!preemptFor(job)) processQueue();

  return jobId;
}

function preemptFor(job) {
  const displaceable = activeJobs()
    .filter(running => (running.priority ?? 0) < (job.priority ?? 0));

  if (displaceable.length === 0) return false;

  const running = displaceable[displaceable.length - 1];

  console.log(`Job ${running.id} paused for higher priority job ${job.id}`);

  running.status = 'pending';
  running.startedAt = null;
  running.currentFrame = null;
  running.pausedBy = job.owner;
  // Being pushed aside must not count toward the abandonment rule.
  running.framesAtResume = countFramesByStatus(running.id).done;
  saveJob(running);

  renderQueue.push(running.id);

  whenWorkersLetGo(running.id);

  return true;
}

export function rerunJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };

  if (job.status !== 'failed' && job.status !== 'completed') {
    return { success: false, error: `Cannot rerun a ${job.status} job` };
  }

  if (!job.filePath || !fs.existsSync(dataPath(job.filePath))) {
    return { success: false, error: 'The uploaded .blend is no longer on the workstation' };
  }

  // Before resetting: a frame counted as done whose file has been swept has to
  // go back with the ones that failed.
  const delivered = reconcileFrames(job);

  resetFailedFrames(jobId);
  const retried = countFramesByStatus(jobId).pending;

  if (retried === 0) {
    return { success: false, error: 'Every frame rendered; there is nothing to rerun' };
  }

  ensureDir(dataPath(job.outputFolder));

  Object.assign(job, {
    status: 'pending',
    startedAt: null,
    completedAt: null,
    currentFrame: null,
    error: null,
    interruptions: 0,
    framesAtResume: delivered,
    pausedBy: null
  });

  syncFrameCounts(job);
  saveJob(job);

  renderQueue.push(jobId);
  console.log(`Job ${jobId} queued again for ${retried} frame(s)`);

  processQueue();

  return { success: true, jobId, frames: retried };
}

export function setJobPriority(jobId, priority) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };

  if (job.status !== 'pending' && job.status !== 'rendering') {
    return { success: false, error: `Cannot reprioritise a ${job.status} job` };
  }

  job.priority = Number(priority) || 0;
  saveJob(job);

  if (!preemptFor(job)) sortQueue();

  return { success: true, priority: job.priority };
}

function sortQueue() {
  renderQueue.sort((a, b) => {
    const byPriority = (jobs.get(b)?.priority ?? 0) - (jobs.get(a)?.priority ?? 0);
    return byPriority !== 0 ? byPriority : a - b;
  });
}

// Highest priority first, so a lease comes from the most important job that
// still has a frame to give.
function activeJobs() {
  return [...active]
    .map(jobId => jobs.get(jobId))
    .filter(job => job?.status === 'rendering')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id);
}

function diskIsTooFull() {
  const free = freeBytes(DATA_DIR);

  if (free === null || free >= MIN_FREE_BYTES) {
    heldForDisk = null;
    return false;
  }

  heldForDisk = `Only ${(free / 1024 ** 3).toFixed(1)} GB of disk left; `
    + 'renders are held until finished jobs are deleted';

  console.warn(`Queue held: ${heldForDisk}`);

  clearTimeout(diskTimer);
  diskTimer = setTimeout(processQueue, DISK_RECHECK_MS);
  diskTimer.unref?.();

  return true;
}

function promoteNext() {
  if (renderQueue.length === 0 || diskIsTooFull()) return null;

  sortQueue();

  const jobId = renderQueue.shift();
  const job = jobs.get(jobId);

  if (!job) {
    console.error(`Job ${jobId} not found in storage`);
    return promoteNext();
  }

  // A claim left from a stint that has already ended would make the job
  // unfinishable.
  clearJobLeases(jobId);

  job.status = 'rendering';
  job.startedAt = new Date().toISOString();
  job.pausedBy = null;
  saveJob(job);
  active.add(jobId);

  console.log(`Job ${jobId} is now being rendered`);
  ensureWorkers();

  return job;
}

function processQueue() {
  if (active.size > 0) return;

  if (renderQueue.length === 0) {
    console.log('Queue is empty');
    return;
  }

  promoteNext();
}

const drainTimers = new Map();

// A worker in another process cannot be reached from here, so a stopped job is
// only finished with once every claim on it has gone.
function whenWorkersLetGo(jobId) {
  if (drainTimers.has(jobId)) return;

  const check = () => {
    if (liveLeases().some(lease => lease.jobId === jobId)) {
      const timer = setTimeout(check, DRAIN_POLL_MS);
      timer.unref?.();
      drainTimers.set(jobId, timer);
      return;
    }

    drainTimers.delete(jobId);
    finishStoppedJob(jobId);
  };

  check();
}

// Read from the job's state now rather than when it was stopped: a paused job
// can be cancelled outright while its Blender is still winding down.
function finishStoppedJob(jobId) {
  const job = jobs.get(jobId);

  if (job?.status === 'cancelled') {
    deleteJobFiles(job);
    forgetUsage(job.owner);
  } else if (job?.status === 'pending') {
    console.log(`Job ${jobId} stopped cleanly, waiting to resume`);
  }

  releaseSlot(jobId);
}

function releaseSlot(jobId) {
  if (!active.delete(jobId)) return;

  setTimeout(processQueue, 1000);
}

function failJob(jobId, message) {
  const job = jobs.get(jobId);

  if (job && job.status === 'rendering') {
    job.status = 'failed';
    job.error = message;
    job.completedAt = new Date().toISOString();
    saveJob(job);
    recordFailure(job);
  }

  releaseSlot(jobId);
}

function recordFailure(job) {
  lastFailure = { id: job.id, at: job.completedAt, error: job.error };
}

function leaseFromActive(workerId) {
  for (const job of activeJobs()) {
    const lease = leaseFrame(job.id, workerId, LEASE_TTL_MS);

    if (lease) {
      return {
        ...lease,
        ttlMs: LEASE_TTL_MS,
        blendPath: dataPath(job.filePath),
        outputDir: workerScratchDir(job.id),
        renderEngine: job.renderEngine,
        formats: job.formats,
        resolutionPercent: job.resolutionPercent,
        samples: job.samples,
        exrCodec: job.exrCodec,
        exrDepth: job.exrDepth,
        jpegQuality: job.jpegQuality
      };
    }
  }

  return null;
}

// A worker with nothing to claim starts the next queued job rather than waiting,
// so the tail of one job does not leave the farm idle.
export function leaseNextFrame(workerId) {
  for (;;) {
    const lease = leaseFromActive(workerId);

    if (lease) return lease;
    if (!promoteNext()) break;
  }

  // Nothing claimable can mean a job is finished, which its own last upload
  // cannot tell while that claim is still open.
  for (const jobId of [...active]) settleJob(jobId);

  return null;
}

// Refused once the job is no longer rendering, which is how a worker learns it
// was cancelled or preempted.
export function renewFrameLease(leaseId) {
  const lease = getLease(leaseId);

  if (!lease) return { ok: false, reason: 'unknown' };

  const job = jobs.get(lease.jobId);

  if (!job || job.status !== 'rendering') return { ok: false, reason: 'stopped' };

  const expiresAt = renewLease(leaseId, LEASE_TTL_MS);

  return expiresAt ? { ok: true, expiresAt } : { ok: false, reason: 'expired' };
}

export function releaseFrameLease(leaseId) {
  const lease = getLease(leaseId);

  if (!lease) return false;

  releaseLease(leaseId);
  settleJob(lease.jobId);

  return true;
}

// Only the frames on disk are downloadable, so the server decides this rather
// than taking a worker's word for it.
function settleJob(jobId) {
  const job = jobs.get(jobId);

  if (!job || job.status !== 'rendering') return;

  const counts = syncFrameCounts(job);
  saveJob(job);

  if (counts.done === 0 && counts.failed >= FAILFAST_FRAMES) {
    failJob(jobId, `The first ${counts.failed} frames all failed`);
    return;
  }

  if (counts.pending > 0) return;
  if (liveLeases().some(lease => lease.jobId === jobId)) return;

  completeJob(jobId, { successfulFrames: counts.done, failedFrames: counts.failed });
}

function jobFilesExist(job) {
  return !!(job.filePath && fs.existsSync(dataPath(job.filePath)))
    || !!(job.outputFolder && fs.existsSync(dataPath(job.outputFolder)));
}

// The record is the only thing tying rendered bytes to an owner, so it must not
// outlive the files or the space stops counting against anybody's quota.
export function pruneOldJobs(cutoffMs) {
  let pruned = 0;

  for (const job of jobs.values()) {
    if (job.status === 'pending' || job.status === 'rendering') continue;
    if (new Date(job.createdAt).getTime() >= cutoffMs) continue;
    if (jobFilesExist(job)) continue;

    jobs.delete(job.id);
    deleteJob(job.id);
    forgetUsage(job.owner);
    pruned++;
  }

  return pruned;
}

function asFrameError(row) {
  return { frame: row.frame, error: row.error, at: row.updatedAt };
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  return {
    ...job,
    frameErrors: getFailedFrames(jobId).map(asFrameError),
    timing: frameTimings().get(jobId) ?? null,
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
  const timings = frameTimings();

  return Array.from(jobs.values()).map(job => ({
    ...job,
    timing: timings.get(job.id) ?? null,
    frameErrors: errorsByJob.get(job.id) ?? [],
    startsIn: waits.get(job.id) ?? null
  }));
}

export function getQueueStatus() {
  // The queue is only ordered when read from, so an unsorted read would hand
  // back an order it will not run in.
  sortQueue();

  return {
    isRendering: active.size > 0,
    heldForDisk,
    activeJobs: activeJobs().map(job => job.id),
    workers: liveLeases().map(({ leasedBy, jobId, frame }) => ({ id: leasedBy, jobId, frame })),
    queueLength: renderQueue.length,
    totalJobs: jobs.size,
    pendingJobs: renderQueue.length,
    lastFailure,
    queue: renderQueue.map(id => ({
      id,
      filename: jobs.get(id)?.originalFilename
    }))
  };
}

const RATE_TTL_MS = 10 * 1000;
let frameRate = { at: 0, value: null };

// Median, so one pathological frame does not move the estimate for the rest.
function typicalFrameMs() {
  if (Date.now() - frameRate.at < RATE_TTL_MS) return frameRate.value;

  const durations = recentFrameDurations().sort((a, b) => a - b);

  // Not cached: holding this answer would outlast the first frames arriving.
  if (durations.length === 0) return null;

  const value = durations[Math.floor(durations.length / 2)];
  frameRate = { at: Date.now(), value };

  return value;
}

export function frameTimings() {
  const byJob = new Map();

  for (const row of frameDurationsByJob()) {
    if (!byJob.has(row.jobId)) byJob.set(row.jobId, []);
    byJob.get(row.jobId).push(row);
  }

  const timings = new Map();

  for (const [jobId, rows] of byJob) {
    const sorted = [...rows].sort((a, b) => a.durationMs - b.durationMs);
    const slowest = sorted[sorted.length - 1];

    timings.set(jobId, {
      measured: rows.length,
      medianMs: sorted[Math.floor(sorted.length / 2)].durationMs,
      slowestMs: slowest.durationMs,
      slowestFrame: slowest.frame
    });
  }

  return timings;
}

function framesLeft(job) {
  return Math.max(0, job.totalFrames - job.completedFrames);
}

export function queueWaits() {
  const waits = new Map();
  const typical = typicalFrameMs();

  if (typical === null) return waits;

  // Frames render side by side, so the work ahead is shared between workers.
  const workers = Math.max(new Set(liveLeases().map(lease => lease.leasedBy)).size, 1);

  let ahead = 0;

  for (const job of activeJobs()) ahead += framesLeft(job) * typical;

  sortQueue();

  for (const id of renderQueue) {
    waits.set(id, Math.round(ahead / workers));

    const job = jobs.get(id);
    if (job) ahead += framesLeft(job) * typical;
  }

  return waits;
}

export function getQueuePosition(jobId) {
  sortQueue();

  const index = renderQueue.indexOf(jobId);
  return index === -1 ? null : index + 1;
}

// From frames delivered rather than how far the range has got, so a resumed job
// keeps the progress it had.
function syncFrameCounts(job) {
  const counts = countFramesByStatus(job.id);

  job.completedFrames = counts.done;
  job.failedFrames = counts.failed;
  job.progress = job.totalFrames > 0
    ? Math.max(0, Math.min(100, Math.round((counts.done / job.totalFrames) * 100)))
    : 0;

  return counts;
}

// A callback for a job that is no longer rendering would write its output folder
// back after cancellation deleted it.
function renderingJob(jobId) {
  const job = jobs.get(jobId);
  return job && job.status === 'rendering' ? job : null;
}

export function updateJobProgress(jobId, currentFrame) {
  const job = renderingJob(jobId);
  if (!job) return null;

  job.currentFrame = currentFrame;
  syncFrameCounts(job);
  saveJob(job);

  return job;
}

export function recordFrameUpload(jobId, frameNumber, filename) {
  const job = renderingJob(jobId);
  if (!job) return null;

  markFrameDone(jobId, frameNumber, filename);
  job.currentFrame = frameNumber;
  syncFrameCounts(job);
  saveJob(job);

  return job;
}

// Returns the frame's own record too: whether it has attempts left is what
// tells the worker to try again, so the server stays the one keeping count.
export function recordFrameFailure(jobId, frameNumber, error) {
  const job = renderingJob(jobId);
  if (!job) return null;

  const frame = markFrameAttemptFailed(jobId, frameNumber, error, MAX_FRAME_ATTEMPTS);
  syncFrameCounts(job);
  saveJob(job);

  settleJob(jobId);

  return { job, frame };
}

export function completeJob(jobId, { successfulFrames, failedFrames }) {
  const job = jobs.get(jobId);
  if (!job) return null;

  // A late callback must not resurrect a job cancelled mid-render.
  if (job.status === 'cancelled') {
    console.log(`Ignoring completion for cancelled job ${jobId}`);
    return job;
  }

  // What actually arrived is authoritative. The worker's tally can disagree
  // with it - an upload whose response was lost counts as failed there and as
  // delivered here - and only the frames on disk are downloadable.
  const counts = syncFrameCounts(job);
  const delivered = counts.done;
  const failed = counts.failed;

  if (delivered !== successfulFrames || failed !== failedFrames) {
    console.warn(
      `Job ${jobId}: worker reported ${successfulFrames} ok / ${failedFrames} failed, ` +
      `server recorded ${delivered} / ${failed}`
    );
  }

  job.completedAt = new Date().toISOString();
  job.currentFrame = null;

  if (failed > 0 && delivered === 0) {
    job.status = 'failed';
    job.error = `All ${failed} frame(s) failed to render`;
  } else {
    job.status = 'completed';
    job.progress = 100;
  }

  saveJob(job);
  console.log(`Job ${jobId} finished: ${job.status} (${delivered} ok, ${failed} failed)`);

  if (job.status === 'failed') recordFailure(job);

  releaseSlot(jobId);

  return job;
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };
  
  if (job.status !== 'pending' && job.status !== 'rendering'){
    return {success: false, error: `Cannot cancel ${job.status} job` };
  }

  console.log(`Cancelling job ${jobId}...`);

  if (job.status === 'pending') {
    const index = renderQueue.indexOf(jobId);
    if (index > -1) {
      renderQueue.splice(index, 1);
    }

    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
    saveJob(job);

    // A job paused for a higher-priority one is pending while its Blender is
    // still winding down. Deleting its files now would pull the scratch dir out
    // from under a live process, so it waits for the workers to let go.
    if (active.has(jobId)) {
      console.log(`Job ${jobId} cancelled while it was pausing`);
      whenWorkersLetGo(jobId);
      return { success: true, message: 'Job cancelled successfully' };
    }

    deleteJobFiles(job);
    forgetUsage(job.owner);

    console.log(`Job ${jobId} cancelled (was pending)`);
    return { success: true, message: 'Job cancelled successfully' };
  }
  
  if (job.status === 'rendering') {
    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
    saveJob(job);

    if (active.has(jobId)) {
      console.log(`Job ${jobId} cancelled, waiting for its workers to stop`);

      // The files and the slot are released once the workers have let go.
      // Deleting now would let a frame still in flight recreate the output
      // folder after it was removed.
      whenWorkersLetGo(jobId);

      return { success: true, message: 'Job cancelled successfully' };
    }

    deleteJobFiles(job);
    forgetUsage(job.owner);
    releaseSlot(jobId);

    console.log(`Job ${jobId} cancelled (was rendering)`);

    return { success: true, message: 'Job cancelled successfully' };
  }

  return { success: false, error: 'Job cannot be cancelled' };
}

function deleteJobFiles(job) {
  try {
    if (job.filePath && fs.existsSync(dataPath(job.filePath))) {
      fs.unlinkSync(dataPath(job.filePath));
      console.log(`Deleted upload: ${job.filePath}`);
    }

    if (job.outputFolder && fs.existsSync(dataPath(job.outputFolder))) {
      fs.rmSync(dataPath(job.outputFolder), { recursive: true, force: true });
      console.log(`Deleted renders: ${job.outputFolder}`);
    }

    fs.rmSync(workerScratchDir(job.id), { recursive: true, force: true });
  } catch (error) {
    console.error(`Error deleting files:`, error.message);
  }
}

function sizeOf(target) {
  let total = 0;

  try {
    const stats = fs.statSync(target);
    if (!stats.isDirectory()) return stats.size;

    for (const entry of fs.readdirSync(target)) {
      total += sizeOf(path.join(target, entry));
    }
  } catch {
    // Gone between listing and measuring, which is only ever an overcount.
  }

  return total;
}

// Measured from disk rather than tracked in a counter: a counter drifts the
// moment anything is removed outside the app, and there are few enough jobs
// here that walking them costs nothing.
const usageCache = new Map();
const USAGE_TTL_MS = 10000;

export function usageFor(username, { fresh = false } = {}) {
  const cached = usageCache.get(username);

  if (!fresh && cached && Date.now() - cached.at < USAGE_TTL_MS) {
    return cached.value;
  }

  let bytes = 0;

  for (const job of jobs.values()) {
    if (job.owner !== username) continue;
    if (job.filePath) bytes += sizeOf(dataPath(job.filePath));
    if (job.outputFolder) bytes += sizeOf(dataPath(job.outputFolder));
  }

  const value = {
    bytes,
    quota: USER_QUOTA_BYTES,
    remaining: Math.max(0, USER_QUOTA_BYTES - bytes)
  };

  usageCache.set(username, { at: Date.now(), value });

  return value;
}

// Deleting, cancelling or uploading is exactly when somebody is watching the
// number, so those clear the cache rather than making them wait it out.
function forgetUsage(username) {
  usageCache.delete(username);
}

export function usageByOwner() {
  const owners = new Set(Array.from(jobs.values(), job => job.owner));
  return Object.fromEntries(Array.from(owners, owner => [owner, usageFor(owner)]));
}

// Removing a job is the way space is reclaimed, so it takes the files with it.
// A rendering job has to be cancelled first: its worker is still writing.
export function deleteJobAndFiles(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };

  if (job.status === 'rendering' || job.status === 'pending') {
    return { success: false, error: `Cancel the job before deleting it` };
  }

  deleteJobFiles(job);
  jobs.delete(jobId);
  deleteJob(jobId);
  forgetUsage(job.owner);

  console.log(`Job ${jobId} deleted by request`);

  return { success: true, message: 'Job deleted' };
}

// Cleanup deletes by age alone, which would otherwise take the .blend out from
// under a job that has been sitting in the queue for longer than the cutoff.
export { stopWorkers };

export function getActiveJobPaths() {
  const active = new Set();

  for (const job of jobs.values()) {
    if (job.status !== 'pending' && job.status !== 'rendering') continue;

    if (job.filePath) active.add(dataPath(job.filePath));
    if (job.outputFolder) active.add(dataPath(job.outputFolder));
    active.add(workerScratchDir(job.id));
  }

  return active;
}