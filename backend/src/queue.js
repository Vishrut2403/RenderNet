import fs from 'fs';
import path from 'path';
import RenderWorker from './render-worker.js';
import { ensureDir, freeBytes } from './utils/file-utils.js';
import { dataPath, DATA_DIR, SCRATCH_DIR, USER_QUOTA_BYTES, MIN_FREE_BYTES } from './paths.js';
import {
  saveJob, loadJobs, deleteJob,
  createFrames, getFrames, getPendingFrames, countFramesByStatus,
  markFrameDone, markFramePending, markFrameAttemptFailed, resetFailedFrames,
  getFailedFrames, getAllFailedFrames, doneFrameTimes
} from './db.js';

// A frame gets three goes before it counts as failed. Transient causes - a
// momentary VRAM shortage, a file still being written - are common enough that
// giving up on the first one loses frames that would have rendered.
const MAX_FRAME_ATTEMPTS = 3;
const MAX_INTERRUPTIONS = 2;

// Rechecked rather than failed outright: somebody deleting a finished job is
// all it takes to free the disk, and the queue should pick up by itself when
// they do rather than needing every held job resubmitted.
const DISK_RECHECK_MS = 60 * 1000;

const jobs = new Map();
const renderQueue = [];
let isRendering = false;
let currentJobId = null;
let currentWorker = null;
let heldForDisk = null;
let diskTimer = null;

// Separate from 'renders' so a worker never streams a frame out of the same
// file the upload route is writing into.
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

// A frame is only really done if its output is still on disk. The database can
// outlive the files - cleanup removes them, or someone empties renders/ - and
// re-rendering a frame is cheaper than handing back a ZIP with a hole in it.
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

// A job left mid-render by a restart has no worker behind it any more, so it is
// queued again to pick up at the frames it has not rendered yet. The workstation
// is shut down nightly, which makes interruption routine rather than a fault:
// only a job that keeps being interrupted without ever advancing is abandoned.
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
    formats: jobData.formats || 'PNG'
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

// A more important job does not wait for the current one to finish. The job it
// displaces goes back to pending with every frame it delivered intact, so it
// resumes where it stopped - the same path a job takes when the workstation is
// switched off mid-render.
function preemptFor(job) {
  if (!isRendering || currentJobId === job.id) return false;

  const running = jobs.get(currentJobId);
  if (!running || running.status !== 'rendering') return false;
  if ((running.priority ?? 0) >= (job.priority ?? 0)) return false;

  console.log(`Job ${running.id} paused for higher priority job ${job.id}`);

  running.status = 'pending';
  running.startedAt = null;
  running.currentFrame = null;
  running.pausedBy = job.owner;
  // Being pushed aside is not a crash, so it must not count toward the
  // abandonment rule the way an interrupted restart does.
  running.framesAtResume = countFramesByStatus(running.id).done;
  saveJob(running);

  renderQueue.push(running.id);

  if (currentWorker) {
    try {
      currentWorker.cancel();
    } catch (error) {
      console.error('Failed to pause worker:', error.message);
    }
  }

  return true;
}

// Retries the frames that did not make it, keeping the ones that did. A job
// whose scene was at fault is usually fixed by re-uploading, but a frame lost
// to a full GPU or a missing texture is worth asking for again on its own.
export function rerunJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };

  if (job.status !== 'failed' && job.status !== 'completed') {
    return { success: false, error: `Cannot rerun a ${job.status} job` };
  }

  if (!job.filePath || !fs.existsSync(dataPath(job.filePath))) {
    return { success: false, error: 'The uploaded .blend is no longer on the workstation' };
  }

  // reconcileFrames first: a frame counted as done whose file has since been
  // swept has to go back in the queue with the ones that failed.
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

// Highest priority first, and submission order within a priority.
function sortQueue() {
  renderQueue.sort((a, b) => {
    const byPriority = (jobs.get(b)?.priority ?? 0) - (jobs.get(a)?.priority ?? 0);
    return byPriority !== 0 ? byPriority : a - b;
  });
}

