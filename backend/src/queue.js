import fs from 'fs';
import path from 'path';
import RenderWorker from './render-worker.js';
import { ensureDir } from './utils/file-utils.js';
import { saveJob, loadJobs, deleteJob } from './db.js';

const jobs = new Map();
const renderQueue = [];
let isRendering = false;
let currentJobId = null;
let currentWorker = null;

// Separate from 'renders' so a worker never streams a frame out of the same
// file the upload route is writing into.
const WORKER_SCRATCH = 'worker-tmp';

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

// A job left mid-render by a restart has no worker behind it any more. Reset it
// and queue it again, giving up after repeated interruptions so a job that
// crashes the server cannot loop forever.
export function resumeInterruptedJobs() {
  let resumed = 0;
  let abandoned = 0;

  for (const job of jobs.values()) {
    if (job.status !== 'rendering' && job.status !== 'pending') continue;

    if (job.status === 'rendering' && ++job.interruptions > 2) {
      job.status = 'failed';
      job.error = 'Abandoned after repeated server restarts';
      job.completedAt = new Date().toISOString();
      abandoned++;
    } else {
      Object.assign(job, {
        status: 'pending',
        startedAt: null,
        currentFrame: null,
        progress: 0,
        completedFrames: 0,
        failedFrames: 0,
        uploadedFrames: [],
        frameErrors: []
      });
      renderQueue.push(job.id);
      resumed++;
    }

    saveJob(job);
  }

  if (resumed || abandoned) {
    console.log(`Recovered ${resumed} interrupted job(s), abandoned ${abandoned}`);
  }

  if (resumed) processQueue();
}

export function addToQueue(jobData) {
  const jobId = nextJobId();
  const outputFolder = path.join('renders', `render_${jobId}`);
  ensureDir(outputFolder);

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
    uploadedFrames: [],
    frameErrors: [],
    interruptions: 0
  };

  jobs.set(jobId, job);
  saveJob(job);
  renderQueue.push(jobId);
  
  console.log(`Job ${jobId} added to queue. Queue length: ${renderQueue.length}`);
  
  processQueue();
  
  return jobId;
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
  
  const jobId = renderQueue.shift();
  const job = jobs.get(jobId);
  
  if (!job) {
    console.error(`Job ${jobId} not found in storage`);
    processQueue();
    return;
  }
  
  job.status = 'rendering';
  job.startedAt = new Date().toISOString();
  saveJob(job);
  isRendering = true;
  currentJobId = jobId;
  
  console.log(`Starting render for job ${jobId}`);

  const worker = new RenderWorker('local-worker');
  currentWorker = worker;

  worker
    .renderJob({
      id: jobId,
      blendPath: job.filePath,
      outputDir: path.join(WORKER_SCRATCH, `job_${jobId}`),
      frameStart: job.frameStart,
      frameEnd: job.frameEnd,
      renderEngine: job.renderEngine
    })
    .catch((error) => {
      // Completion normally arrives over HTTP; this only fires if the worker
      // died before reporting, which would otherwise wedge the queue.
      console.error(`Worker crashed on job ${jobId}: ${error.message}`);
      failJob(jobId, error.message);
    });
}

function failJob(jobId, message) {
  const job = jobs.get(jobId);

  if (job && job.status === 'rendering') {
    job.status = 'failed';
    job.error = message;
    job.completedAt = new Date().toISOString();
    saveJob(job);
  }

  if (currentJobId === jobId) {
    isRendering = false;
    currentJobId = null;
    currentWorker = null;
    setTimeout(processQueue, 1000);
  }
}

export function pruneOldJobs(cutoffMs) {
  let pruned = 0;

  for (const job of jobs.values()) {
    if (job.status === 'pending' || job.status === 'rendering') continue;
    if (new Date(job.createdAt).getTime() >= cutoffMs) continue;

    jobs.delete(job.id);
    deleteJob(job.id);
    pruned++;
  }

  return pruned;
}

export function getJob(jobId) {
  return jobs.get(jobId);
}

