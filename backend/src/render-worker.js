import os from 'os';
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
const RENEW_EVERY_MS = 5000;

const SCRATCH_DIR = process.env.WORKER_SCRATCH_DIR
  || path.join(os.tmpdir(), 'rendernet-worker');

// Blender writes one format per render; the rest are saved from the finished
// Render Result. A file rather than --python-expr because a command line cannot
// carry newlines through cmd.exe on Windows.
const OUTPUT_SCRIPT = `import bpy, os

PRIMARY = os.environ.get('RENDERNET_PRIMARY_FORMAT', '')
EXTRAS = [pair.split(':') for pair in os.environ.get('RENDERNET_EXTRA_FORMATS', '').split(',') if pair]
EXR_CODEC = os.environ.get('RENDERNET_EXR_CODEC', '')
EXR_DEPTH = os.environ.get('RENDERNET_EXR_DEPTH', '')
JPEG_QUALITY = os.environ.get('RENDERNET_JPEG_QUALITY', '')


# Depth and quality are one setting shared by every format rather than one per
# format, so each format has to state its own or inherit the last one written.
def use_format(settings, name):
    settings.file_format = name

    if name == 'OPEN_EXR':
        if EXR_CODEC:
            settings.exr_codec = EXR_CODEC
        if EXR_DEPTH:
            settings.color_depth = EXR_DEPTH
    else:
        settings.color_depth = '8'

    if name == 'JPEG' and JPEG_QUALITY:
        settings.quality = int(JPEG_QUALITY)


def save_extras(scene, _depsgraph=None):
    result = bpy.data.images.get('Render Result')

    if result is None:
        return

    base = os.environ['RENDERNET_FRAME_BASE']
    settings = scene.render.image_settings

    try:
        for name, extension in EXTRAS:
            use_format(settings, name)
            result.save_render(base + extension, scene=scene)
    finally:
        use_format(settings, PRIMARY)


if PRIMARY:
    use_format(bpy.context.scene.render.image_settings, PRIMARY)

if EXTRAS:
    bpy.app.handlers.render_post.append(save_extras)
`;