function processQueue() {
  if (isRendering) {
    console.log('Already rendering, queue paused');
    return;
  }
  
  if (renderQueue.length === 0) {
    console.log('Queue is empty');
    return;
  }

  const free = freeBytes(DATA_DIR);

  if (free !== null && free < MIN_FREE_BYTES) {
    heldForDisk = `Only ${(free / 1024 ** 3).toFixed(1)} GB of disk left; `
      + 'renders are held until finished jobs are deleted';

    console.warn(`Queue held: ${heldForDisk}`);

    clearTimeout(diskTimer);
    diskTimer = setTimeout(processQueue, DISK_RECHECK_MS);
    diskTimer.unref?.();
    return;
  }

  heldForDisk = null;

  sortQueue();

  const jobId = renderQueue.shift();
  const job = jobs.get(jobId);
  
  if (!job) {
    console.error(`Job ${jobId} not found in storage`);
    processQueue();
    return;
  }
  
  job.status = 'rendering';
  job.startedAt = new Date().toISOString();
  job.pausedBy = null;
  saveJob(job);
  isRendering = true;
  currentJobId = jobId;
  
  console.log(`Starting render for job ${jobId}`);

  const worker = new RenderWorker('local-worker');
  currentWorker = worker;

  worker
    .renderJob({
      id: jobId,
      blendPath: dataPath(job.filePath),
      outputDir: workerScratchDir(jobId),
      // Only what is left: a resumed job picks up where the last run stopped
      // rather than rendering the whole range again.
      frames: getPendingFrames(jobId),
      renderEngine: job.renderEngine,
      resolutionPercent: job.resolutionPercent,
      samples: job.samples,
      formats: job.formats
    })
    .then(() => finishRender(jobId))
    .catch((error) => {
      console.error(`Worker crashed on job ${jobId}: ${error.message}`);
      failJob(jobId, error.message);
    });
}

// Reached only once the worker has stopped for good. Completion and failure
// normally arrive over HTTP and have already released the slot; this covers
// cancellation, where the worker stops without reporting anything.
function finishRender(jobId) {
  const job = jobs.get(jobId);

  if (job?.status === 'cancelled') {
    deleteJobFiles(job);
    forgetUsage(job.owner);
  } else if (job?.status === 'pending') {
    // Paused for something more important; its files stay put for the resume.
    console.log(`Job ${jobId} stopped cleanly, waiting to resume`);
  } else if (job?.status === 'rendering') {
    failJob(jobId, 'Worker stopped without reporting completion');
    return;
  }

  releaseSlot(jobId);
}

function releaseSlot(jobId) {
  if (currentJobId !== jobId) return;

  isRendering = false;
  currentJobId = null;
  currentWorker = null;
  setTimeout(processQueue, 1000);
}

function failJob(jobId, message) {
  const job = jobs.get(jobId);

  if (job && job.status === 'rendering') {
    job.status = 'failed';
    job.error = message;
    job.completedAt = new Date().toISOString();
    saveJob(job);
  }

  releaseSlot(jobId);
}

function jobFilesExist(job) {
  return !!(job.filePath && fs.existsSync(dataPath(job.filePath)))
    || !!(job.outputFolder && fs.existsSync(dataPath(job.outputFolder)));
}

// Jobs are pruned by age but files are deleted by mtime, and a render's mtime
// is its last frame - long after the job was created. The record is the only
// thing tying those bytes to an owner, so it has to outlive them or the space
// stops counting against anybody's quota. Cleanup deletes the files first, so
// the record goes in the same pass.
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
    startsIn: queueWaits().get(jobId) ?? null
  };
}

// One query for every job's failures rather than one per job: the dashboard
// polls this list every couple of seconds while a render is running.
export function getAllJobs() {
  const errorsByJob = new Map();

  for (const row of getAllFailedFrames()) {
    if (!errorsByJob.has(row.jobId)) errorsByJob.set(row.jobId, []);
    errorsByJob.get(row.jobId).push(asFrameError(row));
  }

  const waits = queueWaits();

  return Array.from(jobs.values()).map(job => ({
    ...job,
    frameErrors: errorsByJob.get(job.id) ?? [],
    startsIn: waits.get(job.id) ?? null
  }));
}

