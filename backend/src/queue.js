import fs from 'fs';
import { ensureWorkers, stopWorkers, whenWorkerLost } from './worker-pool.js';
import path from 'path';
import { ensureDir } from './utils/file-utils.js';
import { dataPath } from './paths.js';
import { announce, WORK } from './bus.js';
import {
  saveJob, deleteJob,
  createFrames, getFrames, countFramesByStatus,
  markFrameDone, markFramePending, markFrameAttemptFailed, resetFailedFrames,
  leaseFrames, renewLease, releaseLease, getLease, liveLeases, clearJobLeases,
  recordJobAsset, jobAssets,
  holdFramesExcept, releaseHeldFrames,
  leaseComposite, renewComposite, releaseComposite, getCompositeLease,
  liveComposites, clearJobComposite, releaseLeasesOf, releaseCompositesOf,
  leaseBake, renewBake, releaseBake, getBakeLease, liveBakes, clearJobBake, releaseBakesOf
} from './db.js';
import {
  DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY, primaryOf
} from './formats.js';
import {
  workerCanRender, engineIsOffered, machines, workerCount, touchWorker
} from './worker-registry.js';
import { checkScene } from './preflight.js';
import { queueWaits as waitsFor, forgetTiming, machineFrameMs } from './estimates.js';
import { stampJob, startedJob, shareOf, forgetJob, levelUp } from './fairness.js';
import { jobs, nextJobId, workerScratchDir } from './job-store.js';
import {
  diskIsTooFull, tooFullToCarryOn, heldForDisk, deleteJobFiles, forgetUsage
} from './storage.js';
import { isTiled, tilesPath, compositeName } from './tiles.js';
import { bakedScenePath, fluidCachePath } from './baking.js';
import { assetsDir, writeManifest } from './supplied-assets.js';

const MAX_FRAME_ATTEMPTS = 3;
const MAX_INTERRUPTIONS = 2;

const renderQueue = [];
const active = new Set();

const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS) || 30 * 1000;
const SPAN_MS = Number(process.env.FRAME_SPAN_MS) || 60 * 1000;
const MAX_SPAN = Number(process.env.MAX_FRAME_SPAN) || 16;

const FAILFAST_FRAMES = 3;

const DRAIN_POLL_MS = 500;

let lastFailure = null;

function reconcileFrames(job) {
  if (getFrames(job.id).length === 0 && Number.isInteger(job.frameStart)) {
    if (isTiled(job)) createFrames(job.id, 1, job.tiles);
    else createFrames(job.id, job.frameStart, job.frameEnd, job.frameStep);
  }

  let done = 0;
  const folder = isTiled(job) ? tilesPath(job.outputFolder) : job.outputFolder;

  for (const frame of getFrames(job.id)) {
    if (frame.status !== 'done') continue;

    const present = job.outputFolder
      && frame.filename
      && fs.existsSync(dataPath(folder, frame.filename));

    if (present) done++;
    else markFramePending(job.id, frame.frame);
  }

  return done;
}

export function resumeInterruptedJobs() {
  let resumed = 0;
  let abandoned = 0;

  for (const job of jobs.values()) {
    if (job.status !== 'rendering' && job.status !== 'pending') continue;
    if (job.approval === 'waiting') continue;

    const done = reconcileFrames(job);

    forgetTiming(job.id);
    forgetJob(job.id);

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

    enqueue(job.id);
    resumed++;

    if (job.assetCheck === 'checking') startSceneCheck(job);
  }

  if (resumed || abandoned) {
    console.log(`Recovered ${resumed} interrupted job(s), abandoned ${abandoned}`);
  }

  if (resumed) processQueue();
}

