import fs from 'fs';
import { ensureWorkers, stopWorkers } from './worker-pool.js';
import path from 'path';
import { ensureDir } from './utils/file-utils.js';
import { dataPath } from './paths.js';
import {
  saveJob, deleteJob,
  createFrames, getFrames, countFramesByStatus,
  markFrameDone, markFramePending, markFrameAttemptFailed, resetFailedFrames,
  leaseFrame, renewLease, releaseLease, getLease, liveLeases, clearJobLeases,
  holdFramesExcept, releaseHeldFrames
} from './db.js';
import { DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY } from './formats.js';
import { workerCanRender, engineIsOffered, machines } from './worker-registry.js';
import { checkAssets, missingAssetsMessage } from './preflight.js';
import { queueWaits as waitsFor, forgetTiming } from './estimates.js';
import { jobs, nextJobId, workerScratchDir } from './job-store.js';
import { diskIsTooFull, heldForDisk, deleteJobFiles, forgetUsage } from './storage.js';
import { isTiled, startComposite } from './composite.js';

const MAX_FRAME_ATTEMPTS = 3;
const MAX_INTERRUPTIONS = 2;

const renderQueue = [];
const active = new Set();

// The worker renews this while a frame is still rendering.
// Long enough that a worker misses six renewals before losing the frame, short
// enough that a machine switched off mid-frame does not strand it for minutes.
const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS) || 30 * 1000;

const FAILFAST_FRAMES = 3;

const DRAIN_POLL_MS = 500;

let lastFailure = null;

// The database can outlive the frames: cleanup removes them, or someone empties
// renders/ by hand.
function reconcileFrames(job) {
  if (getFrames(job.id).length === 0 && Number.isInteger(job.frameStart)) {
    if (isTiled(job)) createFrames(job.id, 1, job.tiles);
    else createFrames(job.id, job.frameStart, job.frameEnd);
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
    // Nothing to resume: it is waiting for a person, not for a worker.
    if (job.approval === 'waiting') continue;

    const done = reconcileFrames(job);

    // A frame whose file has been swept goes back to pending, taking its
    // measured time with it.
    forgetTiming(job.id);

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

    // Killed partway through its own asset check, so it never got an answer.
    if (job.assetCheck === 'checking') startAssetCheck(job);
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
    totalFrames: jobData.tiles ?? jobData.frameEnd - jobData.frameStart + 1,
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
    jpegQuality: jobData.jpegQuality ?? DEFAULT_JPEG_QUALITY,
    testFrame: jobData.testFrame ?? null,
    approval: jobData.testFrame ? 'testing' : null,
    tiles: jobData.tiles ?? null,
    composite: null
  };

  // Queued straight away so it has a position and an estimate like any other,
  // but held back from being claimed until the scene has been looked at.
  if (!jobData.skipAssetCheck) job.assetCheck = 'checking';

  jobs.set(jobId, job);
  // A tiled still is claimed a region at a time, so its units of work are the
  // tiles rather than the one frame they all belong to.
  if (isTiled(job)) createFrames(jobId, 1, job.tiles);
  else createFrames(jobId, job.frameStart, job.frameEnd);
  if (job.testFrame) holdFramesExcept(jobId, job.testFrame);
  saveJob(job);
  forgetUsage(job.owner);
  renderQueue.push(jobId);

  console.log(`Job ${jobId} added to queue. Queue length: ${renderQueue.length}`);

  if (job.assetCheck === 'checking') startAssetCheck(job);
  else if (!preemptFor(job)) processQueue();

  return jobId;
}

// A scene that reaches for textures it did not bring renders untextured rather
// than failing, and nobody wants to find that out at frame 500.
function startAssetCheck(job) {
  checkAssets(dataPath(job.filePath)).then(({ checked, missing }) => {
    const current = jobs.get(job.id);

    // Deleted or cancelled while Blender was reading it.
    if (!current || current.status !== 'pending') return;

    if (checked && missing.length > 0) {
      const queued = renderQueue.indexOf(current.id);
      if (queued > -1) renderQueue.splice(queued, 1);

      current.assetCheck = 'missing';
      current.missingAssets = JSON.stringify(missing);
      saveJob(current);
      failJob(current.id, missingAssetsMessage(missing));

      console.log(`Job ${current.id} reaches for ${missing.length} file(s) it did not bring`);
      return;
    }

    current.assetCheck = checked ? 'ok' : 'skipped';
    saveJob(current);

    if (!preemptFor(current)) processQueue();
  });
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

export function approveJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) return { success: false, error: 'Job not found' };

  if (job.approval !== 'waiting') {
    return { success: false, error: `Job ${jobId} is not waiting on a test frame` };
  }

  releaseHeldFrames(jobId);

  job.approval = 'approved';
  job.error = null;
  // The test frame already counts as progress, so the restart rule starts from
  // where this leaves off rather than treating it as a job that has done nothing.
  job.framesAtResume = countFramesByStatus(jobId).done;
  saveJob(job);

  renderQueue.push(jobId);

  console.log(`Job ${jobId} approved: rendering the remaining frames`);

  if (!preemptFor(job)) processQueue();

  return { success: true, message: 'Rendering the rest of the frames' };
}

export function rerunJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: 'Job not found' };

  if (job.status !== 'failed' && job.status !== 'completed') {
    return { success: false, error: `Cannot rerun a ${job.status} job` };
  }

  // The stored .blend is the one that was checked, so running it again can only
  // produce the same frames with the same files missing.
  if (job.assetCheck === 'missing') {
    return { success: false, error: job.error };
  }

  if (!job.filePath || !fs.existsSync(dataPath(job.filePath))) {
    return { success: false, error: 'The uploaded .blend is no longer on the workstation' };
  }

  // Before resetting: a frame counted as done whose file has been swept has to
  // go back with the ones that failed.
  const delivered = reconcileFrames(job);

  resetFailedFrames(jobId);
  forgetTiming(jobId);
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

