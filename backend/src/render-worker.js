import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { findBlenderExecutable } from './utils/blender-check.js';
import { launch, terminate } from './utils/process-control.js';
import { primaryOf, extrasOf, extensionOf } from './formats.js';

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

// Blender writes one format per render. Saving the others from the finished
// Render Result costs nothing extra, where rendering again would cost the whole
// frame. A file rather than --python-expr: this needs real statements, and a
// command line cannot carry newlines through cmd.exe on Windows.
const EXTRAS_SCRIPT = `import bpy, os

FORMATS = [pair.split(':') for pair in os.environ.get('RENDERNET_EXTRA_FORMATS', '').split(',') if pair]


def save_extras(scene, _depsgraph=None):
    result = bpy.data.images.get('Render Result')

    if result is None:
        return

    base = os.environ['RENDERNET_FRAME_BASE']
    settings = scene.render.image_settings
    original = settings.file_format

    try:
        for name, extension in FORMATS:
            settings.file_format = name
            result.save_render(base + extension, scene=scene)
    finally:
        # Blender has already written the primary by now, but the setting is
        # part of the scene and the next frame reuses it.
        settings.file_format = original


bpy.app.handlers.render_post.append(save_extras)
`;

// Applied to the scene after it loads and before the render is triggered.
// Returns nothing when there is nothing to change, so the ordinary case keeps
// the command line it has always had.
function sceneOverrides(renderEngine, { resolutionPercent, samples } = {}) {
  const assignments = [];

  if (Number.isInteger(resolutionPercent) && resolutionPercent !== 100) {
    assignments.push(`s.render.resolution_percentage=${resolutionPercent}`);
  }

  if (renderEngine === 'CYCLES' && Number.isInteger(samples)) {
    assignments.push(`s.cycles.samples=${samples}`);
  }

  if (assignments.length === 0) return null;

  return `import bpy; s=bpy.context.scene; ${assignments.join('; ')}`;
}

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

    // The queue holds the slot until this worker stops, so a Blender that
    // ignores the stop request would keep the whole queue waiting.
    if (terminate(running)) {
      this.killTimer = setTimeout(() => running.kill('SIGKILL'), KILL_GRACE_MS);
      this.killTimer.unref();
    }

    return true;
  }

  async renderJob(job) {
    const { id, blendPath, outputDir, frames, renderEngine } = job;
    const overrides = { resolutionPercent: job.resolutionPercent, samples: job.samples };
    const primary = primaryOf(job.formats);
    const extras = extrasOf(job.formats);

    console.log(`\n🎬 Worker ${this.workerId}: Starting job ${id}`);
    console.log(`📁 Blend file: ${blendPath}`);
    console.log(`🎞️  Frames left to render: ${frames.length}`);
    console.log(`⚙️  Engine: ${renderEngine}`);

    this.currentJob = job;

    fs.mkdirSync(outputDir, { recursive: true });

    const extrasScript = extras.length > 0 ? path.join(outputDir, 'save-extras.py') : null;
    if (extrasScript) fs.writeFileSync(extrasScript, EXTRAS_SCRIPT);

    let successfulFrames = 0;
    let failedFrames = 0;

    for (const [index, frame] of frames.entries()) {
      if (this.cancelled) {
        console.log(`Worker ${this.workerId}: job ${id} cancelled, stopping at frame ${frame}`);
        break;
      }

      console.log(`\n🎬 Rendering frame ${frame} (${index + 1} of ${frames.length})`);

      const outcome = await this.renderFrame(id, frame, blendPath, outputDir, renderEngine, overrides,
        { primary, extras, extrasScript });

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

    if (extrasScript) fs.rmSync(extrasScript, { force: true });

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
  async renderFrame(jobId, frame, blendPath, outputDir, renderEngine, overrides, output) {
    for (let attempt = 1; attempt <= ATTEMPT_CEILING; attempt++) {
      if (this.cancelled) return 'cancelled';

      try {
        const produced = await this.renderSingleFrame(blendPath, frame, outputDir, renderEngine, overrides, output);
        console.log(`✅ Frame ${frame} rendered: ${produced.join(', ')}`);

        // Every format has to arrive, or the ZIP would be missing one for this
        // frame alone. Delivered first so the frame counts as done as early as
        // possible; the rest follow.
        const delivered = [];
        for (const file of produced) {
          if (!await this.uploadFrame(jobId, frame, file)) break;
          delivered.push(file);
        }

        if (delivered.length === produced.length) {
          console.log(`📤 Frame ${frame} uploaded successfully`);
          for (const file of produced) fs.rmSync(file, { force: true });
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

  renderSingleFrame(blendPath, frame, outputDir, renderEngine, overrides = {}, output = {}) {
    return new Promise((resolve, reject) => {
      // '####' pads the frame number to four digits; a single '#' does not pad
      // at all, so the written and expected names never agree.
      const outputPattern = path.join(outputDir, 'frame_####');
      const { primary = 'PNG', extras = [], extrasScript = null } = output;
      const stem = path.join(outputDir, `frame_${frame.toString().padStart(4, '0')}`);
      const expectedFile = stem + extensionOf(primary);

      const args = [
        '-b', blendPath,
        '-E', renderEngine,
        // Forced so the extension is predictable whatever the .blend specifies.
        '-F', primary,
        '-o', outputPattern
      ];

      // Blender has no flag for resolution or sample count, so they are set on
      // the loaded scene instead. One line with no newlines: on Windows this
      // whole command may travel through cmd.exe, which cannot carry them.
      const expression = sceneOverrides(renderEngine, overrides);
      if (expression) args.push('--python-expr', expression);

      if (extrasScript) args.push('-P', extrasScript);

      // Last, because Blender renders when it reaches this and ignores what
      // follows.
      args.push('-f', frame.toString());

      if (renderEngine === 'CYCLES') {
        // Add-on options are only recognised after '--'; earlier, Blender
        // treats them as a file to open.
        args.push('--', '--cycles-device', CYCLES_DEVICE);
      }

      console.log(`   Running: ${BLENDER_PATH} ${args.join(' ')}`);

      // Passed as environment rather than script arguments: Blender hands its
      // own leftovers to the script and the quoting is one less thing to get
      // wrong on Windows.
      const env = extrasScript
        ? {
            ...process.env,
            RENDERNET_FRAME_BASE: stem,
            RENDERNET_EXTRA_FORMATS: extras.map(id => `${id}:${extensionOf(id)}`).join(',')
          }
        : process.env;

      const blender = launch(BLENDER_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
          const written = [expectedFile];

          for (const id of extras) {
            const extra = stem + extensionOf(id);
            if (fs.existsSync(extra)) written.push(extra);
            else console.warn(`⚠️  Frame ${frame}: Blender wrote no ${id} file`);
          }

          resolve(written);
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
      // Named explicitly rather than left to the stream's path: the extension
      // is how the server knows which format arrived.
      formData.append('frame', fs.createReadStream(framePath), {
        filename: path.basename(framePath)
      });

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