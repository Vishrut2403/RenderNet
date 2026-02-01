import fs from 'fs';
import { execFile } from 'child_process';
import { renderJob } from './render-worker.js';
const jobs = new Map();
const renderQueue = [];
let isRendering = false;
let currentJobId = null;
let currentBlenderProcess = null;

export function addToQueue(jobData) {
  const jobId = Date.now();
  
  const job = {
    id: jobId,
    status: 'pending',
    filePath: jobData.filePath,
    outputPath: jobData.outputPath,
    outputFolder: jobData.outputFolder,
    frameStart: jobData.frameStart,
    frameEnd: jobData.frameEnd,
    renderEngine: jobData.renderEngine || 'CYCLES',
    originalFilename: jobData.originalFilename,
    owner: jobData.owner || 'anonymous',  
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null
  };
  
  jobs.set(jobId, job);
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
  isRendering = true;
  currentJobId = jobId;
  
  console.log(`Starting render for job ${jobId}`);

  renderJob(
    {
      filePath: job.filePath,
      outputPath: job.outputPath,
      frameStart: job.frameStart,
      frameEnd: job.frameEnd,
      renderEngine: job.renderEngine
    },
    (error, result) => {
      if (error) {
        job.status = 'failed';
        job.error = error.message;
        console.error(`Job ${jobId} failed: ${error.message}`);
      } else {
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        console.log(`Job ${jobId} completed successfully`);
      }
      isRendering = false;
      currentJobId = null;
      currentBlenderProcess = null;
      
      setTimeout(processQueue, 1000);
    },
    (process) => {
      currentBlenderProcess = process;
    }
  );
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
    
    deleteJobFiles(job);
    
    console.log(`Job ${jobId} cancelled (was pending)`);
    return { success: true, message: 'Job cancelled successfully' };
  }
  
  if (job.status === 'rendering') {
    if (currentBlenderProcess && currentJobId === jobId) {
      try {
        currentBlenderProcess.kill('SIGTERM');
        console.log(`Killed Blender process for job ${jobId}`);
      } catch (error) {
        console.error(`Failed to kill process:`, error.message);
      }
      
      currentBlenderProcess = null;
    }
    
    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
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