function framesIn({ frameStart, frameEnd, frameStep }) {
  return Math.floor((frameEnd - frameStart) / Math.max(1, frameStep ?? 1)) + 1;
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
    frameStep: jobData.frameStep ?? 1,
    renderEngine: jobData.renderEngine || 'CYCLES',
    originalFilename: jobData.originalFilename,
    owner: jobData.owner || 'anonymous',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
    totalFrames: jobData.tiles ?? framesIn(jobData),
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
    allowScripts: jobData.allowScripts ? 1 : 0,
    approval: jobData.testFrame == null ? null : 'testing',
    tiles: jobData.tiles ?? null,
    composite: null,
    needsThisMachine: 0
  };

  if (!jobData.skipAssetCheck) job.assetCheck = 'checking';

  jobs.set(jobId, job);
  if (isTiled(job)) createFrames(jobId, 1, job.tiles);
  else createFrames(jobId, job.frameStart, job.frameEnd, job.frameStep);
  if (job.testFrame != null) holdFramesExcept(jobId, job.testFrame);
  saveJob(job);
  forgetUsage(job.owner);
  enqueue(jobId);

  if (job.allowScripts) {
    console.warn(`Job ${jobId} will run the scripts inside ${job.originalFilename}, `
      + `as ${job.owner} asked`);
  }

  console.log(`Job ${jobId} added to queue. Queue length: ${renderQueue.length}`);

  if (job.assetCheck === 'checking') startSceneCheck(job);
  else if (!preemptFor(job)) processQueue();

  return jobId;
}

function startSceneCheck(job) {
  checkScene(dataPath(job.filePath), writeManifest(job, jobAssets(job.id)), lastFrameOf(job))
    .then(({ checked, missing, unpacked, unbaked, unbakeable, fluids, scriptedDrivers }) => {
    const current = jobs.get(job.id);

    if (!current || current.status !== 'pending') return;

    if (checked && missing.length > 0) {
      current.assetCheck = 'waiting';
      current.missingAssets = JSON.stringify(missing);
      saveJob(current);
      console.log(`Job ${current.id} is waiting for ${missing.length} file(s) it did not bring`);
      return;
    }

    if (checked && scriptedDrivers.length > 0 && !current.allowScripts) {
      const queued = renderQueue.indexOf(current.id);
      if (queued > -1) renderQueue.splice(queued, 1);

      current.assetCheck = 'refused';
      saveJob(current);
      failJob(current.id, needsItsScripts(scriptedDrivers));
      return;
    }

    if (checked && unbakeable.length > 0) {
      const queued = renderQueue.indexOf(current.id);
      if (queued > -1) renderQueue.splice(queued, 1);

      current.assetCheck = 'refused';
      saveJob(current);
      failJob(current.id, cannotBake(unbakeable));

      console.log(`Job ${current.id} has ${unbakeable.length} simulation(s) it cannot bake`);
      return;
    }

    if (checked && unbaked.length > 0) {
      current.bake = 'waiting';
      current.unbakedSims = JSON.stringify(unbaked);
      console.log(`Job ${current.id} has ${unbaked.length} simulation(s) to bake first`);
    }

    if (checked && fluids.length > 0) {
      current.needsThisMachine = 1;
      console.log(`Job ${current.id} keeps ${fluids.length} fluid cache(s) on this machine`);
    }

    if (!current.needsThisMachine) {
      current.needsThisMachine = checked && unpacked.length > 0 ? 1 : 0;
    }
    current.assetCheck = checked ? 'ok' : 'skipped';
    saveJob(current);

    if (current.needsThisMachine) {
      console.log(`Job ${current.id} keeps ${unpacked.length} file(s) only this machine can see`);
    }

    if (!preemptFor(current)) processQueue();

    announce(WORK);
  }).catch(error => {
    console.error(`Job ${job.id}: the scene check failed (${error.message}); rendering anyway`);

    const current = jobs.get(job.id);

    if (current?.status !== 'pending' || current.assetCheck !== 'checking') return;

    current.assetCheck = 'skipped';
    saveJob(current);

    if (!preemptFor(current)) processQueue();
    announce(WORK);
  });
}

export function assetsWanted(job) {
  if (job.assetCheck !== 'waiting') return [];

  try {
    return JSON.parse(job.missingAssets || '[]');
  } catch {
    return [];
  }
}

