import os from 'os';
import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { findBlenderExecutable, renderableEngines } from './utils/blender-check.js';
import { launch, terminate } from './utils/process-control.js';
import { primaryOf, extrasOf, extensionOf } from './formats.js';
import { GRID_PYTHON } from './tiles.js';

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
const TILE_SCRIPT = `import bpy, os
${GRID_PYTHON}

index = int(os.environ['RENDERNET_TILE_INDEX'])
count = int(os.environ['RENDERNET_TILE_COUNT'])

scene = bpy.context.scene
width, height = frame_size(scene)
region = region_of(index, count, width, height)

# Cropped, so each worker sends back only its own pixels rather than a
# full-size frame that is empty everywhere else.
scene.render.use_border = True
scene.render.use_crop_to_border = True
scene.render.border_min_x = region['x0'] / width
scene.render.border_max_x = region['x1'] / width
scene.render.border_min_y = region['y0'] / height
scene.render.border_max_y = region['y1'] / height
`;

// Said by the script as each frame's files land, so a span hands its frames
// back as it goes rather than all at the end.
const FRAME_DONE = 'RENDERNET_FRAME_DONE ';

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

    # One launch may render a span of frames, so the name comes from the frame
    # in hand rather than from a single stem passed in.
    base = os.path.join(os.environ['RENDERNET_FRAME_DIR'],
                        os.environ['RENDERNET_FRAME_PREFIX']
                        + str(scene.frame_current).zfill(4))
    settings = scene.render.image_settings

    try:
        for name, extension in EXTRAS:
            use_format(settings, name)
            result.save_render(base + extension, scene=scene)
    finally:
        use_format(settings, PRIMARY)


# render_write runs after render_post and after Blender has written the frame
# itself, so by here every file for this frame is on disk. Flushed because the
# worker reads this as it goes.
def announce(scene, _depsgraph=None):
    print('${FRAME_DONE}%d' % scene.frame_current, flush=True)


if PRIMARY:
    use_format(bpy.context.scene.render.image_settings, PRIMARY)

if EXTRAS:
    bpy.app.handlers.render_post.append(save_extras)