export function getQueueStatus() {
  // Sorted first: the queue is only ordered when it is about to be read from,
  // so an unsorted read hands back an order the queue will not actually run in.
  sortQueue();

  return {
    isRendering,
    heldForDisk,
    currentJobId,
    queueLength: renderQueue.length,
    totalJobs: jobs.size,
    pendingJobs: renderQueue.length,
    queue: renderQueue.map(id => ({
      id,
      filename: jobs.get(id)?.originalFilename
    }))
  };
}

const RATE_TTL_MS = 10 * 1000;
let frameRate = { at: 0, value: null };

// Taken from when frames were delivered rather than from a job's startedAt,
// which is cleared whenever a job is paused or resumed. The median rather than
// the mean: gaps spanning a pause, a rerun, or a night with the machine off are
// wildly longer than a frame takes, and would drag an average with them.
function typicalFrameMs() {
  if (Date.now() - frameRate.at < RATE_TTL_MS) return frameRate.value;

  const gaps = [];
  let previous = null;

  for (const row of doneFrameTimes()) {
    const at = new Date(row.updatedAt).getTime();

    if (previous && previous.jobId === row.jobId) {
      const gap = at - previous.at;
      if (gap > 0) gaps.push(gap);
    }

    previous = { jobId: row.jobId, at };
  }

  gaps.sort((a, b) => a - b);

  if (gaps.length === 0) {
    // Not cached: before the first two frames land there is nothing to read,
    // and holding that answer would outlast the frames arriving. The query is
    // cheap while there is nothing for it to find.
    return null;
  }

  const value = gaps[Math.floor(gaps.length / 2)];
  frameRate = { at: Date.now(), value };

  return value;
}

function framesLeft(job) {
  return Math.max(0, job.totalFrames - job.completedFrames);
}

// One pass over the queue in order, accumulating the work ahead of each job, so
// the whole list can be answered without walking the queue once per job.
export function queueWaits() {
  const waits = new Map();
  const typical = typicalFrameMs();

  if (typical === null) return waits;

  const running = jobs.get(currentJobId);
  let ahead = 0;

  if (running && running.status === 'rendering' && running.startedAt) {
    // The job in flight has a rate of its own, which beats the general one for
    // the estimate that dominates a short queue.
    const observed = running.completedFrames > 0
      ? (Date.now() - new Date(running.startedAt).getTime()) / running.completedFrames
      : typical;

    ahead += framesLeft(running) * observed;
  }

  sortQueue();

  for (const id of renderQueue) {
    waits.set(id, Math.round(ahead));

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

// Counted from frames actually delivered rather than from how far along the
// range the worker has reached, so a resumed job reports the progress it kept.
function syncFrameCounts(job) {
  const counts = countFramesByStatus(job.id);

  job.completedFrames = counts.done;
  job.failedFrames = counts.failed;
  job.progress = job.totalFrames > 0
    ? Math.max(0, Math.min(100, Math.round((counts.done / job.totalFrames) * 100)))
    : 0;

  return counts;
}

// A worker callback for a job that is no longer rendering must not touch it:
// a cancelled job would have its counters moved and its output folder written
// back after cancellation already deleted it.
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
    // from under a live process, so finishRender does it once that has stopped.
    if (currentJobId === jobId) {
      console.log(`Job ${jobId} cancelled while it was pausing`);
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

    if (currentWorker && currentJobId === jobId) {
      let killed = false;

      try {
        killed = currentWorker.cancel();
      } catch (error) {
        console.error(`Failed to cancel worker:`, error.message);
      }

      console.log(
        killed
          ? `Killed Blender process for job ${jobId}`
          : `Job ${jobId} will stop before its next frame`
      );

      // The slot and the job's files are released by finishRender, once the
      // worker has actually stopped. Doing it here would let a frame still in
      // flight recreate the output folder after it was deleted, and would run
      // the next job alongside a Blender process that is still winding down.
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