export function supplyAsset(jobId, storedPath, { filename, bytes }) {
  const job = jobs.get(jobId);

  if (!job) return { error: 'Job not found' };

  const wanted = assetsWanted(job);

  if (wanted.length === 0) return { error: 'This job is not waiting for any files' };
  if (!wanted.some(entry => entry.stored === storedPath)) {
    return { error: 'The job does not reach for that file' };
  }

  recordJobAsset({ jobId, storedPath, filename, bytes });

  const supplied = new Set(jobAssets(jobId).map(asset => asset.storedPath));
  const left = wanted.filter(entry => !supplied.has(entry.stored));

  job.missingAssets = JSON.stringify(left);

  if (left.length === 0) job.assetCheck = 'checking';

  saveJob(job);
  forgetUsage(job.owner);

  console.log(`Job ${jobId} was given ${filename}, ${left.length} file(s) still wanted`);

  if (left.length === 0) startSceneCheck(job);

  return { wanted: left };
}

function sceneOf(job) {
  const at = dataPath(job.bakedPath || job.filePath);

  if (!job.bakedPath) return { blendPath: at, blendVersion: null };

  const made = fs.existsSync(at) ? Math.round(fs.statSync(at).mtimeMs) : 0;

  return { blendPath: at, blendVersion: String(made) };
}

function lastFrameOf(job) {
  return isTiled(job) ? job.frameStart : job.frameEnd;
}

function needsItsScripts(drivers) {
  const shown = drivers.slice(0, 3).join(', ');
  const rest = drivers.length > 3 ? `, and ${drivers.length - 3} more` : '';

  return `${drivers.length} driver(s) in this scene are worked out by Python the file `
    + `carries, and the farm does not run a file's own scripts unless it is told to `
    + `(${shown}${rest}). Upload it again with "Run this file's own scripts" ticked.`;
}

function cannotBake(entries) {
  const named = why => entries.filter(entry => entry.why === why).map(entry => entry.name);

  const said = [];
  const linked = named('linked');
  const hidden = named('hidden');

  if (linked.length > 0) {
    said.push(`${linked.join(', ')} ${linked.length === 1 ? 'is' : 'are'} linked from another `
      + 'file, and a cache cannot be baked into a scene that only links it. Bake it where it '
      + 'lives, save that file, and upload again.');
  }

  if (hidden.length > 0) {
    said.push(`${hidden.join(', ')} ${hidden.length === 1 ? 'is' : 'are'} switched off in the `
      + 'viewport, and Blender bakes nothing for an object switched off there. Turn the '
      + 'monitor icon back on, save, and upload again.');
  }

  return said.join(' ');
}

export function bakingSimulations(job) {
  if (job.bake !== 'waiting') return [];

  try {
    return JSON.parse(job.unbakedSims || '[]');
  } catch {
    return [];
  }
}

function preemptFor(job) {
  // Never pause a running job for one that cannot start.
  if (!readyToStart(job)) return false;

  const displaceable = activeJobs().filter(running => displaces(job, running));

  if (displaceable.length === 0) return false;

  const running = displaceable[displaceable.length - 1];

  console.log(`Job ${running.id} paused for job ${job.id}`);

  pushBack(running, job.owner);

  return true;
}

function pushBack(running, by) {
  running.status = 'pending';
  running.startedAt = null;
  running.currentFrame = null;
  running.pausedBy = by;
  running.framesAtResume = countFramesByStatus(running.id).done;
  saveJob(running);

  enqueue(running.id);

  whenWorkersLetGo(running.id);
}

