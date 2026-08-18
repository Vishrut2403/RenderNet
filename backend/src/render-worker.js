import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { findBlenderExecutable } from './utils/blender-check.js';

const BLENDER_PATH = process.env.BLENDER_PATH || findBlenderExecutable() || 'blender';
const API_URL = process.env.API_URL || 'http://localhost:5500';
const WORKER_BASE = `${API_URL}/api/worker`;
// CPU, OPTIX, CUDA, HIP, ONEAPI or METAL. Cycles only.
const CYCLES_DEVICE = process.env.CYCLES_DEVICE || 'CPU';
const OUTPUT_TAIL = 4000;
const KILL_GRACE_MS = 5000;
const FAILFAST_FRAMES = 3;
// The server decides when a frame has had enough attempts; this only stops a
// misbehaving one from looping the worker forever.
const ATTEMPT_CEILING = 10;

// Read lazily: the server may generate the secret at boot, after this import.
function workerHeaders(extra = {}) {
  return { 'x-worker-secret': process.env.WORKER_SECRET || '', ...extra };
}

class RenderWorker {
  constructor(workerId = 'local-worker') {
    this.workerId = workerId;
    this.currentJob = null;
    this.currentProcess = null;
    this.cancelled = false;
    this.killTimer = null;
  }

  cancel() {
    this.cancelled = true;

    const running = this.currentProcess;
    if (!running) return false;

    running.kill('SIGTERM');

    // The queue holds the slot until this worker stops, so a Blender that
    // ignores SIGTERM would keep the whole queue waiting.
    this.killTimer = setTimeout(() => running.kill('SIGKILL'), KILL_GRACE_MS);
    this.killTimer.unref();

    return true;
  }

  async renderJob(job) {
    const { id, blendPath, outputDir, frames, renderEngine } = job;

    console.log(`\n🎬 Worker ${this.workerId}: Starting job ${id}`);
    console.log(`📁 Blend file: ${blendPath}`);
    console.log(`🎞️  Frames left to render: ${frames.length}`);
    console.log(`⚙️  Engine: ${renderEngine}`);

    this.currentJob = job;

    fs.mkdirSync(outputDir, { recursive: true });

    let successfulFrames = 0;
    let failedFrames = 0;

    for (const [index, frame] of frames.entries()) {
      if (this.cancelled) {
        console.log(`Worker ${this.workerId}: job ${id} cancelled, stopping at frame ${frame}`);
        break;
      }

      console.log(`\n🎬 Rendering frame ${frame} (${index + 1} of ${frames.length})`);

      const outcome = await this.renderFrame(id, frame, blendPath, outputDir, renderEngine);

      if (outcome === 'cancelled') break;

      if (outcome === 'done') {
        successfulFrames++;
        await this.reportProgress(id, frame);
        continue;
      }

      failedFrames++;

      // A scene that cannot render its opening frames will not render the rest
      // either, and on a workstation shared for a few hours that is an evening
      // spent producing nothing.
      if (successfulFrames === 0 && failedFrames >= FAILFAST_FRAMES) {
        console.error(`❌ Job ${id}: first ${failedFrames} frames all failed, abandoning the job`);
        break;
      }
    }

    // Succeeds only when every frame was uploaded and removed.
    try {
      fs.rmdirSync(outputDir);
    } catch {
      console.warn(`⚠️  Scratch dir retained (unuploaded frames): ${outputDir}`);
    }

    if (this.cancelled) {
      console.log(`Job ${id} stopped after cancellation`);
      this.currentJob = null;
      return { success: false, cancelled: true, successfulFrames, failedFrames };
    }

    console.log(`\n🎉 Job ${id} completed!`);
    console.log(`✅ Successful: ${successfulFrames} frames`);
    console.log(`❌ Failed: ${failedFrames} frames`);

    await this.reportJobComplete(id, successfulFrames, failedFrames);
    
    this.currentJob = null;
    
    return {
      success: failedFrames === 0,
      successfulFrames,
      failedFrames
    };
  }