function promoteNext() {
  if (renderQueue.length === 0 || diskIsTooFull(processQueue)) return null;

  sortQueue();

  // A job still being looked at, or one this farm has nobody to render, keeps
  // its place in the queue rather than being started: a job marked rendering
  // that no worker will ever claim is a progress bar that never moves.
  const next = renderQueue.findIndex(id => {
    const queued = jobs.get(id);
    return queued?.assetCheck !== 'checking' && engineIsOffered(queued?.renderEngine);
  });

  if (next === -1) return null;

  const [jobId] = renderQueue.splice(next, 1);
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

  if (job && (job.status === 'rendering' || job.status === 'pending')) {
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
    // A worker that cannot render the engine would fail every frame it took,
    // and three failures in a row is enough to stop the job for everyone.
    if (!workerCanRender(workerId, job.renderEngine)) continue;

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
        jpegQuality: job.jpegQuality,
        sceneFrame: isTiled(job) ? job.frameStart : lease.frame,
        tile: isTiled(job) ? { index: lease.frame, of: job.tiles } : null
      };
    }
  }

  return null;
}

// A job promoted before any worker had said what it can do, on a farm where
// none of them can render it. Put back rather than left showing progress it
// will never make; it keeps the frames it has and starts again when a machine
// that offers the engine turns up.
function parkUnrenderable() {
  for (const jobId of [...active]) {
    const job = jobs.get(jobId);

    if (!job || job.status !== 'rendering') continue;
    if (engineIsOffered(job.renderEngine)) continue;
    if (liveLeases().some(lease => lease.jobId === jobId)) continue;

    job.status = 'pending';
    job.startedAt = null;
    job.currentFrame = null;
    saveJob(job);

    renderQueue.push(jobId);
    releaseSlot(jobId);

    console.log(`Job ${jobId} put back: no worker here renders ${job.renderEngine}`);
  }
}

// A worker with nothing to claim starts the next queued job rather than waiting,
// so the tail of one job does not leave the farm idle.
export function leaseNextFrame(workerId) {
  // The asking worker has just said what it offers, so this is the freshest
  // the registry ever is.
  parkUnrenderable();

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
    failJob(jobId, `The first ${counts.failed} ${isTiled(job) ? 'tiles' : 'frames'} all failed`);
    return;
  }

  if (counts.pending > 0) return;
  if (liveLeases().some(lease => lease.jobId === jobId)) return;

  if (isTiled(job)) return settleTiles(job, counts);

  // A test frame that rendered is not a finished job: the rest of the range is
  // still held, waiting for whoever asked for it to look at the frame.
  if (job.approval === 'testing' && counts.done > 0) {
    job.status = 'pending';
    job.approval = 'waiting';
    job.startedAt = null;
    job.currentFrame = null;
    saveJob(job);
    releaseSlot(jobId);

    console.log(`Job ${jobId} rendered its test frame and is waiting to be approved`);
    return;
  }

  completeJob(jobId, { successfulFrames: counts.done, failedFrames: counts.failed });
}

// Every region has to arrive: a still with one tile missing is not a picture,
// so a tile that runs out of attempts fails the job rather than leaving a hole.
function settleTiles(job, counts) {
  if (counts.failed > 0) {
    failJob(job.id, `${counts.failed} of ${job.tiles} tiles failed to render`);
    return;
  }

  if (job.composite) return;

  console.log(`Job ${job.id}: all ${job.tiles} tiles in, putting them together`);

  startComposite(job.id, error => {
    if (error) failJob(job.id, `The tiles could not be put together: ${error}`);
    else completeJob(job.id, { successfulFrames: counts.done, failedFrames: 0 });
  });
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
    forgetTiming(job.id);
    pruned++;
  }

  return pruned;
}

// The order the queue will actually run in, which is what an estimate is
// measured against.
export function queueWaits() {
  sortQueue();

  return waitsFor(activeJobs(), renderQueue.map(id => jobs.get(id)).filter(Boolean));
}

export function jobsNoWorkerCanRender() {
  const waiting = renderQueue.map(id => jobs.get(id)).filter(Boolean);

  // Queued ones are the ordinary case; a running one was promoted while a
  // machine that could take it was still here.
  return [...activeJobs(), ...waiting]
    .filter(job => !engineIsOffered(job.renderEngine))
    .map(job => ({ id: job.id, renderEngine: job.renderEngine }));
}

export function getQueueStatus() {
  // The queue is only ordered when read from, so an unsorted read would hand
  // back an order it will not run in.
  sortQueue();

  return {
    isRendering: active.size > 0,
    heldForDisk: heldForDisk(),
    activeJobs: activeJobs().map(job => job.id),
    workers: machines(liveLeases().map(({ leasedBy, jobId, frame }) => ({ id: leasedBy, jobId, frame }))),
    queueLength: renderQueue.length,
    totalJobs: jobs.size,
    lastFailure,
    queue: renderQueue.map(id => ({
      id,
      filename: jobs.get(id)?.originalFilename
    }))
  };
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
  forgetTiming(jobId);
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

function completeJob(jobId, { successfulFrames, failedFrames }) {
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
  forgetTiming(jobId);

  console.log(`Job ${jobId} deleted by request`);

  return { success: true, message: 'Job deleted' };
}

// Cleanup deletes by age alone, which would otherwise take the .blend out from
// under a job that has been sitting in the queue for longer than the cutoff.
export { stopWorkers };