export function approveJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) return { success: false, error: 'Job not found' };

  if (job.approval !== 'waiting') {
    return { success: false, error: `Job ${jobId} is not waiting on a test frame` };
  }

  if (job.status !== 'pending') {
    return { success: false, error: `Job ${jobId} is ${job.status}` };
  }

  releaseHeldFrames(jobId);
  announce(WORK);

  job.approval = 'approved';
  job.error = null;
  job.framesAtResume = countFramesByStatus(jobId).done;
  saveJob(job);

  enqueue(jobId);

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

  if (['missing', 'unbaked', 'refused'].includes(job.assetCheck)) {
    return { success: false, error: job.error };
  }

  if (job.bake === 'failed') job.bake = 'waiting';

  if (!job.filePath || !fs.existsSync(dataPath(job.filePath))) {
    return { success: false, error: 'The uploaded .blend is no longer on the workstation' };
  }

  if (job.bakedPath && !fs.existsSync(dataPath(job.bakedPath))) {
    job.bakedPath = null;
    job.bake = 'waiting';
  }

  const delivered = reconcileFrames(job);

  resetFailedFrames(jobId);
  forgetTiming(jobId);
  forgetJob(jobId);
  const retried = countFramesByStatus(jobId).pending;

  const compositeOnly = retried === 0 && isTiled(job) && job.composite === 'failed';

  if (retried === 0 && !compositeOnly) {
    return { success: false, error: 'Every frame rendered; there is nothing to rerun' };
  }

  if (isTiled(job)) job.composite = null;

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

  enqueue(jobId);
  console.log(`Job ${jobId} queued again for ${retried} frame(s)`);

  if (job.assetCheck === 'checking') startSceneCheck(job);

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

function inTheRunning(job) {
  if (job.status === 'rendering') return true;

  return job.status === 'pending' && renderQueue.includes(job.id);
}

function describe(job) {
  return job.approval === 'waiting' ? 'job waiting on its owner' : `${job.status} job`;
}

function readyToStart(job) {
  return job?.status === 'pending'
    && renderQueue.includes(job.id)
    && !active.has(job.id)
    && job.assetCheck !== 'checking'
    && job.assetCheck !== 'waiting'
    && !job.heldBy
    && engineIsOffered(job.renderEngine);
}

export function holdJob(jobId, by) {
  const job = jobs.get(jobId);

  if (!job) return { success: false, error: 'Job not found' };

  if (!inTheRunning(job)) {
    return { success: false, error: `Cannot hold a ${describe(job)}` };
  }

  if (job.heldBy) return { success: false, error: 'Job is already held' };

  job.heldBy = by;

  if (job.status === 'rendering') pushBack(job, by);
  else saveJob(job);

  console.log(`Job ${jobId} held by ${by}`);

  return { success: true, jobId, heldBy: by };
}

export function releaseJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) return { success: false, error: 'Job not found' };
  if (!inTheRunning(job)) return { success: false, error: `Cannot release a ${describe(job)}` };
  if (!job.heldBy) return { success: false, error: 'Job is not held' };

  job.heldBy = null;
  job.pausedBy = null;
  saveJob(job);

  if (!renderQueue.includes(jobId)) enqueue(jobId);

  processQueue();

  console.log(`Job ${jobId} released`);

  return { success: true, jobId };
}

export function pinJob(jobId, pinned) {
  const job = jobs.get(jobId);

  if (!job) return { success: false, error: 'Job not found' };

  if (!inTheRunning(job)) {
    return { success: false, error: `Cannot pin a ${describe(job)}` };
  }

  job.pinnedAt = pinned ? new Date().toISOString() : null;

  if (pinned && job.heldBy) {
    job.heldBy = null;
    job.pausedBy = null;
  }

  saveJob(job);

  if (pinned && !renderQueue.includes(jobId) && job.status !== 'rendering') enqueue(jobId);

  if (pinned && !preemptFor(job)) processQueue();
  else sortQueue();

  console.log(pinned ? `Job ${jobId} pinned to the front` : `Job ${jobId} unpinned`);

  return { success: true, jobId, pinnedAt: job.pinnedAt };
}

function enqueue(jobId) {
  const job = jobs.get(jobId);

  if (job) stampJob(job);

  renderQueue.push(jobId);
  announce(WORK);
}

function byRank(a, b) {
  const pins = (a?.pinnedAt ?? '') === (b?.pinnedAt ?? '')
    ? 0
    : !a?.pinnedAt ? 1 : !b?.pinnedAt ? -1 : (a.pinnedAt < b.pinnedAt ? -1 : 1);

  return pins
    || (b?.priority ?? 0) - (a?.priority ?? 0)
    || shareOf(a?.id) - shareOf(b?.id)
    || (a?.id ?? 0) - (b?.id ?? 0);
}