  // Retries are driven by the server's answer rather than a local count, so
  // there is one place that decides when a frame has had enough attempts.
  async renderFrame(jobId, frame, blendPath, outputDir, renderEngine) {
    for (let attempt = 1; attempt <= ATTEMPT_CEILING; attempt++) {
      if (this.cancelled) return 'cancelled';

      try {
        const framePath = await this.renderSingleFrame(blendPath, frame, outputDir, renderEngine);
        console.log(`✅ Frame ${frame} rendered: ${framePath}`);

        if (await this.uploadFrame(jobId, frame, framePath)) {
          console.log(`📤 Frame ${frame} uploaded successfully`);
          fs.rmSync(framePath, { force: true });
          return 'done';
        }

        // Rendered but undelivered is still a frame the user cannot download.
        console.warn(`⚠️  Frame ${frame} upload failed, keeping local copy`);

        if (!await this.reportFrameFailure(jobId, frame, 'Frame rendered but upload failed')) {
          return 'failed';
        }
      } catch (error) {
        // A frame killed by cancellation is not a render failure.
        if (this.cancelled) return 'cancelled';

        console.error(`❌ Frame ${frame} failed:`, error.message);

        if (!await this.reportFrameFailure(jobId, frame, error.message)) return 'failed';
      }

      console.log(`↻ Retrying frame ${frame}`);
    }

    return 'failed';
  }

  renderSingleFrame(blendPath, frame, outputDir, renderEngine) {
    return new Promise((resolve, reject) => {
      // '####' pads the frame number to four digits; a single '#' does not pad
      // at all, so the written and expected names never agree.
      const outputPattern = path.join(outputDir, 'frame_####');
      const expectedFile = path.join(
        outputDir,
        `frame_${frame.toString().padStart(4, '0')}.png`
      );

      const args = [
        '-b', blendPath,
        '-E', renderEngine,
        // Forced so the extension is predictable whatever the .blend specifies.
        '-F', 'PNG',
        '-o', outputPattern,
        '-f', frame.toString()
      ];

      if (renderEngine === 'CYCLES') {
        // Add-on options are only recognised after '--'; earlier, Blender
        // treats them as a file to open.
        args.push('--', '--cycles-device', CYCLES_DEVICE);
      }

      console.log(`   Running: ${BLENDER_PATH} ${args.join(' ')}`);

      const blender = spawn(BLENDER_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.currentProcess = blender;

      let stdout = '';
      let stderr = '';

      // Both pipes have to be drained. An unread one fills its buffer and
      // blocks Blender mid-write, and nothing here would ever time out.
      blender.stdout.on('data', (data) => {
        stdout = (stdout + data).slice(-OUTPUT_TAIL);
      });

      blender.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-OUTPUT_TAIL);
      });

      blender.on('close', (code, signal) => {
        this.currentProcess = null;
        clearTimeout(this.killTimer);

        if (signal) {
          reject(new Error(`Blender terminated by signal ${signal}`));
          return;
        }

        if (code !== 0) {
          // Blender reports most failures on stdout, not stderr.
          const detail = (stderr.trim() || stdout.trim()).slice(-500);
          reject(new Error(`Blender exited with code ${code}: ${detail}`));
          return;
        }

        if (fs.existsSync(expectedFile)) {
          resolve(expectedFile);
        } else {
          reject(new Error(`Rendered frame not found: ${expectedFile}`));
        }
      });

      blender.on('error', (err) => {
        this.currentProcess = null;
        clearTimeout(this.killTimer);
        reject(new Error(`Failed to start Blender: ${err.message}`));
      });
    });
  }

  async uploadFrame(jobId, frameNumber, framePath) {
    try {
      const formData = new FormData();
      formData.append('frame', fs.createReadStream(framePath));

      const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/frames/${frameNumber}`, {
        method: 'POST',
        body: formData,
        headers: workerHeaders(formData.getHeaders())
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`Upload failed: ${error}`);
        return false;
      }
      
      return true;
      
    } catch (error) {
      console.error(`Upload error: ${error.message}`);
      return false;
    }
  }

  async reportProgress(jobId, currentFrame) {
    try {
      await fetch(`${WORKER_BASE}/jobs/${jobId}/progress`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ currentFrame })
      });
    } catch (error) {
      console.error(`Failed to report progress: ${error.message}`);
    }
  }

  // Resolves to whether the frame still has attempts left.
  async reportFrameFailure(jobId, frameNumber, error) {
    try {
      const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/frames/${frameNumber}/failed`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ error })
      });

      const body = await response.json().catch(() => ({}));

      return body.retry === true;
    } catch (err) {
      // Retrying against a server we cannot reach would just spin.
      console.error(`Failed to report frame failure: ${err.message}`);
      return false;
    }
  }
  
  async reportJobComplete(jobId, successfulFrames, failedFrames) {
    try {
      await fetch(`${WORKER_BASE}/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ successfulFrames, failedFrames })
      });
    } catch (error) {
      console.error(`Failed to report job completion: ${error.message}`);
    }
  }
}

export default RenderWorker;