bpy.app.handlers.render_write.append(announce)
`;

function describeSpan(frames) {
  if (frames.length === 1) return `frame ${frames[0]}`;

  return `frames ${frames[0]}-${frames[frames.length - 1]} (${frames.length})`;
}

// What one frame of a span actually wrote. Null when the frame Blender was
// meant to produce is not there, which is how a span reports a frame that
// failed inside an otherwise good run.
function filesFor(stem, primary, extras, frame) {
  const expected = stem + extensionOf(primary);

  if (!fs.existsSync(expected)) return null;

  const written = [expected];

  for (const id of extras) {
    const extra = stem + extensionOf(id);

    if (fs.existsSync(extra)) written.push(extra);
    else console.warn(`⚠️  Frame ${frame}: Blender wrote no ${id} file`);
  }

  return written;
}

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
  // WORKER_SECRET is what a farm upgrading from the shared secret still has.
  const token = process.env.WORKER_TOKEN || process.env.WORKER_SECRET || '';

  return { 'x-worker-token': token, ...extra };
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
    await this.renderLeasedSpan(lease);

    return true;
  }

  // Probed once: it costs a Blender start, and the answer cannot change while
  // this process is running.
  engines() {
    this.engineList ??= renderableEngines(BLENDER_PATH);
    return this.engineList;
  }

  async requestLease() {
    try {
      const response = await fetch(`${WORKER_BASE}/lease`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          workerId: this.workerId,
          name: os.hostname(),
          engines: this.engines(),
          device: CYCLES_DEVICE
        })
      });

      // 204 is the ordinary "nothing for you" answer.
      if (!response.ok || response.status === 204) return null;

      return (await response.json()).lease;
    } catch (error) {
      console.error(`Could not ask for a frame: ${error.message}`);
      return null;
    }
  }

  async renderLeasedSpan(lease) {
    const { leaseId, jobId, frames, renderEngine, formats } = lease;
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
        // Charged to the first frame only: nothing in the span was attempted.
        console.error(`Could not fetch the scene for job ${jobId}: ${error.message}`);
        await this.reportFrameFailure(
          jobId, frames[0], `Worker could not fetch the scene: ${error.message}`, leaseId);
        await this.releaseLease(leaseId);
        return;
      }
    }

    // Named per span: workers sharing a job share the folder, and one of them
    // rewriting the file another is reading would break that render.
    const outputScript = path.join(outputDir, `output_${frames[0]}.py`);
    fs.writeFileSync(outputScript, lease.tile ? TILE_SCRIPT + OUTPUT_SCRIPT : OUTPUT_SCRIPT);

    // A tile renders one scene frame under the number of its region; everything
    // else renders the frames it was given.
    const sceneFrames = lease.tile ? [lease.sceneFrame] : frames;
    const prefix = lease.tile ? `tile_${lease.tile.index}_` : 'frame_';

    console.log(lease.tile
      ? `\n🎬 Job ${jobId}, tile ${lease.tile.index} of ${lease.tile.of} (${renderEngine})`
      : `\n🎬 Job ${jobId}, ${describeSpan(frames)} (${renderEngine})`);

    this.startRenewing(lease);

    // Frames go back as Blender finishes them rather than when the span does,
    // so a machine switched off mid-span keeps what it had already rendered.
    const announced = new Set();
    const handled = new Set();
    let pump = Promise.resolve();

    const deliver = sceneFrame => {
      const index = sceneFrames.indexOf(sceneFrame);

      if (index === -1 || announced.has(index)) return;

      announced.add(index);
      pump = pump.then(async () => {
        const done = await this.deliverFrame(lease, {
          index, sceneFrames, outputDir, prefix, primary, extras
        });

        if (done) handled.add(index);
      });
    };

    let failure = null;

    try {
      await this.renderFrames(
        blendPath, sceneFrames, outputDir, renderEngine,
        { resolutionPercent: lease.resolutionPercent, samples: lease.samples },
        {
          primary,
          extras,
          prefix,
          outputScript,
          onFrame: deliver,
          exrCodec: lease.exrCodec,
          exrDepth: lease.exrDepth,
          jpegQuality: lease.jpegQuality,
          tile: lease.tile
        }
      );
    } catch (error) {
      // Judged frame by frame below rather than thrown away whole.
      failure = error;
    }

    try {
      await pump;

      if (!this.abandoned) await this.accountFor(lease, handled, failure);
    } finally {
      this.stopRenewing();

      // However the span ended: a job being cancelled waits for exactly this,
      // and a span that finished before the first renewal never heard about it.
      await this.releaseLease(leaseId);

      fs.rmSync(outputScript, { force: true });
    }
  }

  // Resolves to whether this frame has been dealt with. A frame announced whose
  // files are not there is left to the accounting pass, which is the one place
  // a failure is decided.
  async deliverFrame(lease, { index, sceneFrames, outputDir, prefix, primary, extras }) {
    if (this.abandoned) return true;

    const { leaseId, jobId, frames } = lease;
    const frame = frames[index];
    const stem = path.join(outputDir, prefix + String(sceneFrames[index]).padStart(4, '0'));
    const produced = filesFor(stem, primary, extras, frame);

    if (produced === null) return false;

    console.log(`✅ Job ${jobId}, frame ${frame} rendered: ${produced.join(', ')}`);

    let delivered = true;

    // Every format has to arrive or the ZIP is missing one for this frame alone.
    for (const file of produced) {
      if (await this.uploadFrame(jobId, frame, file, leaseId)) continue;

      delivered = false;
      break;
    }

    for (const file of produced) fs.rmSync(file, { force: true });

    if (delivered) await this.reportProgress(jobId, frame);
    else await this.reportFrameFailure(jobId, frame, 'Frame rendered but upload failed', leaseId);

    return true;
  }

  // What the span did not deliver. Blender works through a span in order, so on
  // a launch that gave up partway the first frame with nothing to show is the
  // one that failed and the frames behind it were never attempted - those are
  // said nothing about, and releasing the span returns them with their attempts
  // intact.
  async accountFor(lease, handled, failure) {
    const { leaseId, jobId, frames } = lease;

    for (const [index, frame] of frames.entries()) {
      if (handled.has(index)) continue;

      const why = failure ? failure.message : `Blender rendered no frame ${frame}`;

      console.error(`❌ Frame ${frame} failed: ${why}`);
      await this.reportFrameFailure(jobId, frame, why, leaseId);

      if (failure) break;
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
      console.warn(`Claim on ${describeSpan(lease.frames)} refused, abandoning it`);
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

  renderFrames(blendPath, frames, outputDir, renderEngine, overrides = {}, output = {}) {
    return new Promise((resolve, reject) => {
      // '####' pads the frame number to four digits; a single '#' does not pad
      // at all, so the written and expected names never agree.
      const { primary = 'PNG', extras = [], outputScript, prefix = 'frame_' } = output;
      const outputPattern = path.join(outputDir, `${prefix}####`);

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
      // follows. A comma-separated list renders the whole span in one launch.
      args.push('-f', frames.join(','));

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
        RENDERNET_FRAME_DIR: outputDir,
        RENDERNET_FRAME_PREFIX: prefix,
        RENDERNET_PRIMARY_FORMAT: primary,
        RENDERNET_EXTRA_FORMATS: extras.map(id => `${id}:${extensionOf(id)}`).join(','),
        RENDERNET_EXR_CODEC: output.exrCodec ?? '',
        RENDERNET_EXR_DEPTH: output.exrDepth ?? '',
        RENDERNET_JPEG_QUALITY: output.jpegQuality == null ? '' : String(output.jpegQuality),
        RENDERNET_TILE_INDEX: output.tile ? String(output.tile.index) : '',
        RENDERNET_TILE_COUNT: output.tile ? String(output.tile.of) : ''
      };

      const blender = launch(BLENDER_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      this.currentProcess = blender;

      let stdout = '';
      let stderr = '';
      let pending = '';

      // Both pipes have to be drained. An unread one fills its buffer and
      // blocks Blender mid-write, and nothing here would ever time out.
      blender.stdout.on('data', (data) => {
        stdout = (stdout + data).slice(-OUTPUT_TAIL);

        // Read a line at a time: a chunk can end mid-marker, and half a frame
        // number is worse than none.
        pending += data;

        const lines = pending.split('\n');
        pending = lines.pop();

        for (const line of lines) {
          const said = line.indexOf(FRAME_DONE);

          if (said > -1) output.onFrame?.(Number(line.slice(said + FRAME_DONE.length)));
        }
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

        resolve();
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