function sortQueue() {
  renderQueue.sort((a, b) => byRank(jobs.get(a), jobs.get(b)));
}

function activeJobs() {
  return [...active]
    .map(jobId => jobs.get(jobId))
    .filter(job => job?.status === 'rendering')
    .sort(byRank);
}

function displaces(job, running) {
  if (job.pinnedAt || running.pinnedAt) {
    if (!running.pinnedAt) return true;
    if (!job.pinnedAt) return false;
    return job.pinnedAt < running.pinnedAt;
  }

  return (running.priority ?? 0) < (job.priority ?? 0);
}

function promoteNext() {
  if (renderQueue.length === 0 || diskIsTooFull(processQueue)) return null;

  sortQueue();

  const next = renderQueue.findIndex(id => readyToStart(jobs.get(id)));

  if (next === -1) return null;

  const [jobId] = renderQueue.splice(next, 1);
  const job = jobs.get(jobId);

  if (!job) {
    console.error(`Job ${jobId} not found in storage`);
    return promoteNext();
  }

  clearJobLeases(jobId);
  clearJobComposite(jobId);
  clearJobBake(jobId);

  job.status = 'rendering';
  job.startedAt = new Date().toISOString();
  job.pausedBy = null;
  saveJob(job);
  active.add(jobId);
  startedJob(jobId);

  console.log(`Job ${jobId} is now being rendered`);
  ensureWorkers();
  announce(WORK);

  return job;
}

function processQueue() {
  if (active.size > 0) return;

  if (renderQueue.length === 0) {
    console.log('Queue is empty');
    levelUp();
    return;
  }

  promoteNext();
}

const drainTimers = new Map();

function stillClaimed(jobId) {
  return liveLeases().some(lease => lease.jobId === jobId)
    || liveComposites().some(claim => claim.jobId === jobId)
    || liveBakes().some(claim => claim.jobId === jobId);
}