export function getAllJobs() {
  return Array.from(jobs.values());
}

export function getQueueStatus() {
  return {
    isRendering,
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

export function getQueuePosition(jobId) {
  const index = renderQueue.indexOf(jobId);
  return index === -1 ? null : index + 1;
}

function computeProgress(job, currentFrame) {
  const done = currentFrame - job.frameStart + 1;
  return Math.max(0, Math.min(100, Math.round((done / job.totalFrames) * 100)));
}

export function updateJobProgress(jobId, currentFrame) {
  const job = jobs.get(jobId);
  if (!job) return null;

  job.currentFrame = currentFrame;
  job.progress = computeProgress(job, currentFrame);
  saveJob(job);

  return job;
}

export function recordFrameUpload(jobId, frameNumber, filename) {
  const job = jobs.get(jobId);
  if (!job) return null;

  if (!job.uploadedFrames.includes(filename)) {
    job.uploadedFrames.push(filename);
  }
  job.completedFrames = job.uploadedFrames.length;
  job.currentFrame = frameNumber;
  job.progress = computeProgress(job, frameNumber);
  saveJob(job);

  return job;
}

export function recordFrameFailure(jobId, frameNumber, error) {
  const job = jobs.get(jobId);
  if (!job) return null;

  job.frameErrors.push({
    frame: frameNumber,
    error,
    at: new Date().toISOString()
  });
  job.failedFrames = job.frameErrors.length;
  saveJob(job);

  return job;
}

export function completeJob(jobId, { successfulFrames, failedFrames }) {
  const job = jobs.get(jobId);
  if (!job) return null;

  // A late callback must not resurrect a job cancelled mid-render.
  if (job.status === 'cancelled') {
    console.log(`Ignoring completion for cancelled job ${jobId}`);
    return job;
  }

  job.completedFrames = successfulFrames;
  job.failedFrames = failedFrames;
  job.completedAt = new Date().toISOString();
  job.currentFrame = null;

  if (failedFrames > 0 && successfulFrames === 0) {
    job.status = 'failed';
    job.error = `All ${failedFrames} frame(s) failed to render`;
  } else {
    job.status = 'completed';
    job.progress = 100;
  }

  saveJob(job);
  console.log(`Job ${jobId} finished: ${job.status} (${successfulFrames} ok, ${failedFrames} failed)`);

  if (currentJobId === jobId) {
    isRendering = false;
    currentJobId = null;
    currentWorker = null;
    setTimeout(processQueue, 1000);
  }

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

    deleteJobFiles(job);

    console.log(`Job ${jobId} cancelled (was pending)`);
    return { success: true, message: 'Job cancelled successfully' };
  }
  
  if (job.status === 'rendering') {
    if (currentWorker && currentJobId === jobId) {
      try {
        const killed = currentWorker.cancel();
        console.log(
          killed
            ? `Killed Blender process for job ${jobId}`
            : `Job ${jobId} will stop before its next frame`
        );
      } catch (error) {
        console.error(`Failed to cancel worker:`, error.message);
      }

      currentWorker = null;
    }

    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
    saveJob(job);
    isRendering = false;
    currentJobId = null;

    deleteJobFiles(job);
    
    console.log(`Job ${jobId} cancelled (was rendering)`);
    
    setTimeout(processQueue, 1000);
    
    return { success: true, message: 'Job cancelled successfully' };
  }
  
  return { success: false, error: 'Job cannot be cancelled' };
}

function deleteJobFiles(job) {
  try {
    if (job.filePath && fs.existsSync(job.filePath)) {
      fs.unlinkSync(job.filePath);
      console.log(`Deleted upload: ${job.filePath}`);
    }
    
    if (job.outputFolder && fs.existsSync(job.outputFolder)) {
      fs.rmSync(job.outputFolder, { recursive: true, force: true });
      console.log(`Deleted renders: ${job.outputFolder}`);
    }
  } catch (error) {
    console.error(`Error deleting files:`, error.message);
  }
}