// Blender has no flag for either, so they are set on the loaded scene.
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
    this.currentProcess = null;
    // A cancelled job ends the frame, not the worker.
    this.abandoned = false;
    this.stopping = false;
    this.killTimer = null;
    this.renewTimer = null;
  }

  stop() {
    this.stopping = true;
    this.cancel();
  }

  cancel() {
    this.abandoned = true;

    const running = this.currentProcess;
    if (!running) return false;

    // A Blender that ignores the stop request keeps the queue waiting behind it.
    if (terminate(running)) {
      this.killTimer = setTimeout(() => running.kill('SIGKILL'), KILL_GRACE_MS);
      this.killTimer.unref();
    }

    return true;
  }

  // Kept, so a hundred frames of one scene cost one transfer.
  async fetchBlend(jobId) {
    const cached = path.join(SCRATCH_DIR, `job_${jobId}.blend`);

    if (fs.existsSync(cached)) return cached;

    fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/blend`, {
      headers: workerHeaders()
    });

    if (!response.ok) throw new Error(`the server answered ${response.status}`);

    // Moved into place so an interrupted download is never mistaken for a scene.
    const partial = `${cached}.part`;
    fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(partial, cached);

    console.log(`Fetched the scene for job ${jobId}`);

    return cached;
  }

  // Resolves to whether there was anything to do.
  async claimAndRender() {
    if (this.stopping) return false;

    const lease = await this.requestLease();

    if (!lease) return false;

    this.abandoned = false;
    await this.renderLeasedFrame(lease);

    return true;
  }

  async requestLease() {
    try {
      const response = await fetch(`${WORKER_BASE}/lease`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ workerId: this.workerId })
      });

      // 204 is the ordinary "nothing for you" answer.
      if (!response.ok || response.status === 204) return null;

      return (await response.json()).lease;
    } catch (error) {
      console.error(`Could not ask for a frame: ${error.message}`);
      return null;
    }
  }

  async renderLeasedFrame(lease) {
    const { leaseId, jobId, frame, renderEngine, formats } = lease;
    const primary = primaryOf(formats);
    const extras = extrasOf(formats);

    // A worker elsewhere has neither the uploaded scene nor the server's scratch
    // space, so it fetches the one and uses its own for the other.
    const remote = process.env.WORKER_REMOTE === '1' || !fs.existsSync(lease.blendPath);

    let blendPath = lease.blendPath;
    const outputDir = remote ? path.join(SCRATCH_DIR, `job_${jobId}`) : lease.outputDir;

    fs.mkdirSync(outputDir, { recursive: true });

    if (remote) {
      try {
        blendPath = await this.fetchBlend(jobId);
      } catch (error) {
        console.error(`Could not fetch the scene for job ${jobId}: ${error.message}`);
        await this.reportFrameFailure(jobId, frame, `Worker could not fetch the scene: ${error.message}`, leaseId);
        await this.releaseLease(leaseId);
        return;
      }
    }

    // Named per frame: workers sharing a job share the folder, and one of them
    // rewriting the file another is reading would break that render.
    const outputScript = path.join(outputDir, `output_${frame}.py`);
    fs.writeFileSync(outputScript, OUTPUT_SCRIPT);

    console.log(`\n🎬 Job ${jobId}, frame ${frame} (${renderEngine})`);

    this.startRenewing(lease);

    try {
      const produced = await this.renderSingleFrame(
        blendPath, frame, outputDir, renderEngine,
        { resolutionPercent: lease.resolutionPercent, samples: lease.samples },
        {
          primary,
          extras,
          outputScript,
          exrCodec: lease.exrCodec,
          exrDepth: lease.exrDepth,
          jpegQuality: lease.jpegQuality
        }
      );

      console.log(`✅ Frame ${frame} rendered: ${produced.join(', ')}`);

      // Every format has to arrive or the ZIP is missing one for this frame alone.
      for (const file of produced) {
        if (!await this.uploadFrame(jobId, frame, file, leaseId)) {
          throw new Error('Frame rendered but upload failed');
        }
      }

      for (const file of produced) fs.rmSync(file, { force: true });

      await this.reportProgress(jobId, frame);
    } catch (error) {
      // A frame killed by cancellation is not a render failure.
      if (!this.abandoned) {
        console.error(`❌ Frame ${frame} failed: ${error.message}`);

        // The server decides whether the frame has attempts left.
        await this.reportFrameFailure(jobId, frame, error.message, leaseId);
      }
    } finally {
      this.stopRenewing();

      // However the frame ended: a job being cancelled waits for exactly this,
      // and a frame that finished before the first renewal never heard about it.
      await this.releaseLease(leaseId);

      fs.rmSync(outputScript, { force: true });
    }
  }

  startRenewing(lease) {
    // Far more often than the term needs, because a refused renewal is also how
    // a cancelled job reaches a worker the server cannot call into. Renewing is
    // one small request; waiting a third of a lease term to notice is not.
    const every = Math.min(Math.max(Math.floor(lease.ttlMs / 3), 1000), RENEW_EVERY_MS);

    this.renewTimer = setInterval(async () => {
      const response = await fetch(`${WORKER_BASE}/leases/${lease.leaseId}/renew`, {
        method: 'POST',
        headers: workerHeaders()
      }).catch(() => null);

      if (!response || response.ok) return;

      // The job has stopped - cancelled, or paused for something more urgent.
      // A refused renewal is how a worker finds that out without the server
      // having to reach into it.
      console.warn(`Claim on frame ${lease.frame} refused, abandoning it`);
      this.cancel();
    }, every);

    this.renewTimer.unref?.();
  }

  stopRenewing() {
    clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  async releaseLease(leaseId) {
    await fetch(`${WORKER_BASE}/leases/${leaseId}/release`, {
      method: 'POST',
      headers: workerHeaders()
    }).catch(error => console.error(`Could not let go of the frame: ${error.message}`));
  }

  renderSingleFrame(blendPath, frame, outputDir, renderEngine, overrides = {}, output = {}) {
    return new Promise((resolve, reject) => {
      // '####' pads the frame number to four digits; a single '#' does not pad
      // at all, so the written and expected names never agree.
      const outputPattern = path.join(outputDir, 'frame_####');
      const { primary = 'PNG', extras = [], outputScript } = output;
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

      args.push('-P', outputScript);

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
      const env = {
        ...process.env,
        RENDERNET_FRAME_BASE: stem,
        RENDERNET_PRIMARY_FORMAT: primary,
        RENDERNET_EXTRA_FORMATS: extras.map(id => `${id}:${extensionOf(id)}`).join(','),
        RENDERNET_EXR_CODEC: output.exrCodec ?? '',
        RENDERNET_EXR_DEPTH: output.exrDepth ?? '',
        RENDERNET_JPEG_QUALITY: output.jpegQuality == null ? '' : String(output.jpegQuality)
      };

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

  async uploadFrame(jobId, frameNumber, framePath, leaseId) {
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
        headers: workerHeaders({ ...formData.getHeaders(), 'x-lease-id': leaseId })
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
  async reportFrameFailure(jobId, frameNumber, error, leaseId) {
    try {
      const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/frames/${frameNumber}/failed`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json', 'x-lease-id': leaseId }),
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
}

export default RenderWorker;