function whenWorkersLetGo(jobId) {
  if (drainTimers.has(jobId)) return;

  const check = () => {
    if (stillClaimed(jobId)) {
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

function spanFor(job, workerId) {
  if (isTiled(job)) return 1;

  const perFrame = machineFrameMs(job.id, workerId);

  if (!perFrame) return 1;

  const left = Math.max(1, (job.totalFrames ?? 1) - (job.completedFrames ?? 0));
  const share = Math.ceil(left / Math.max(workerCount(), 1));

  return Math.max(1, Math.min(Math.floor(SPAN_MS / perFrame), share, MAX_SPAN));
}

function bakeFromActive(workerId, local) {
  for (const job of activeJobs()) {
    if (job.bake !== 'waiting') continue;
    if (job.needsThisMachine && !local) continue;

    const lease = leaseBake(job.id, workerId, LEASE_TTL_MS);

    if (!lease) continue;

    return {
      ...lease,
      ttlMs: LEASE_TTL_MS,
      blendPath: dataPath(job.filePath),
      renderEngine: job.renderEngine,
      bake: {
        allowScripts: job.allowScripts,
        last: lastFrameOf(job),
        path: dataPath(bakedScenePath(job)),
        caches: dataPath(fluidCachePath(job)),
        simulations: bakingSimulations(job)
      }
    };
  }

  return null;
}

function compositeFromActive(workerId) {
  for (const job of activeJobs()) {
    if (!isTiled(job) || job.composite !== 'waiting') continue;
    if (!workerCanRender(workerId, job.renderEngine)) continue;

    const lease = leaseComposite(job.id, workerId, LEASE_TTL_MS);

    if (!lease) continue;

    return {
      ...lease,
      ttlMs: LEASE_TTL_MS,
      renderEngine: job.renderEngine,
      ...sceneOf(job),
      tilesDir: dataPath(tilesPath(job.outputFolder)),
      composite: {
        allowScripts: job.allowScripts,
        tiles: job.tiles,
        format: primaryOf(job.formats),
        resolutionPercent: job.resolutionPercent,
        name: compositeName(job)
      }
    };
  }

  return null;
}

function leaseFromActive(workerId, local) {
  for (const job of activeJobs()) {
    if (!workerCanRender(workerId, job.renderEngine)) continue;

    if (job.bake === 'waiting') continue;

    if (job.needsThisMachine && !local) continue;

    const lease = leaseFrames(job.id, workerId, LEASE_TTL_MS, spanFor(job, workerId));

    if (lease) {
      return {
        ...lease,
        ttlMs: LEASE_TTL_MS,
        ...sceneOf(job),
        assets: jobAssets(job.id).map(asset => ({
          stored: asset.storedPath,
          filename: asset.filename,
          path: path.join(assetsDir(job), asset.filename)
        })),
        outputDir: workerScratchDir(job.id),
        renderEngine: job.renderEngine,
      allowScripts: job.allowScripts,
        formats: job.formats,
        resolutionPercent: job.resolutionPercent,
        samples: job.samples,
        exrCodec: job.exrCodec,
        exrDepth: job.exrDepth,
        jpegQuality: job.jpegQuality,
        sceneFrame: isTiled(job) ? job.frameStart : null,
        tile: isTiled(job) ? { index: lease.frames[0], of: job.tiles } : null
      };
    }
  }

  return null;
}

function parkUnrenderable() {
  for (const jobId of [...active]) {
    const job = jobs.get(jobId);

    if (!job || job.status !== 'rendering') continue;
    if (engineIsOffered(job.renderEngine)) continue;
    if (stillClaimed(jobId)) continue;

    job.status = 'pending';
    job.startedAt = null;
    job.currentFrame = null;
    saveJob(job);

    enqueue(jobId);
    releaseSlot(jobId);

    console.log(`Job ${jobId} put back: no worker here renders ${job.renderEngine}`);
  }
}

export function leaseNextFrame(workerId, local = false) {
  parkUnrenderable();

  for (;;) {
    const lease = bakeFromActive(workerId, local)
      ?? compositeFromActive(workerId)
      ?? leaseFromActive(workerId, local);

    if (lease) return lease;
    if (!promoteNext()) break;
  }

  for (const jobId of [...active]) settleJob(jobId);

  return compositeFromActive(workerId);
}

export function renewFrameLease(leaseId) {
  const lease = getLease(leaseId) ?? getCompositeLease(leaseId) ?? getBakeLease(leaseId);

  if (!lease) return { ok: false, reason: 'unknown' };

  const job = jobs.get(lease.jobId);

  if (!job || job.status !== 'rendering') return { ok: false, reason: 'stopped' };

  const expiresAt = lease.frames
    ? renewLease(leaseId, LEASE_TTL_MS)
    : renewComposite(leaseId, LEASE_TTL_MS) ?? renewBake(leaseId, LEASE_TTL_MS);

  if (expiresAt) touchWorker(lease.leasedBy);

  return expiresAt ? { ok: true, expiresAt } : { ok: false, reason: 'expired' };
}

export function forgetWorker(workerId) {
  const touched = new Set([
    ...releaseLeasesOf(workerId), ...releaseCompositesOf(workerId), ...releaseBakesOf(workerId)
  ]);

  if (touched.size === 0) return 0;

  console.warn(`Worker ${workerId} is gone; ${touched.size} job(s) had claims of its`);

  for (const jobId of touched) settleJob(jobId);

  announce(WORK);

  return touched.size;
}

whenWorkerLost(forgetWorker);

export function releaseFrameLease(leaseId) {
  const lease = getLease(leaseId) ?? getCompositeLease(leaseId) ?? getBakeLease(leaseId);

  if (!lease) return false;

  if (lease.frames) releaseLease(leaseId);
  else if (!releaseComposite(leaseId)) releaseBake(leaseId);

  settleJob(lease.jobId);
  announce(WORK);

  return true;
}

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
  if (stillClaimed(jobId)) return;

  if (isTiled(job)) return settleTiles(job, counts);

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

function settleTiles(job, counts) {
  if (counts.failed > 0) {
    failJob(job.id, `${counts.failed} of ${job.tiles} tiles failed to render`);
    return;
  }

  if (job.composite) return;

  job.composite = 'waiting';
  saveJob(job);

  console.log(`Job ${job.id}: all ${job.tiles} tiles in, waiting to be put together`);
}

export function recordBake(jobId, error) {
  const job = jobs.get(jobId);

  if (!job || job.status !== 'rendering') return null;

  clearJobBake(jobId);

  if (error) {
    job.bake = 'failed';
    saveJob(job);
    failJob(jobId, `The scene's simulations could not be baked: ${error}`);

    return job;
  }

  job.bake = 'done';
  job.bakedPath = bakedScenePath(job);
  saveJob(job);
  forgetUsage(job.owner);

  console.log(`Job ${jobId}: simulations baked, ${job.totalFrames} frame(s) can go out`);
  announce(WORK);

  return job;
}

export function recordComposite(jobId, error) {
  const job = jobs.get(jobId);

  if (!job || job.status !== 'rendering') return null;

  job.composite = error ? 'failed' : 'ready';
  saveJob(job);

  if (error) {
    console.error(`Job ${jobId}: could not put the tiles together: ${error}`);
    failJob(jobId, `The tiles could not be put together: ${error}`);
  } else {
    forgetUsage(job.owner);
    console.log(`Job ${jobId}: tiles put together`);
    completeJob(jobId, {
      successfulFrames: countFramesByStatus(jobId).done,
      failedFrames: 0
    });
  }

  return job;
}

function jobFilesExist(job) {
  return !!(job.filePath && fs.existsSync(dataPath(job.filePath)))
    || !!(job.outputFolder && fs.existsSync(dataPath(job.outputFolder)));
}

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
    forgetJob(job.id);
    pruned++;
  }

  return pruned;
}

export function queueWaits() {
  sortQueue();

  return waitsFor(activeJobs(),
    renderQueue.map(id => jobs.get(id)).filter(job => job && !job.heldBy));
}

export function jobsNoWorkerCanRender() {
  const waiting = renderQueue.map(id => jobs.get(id)).filter(Boolean);

  return [...activeJobs(), ...waiting]
    .filter(job => !engineIsOffered(job.renderEngine))
    .map(job => ({ id: job.id, renderEngine: job.renderEngine }));
}

export function getQueueStatus() {
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

function syncFrameCounts(job) {
  const counts = countFramesByStatus(job.id);

  job.completedFrames = counts.done;
  job.failedFrames = counts.failed;
  job.progress = job.totalFrames > 0
    ? Math.max(0, Math.min(100, Math.round((counts.done / job.totalFrames) * 100)))
    : 0;

  return counts;
}

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
  forgetJob(jobId);
  job.currentFrame = frameNumber;
  syncFrameCounts(job);
  saveJob(job);

  if (tooFullToCarryOn()) holdForDisk(job);

  return job;
}

function holdForDisk(job) {
  console.warn(`Job ${job.id} put back: the disk is down to its reserve`);

  pushBack(job, null);
  diskIsTooFull(processQueue);
}

export function recordFrameFailure(jobId, frameNumber, error) {
  const job = renderingJob(jobId);
  if (!job) return null;

  const frame = markFrameAttemptFailed(jobId, frameNumber, error, MAX_FRAME_ATTEMPTS);
  syncFrameCounts(job);
  saveJob(job);

  settleJob(jobId);

  if (frame?.status === 'pending') announce(WORK);

  return { job, frame };
}

function completeJob(jobId, { successfulFrames, failedFrames }) {
  const job = jobs.get(jobId);
  if (!job) return null;

  if (job.status === 'cancelled') {
    console.log(`Ignoring completion for cancelled job ${jobId}`);
    return job;
  }

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
  forgetJob(jobId);

  console.log(`Job ${jobId} deleted by request`);

  return { success: true, message: 'Job deleted' };
}

export { stopWorkers };

