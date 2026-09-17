import os from 'os';
import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { chooseDevice, findBlenderExecutable, renderableEngines } from './utils/blender-check.js';
import { launch, terminate } from './utils/process-control.js';
import { BlenderSession, sessionKey, DAEMON_SCRIPT, FRAME_DONE } from './blender-session.js';
import { primaryOf, extrasOf, extensionOf } from './formats.js';
import { GRID_PYTHON, COMPOSITE_SCRIPT, tileName } from './tiles.js';
import { REFERENCED_PYTHON, SUPPLIED_PYTHON } from './scene-references.js';
import { BAKE_SCRIPT, BAKE_MARKER, UNBAKED_MARKER, AGAIN_MARKER } from './baking.js';

const BLENDER_PATH = process.env.BLENDER_PATH || findBlenderExecutable() || 'blender';
const API_URL = process.env.API_URL || 'http://localhost:5500';
const WORKER_BASE = `${API_URL}/api/worker`;
const OUTPUT_TAIL = 4000;
const KILL_GRACE_MS = 5000;
const RENEW_EVERY_MS = 5000;
const IDLE_MS = Number(process.env.BLENDER_IDLE_MS ?? 60000);

let chosenDevice = null;

const SLOT = process.env.WORKER_ID || '';

// Both flags explicit, so the workstation's auto-run preference never decides.
function scriptsIn(allowed) {
  return allowed ? ['--enable-autoexec'] : ['--disable-autoexec'];
}
const WAIT_SECONDS = Number(process.env.WORKER_WAIT_SECONDS ?? 25);

async function progressFrom(response) {
  return (await response.json().catch(() => ({}))).progress ?? null;
}

function cyclesDevice() {
  if (!chosenDevice) {
    chosenDevice = chooseDevice(BLENDER_PATH);

    if (chosenDevice.wanted) {
      console.log(`⚠️  Cycles: this Blender offers no ${chosenDevice.wanted} device, `
        + `rendering with ${chosenDevice.device}`);
    } else if (!SLOT || SLOT.endsWith('-0')) {
      console.log(`Cycles renders here on ${chosenDevice.device}`);
    }
  }

  return chosenDevice;
}

const SCRATCH_DIR = process.env.WORKER_SCRATCH_DIR
  || path.join(os.tmpdir(), 'rendernet-worker');

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

const OUTPUT_SCRIPT = `import bpy, os, json
${REFERENCED_PYTHON}
${SUPPLIED_PYTHON}

PRIMARY = os.environ.get('RENDERNET_PRIMARY_FORMAT', '')
EXTRAS = [pair.split(':') for pair in os.environ.get('RENDERNET_EXTRA_FORMATS', '').split(',') if pair]
EXR_CODEC = os.environ.get('RENDERNET_EXR_CODEC', '')
EXR_DEPTH = os.environ.get('RENDERNET_EXR_DEPTH', '')
JPEG_QUALITY = os.environ.get('RENDERNET_JPEG_QUALITY', '')


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


def announce(scene, _depsgraph=None):
    print('${FRAME_DONE}%d' % scene.frame_current, flush=True)


# Files the artist handed over for things the scene reaches for and did not
# bring. The .blend is not rewritten: the datablock is pointed at the copy that
# came with the job, which is the same picture and none of the upload.
apply_supplied(os.environ.get('RENDERNET_ASSETS', ''))


if PRIMARY:
    use_format(bpy.context.scene.render.image_settings, PRIMARY)

if EXTRAS:
    bpy.app.handlers.render_post.append(save_extras)

bpy.app.handlers.render_write.append(announce)
`;

function sceneName(blendPath) {
  const holding = path.basename(path.dirname(blendPath ?? ''));

  return /^[0-9a-f]{64}$/.test(holding) ? holding : null;
}

function lastLine(output) {
  return output.split('\n').map(line => line.trim()).filter(Boolean).pop() ?? '';
}

function describeSpan(frames) {
  if (frames.length === 1) return `frame ${frames[0]}`;

  return `frames ${frames[0]}-${frames[frames.length - 1]} (${frames.length})`;
}

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

function blenderCommand(blendPath, outputDir, renderEngine, overrides, output) {
  const { primary = 'PNG', extras = [], outputScript, prefix = 'frame_' } = output;
  const { allowScripts } = overrides;

  const args = [
    '-b', blendPath,
    ...scriptsIn(allowScripts),
    '-E', renderEngine,
    '-F', primary,
    '-o', path.join(outputDir, `${prefix}####`)
  ];

  const expression = sceneOverrides(renderEngine, overrides);

  if (expression) args.push('--python-expr', expression);

  args.push('-P', outputScript);

  if (renderEngine === 'CYCLES') {
    // Blender only reads add-on options after '--'.
    args.push('--', '--cycles-device', cyclesDevice().device);
  }

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
    RENDERNET_TILE_COUNT: output.tile ? String(output.tile.of) : '',
    RENDERNET_ASSETS: output.assetManifest ?? ''
  };

  return { args, env };
}

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

function workerHeaders(extra = {}) {
  const token = process.env.WORKER_TOKEN || process.env.WORKER_SECRET || '';

  return { 'x-worker-token': token, ...extra };
}

class RenderWorker {
  constructor(workerId = 'local-worker') {
    this.workerId = workerId;
    this.currentProcess = null;
    this.abandoned = false;
    this.stopping = false;
    this.killTimer = null;
    this.renewTimer = null;
    this.session = null;
    this.idleTimer = null;
  }

  stop() {
    this.stopping = true;
    this.waiting?.abort();
    this.cancel();
    this.dropSession();
  }

  cancel() {
    this.abandoned = true;

    const running = this.currentProcess;

    if (!running) return this.dropSession();

    if (terminate(running)) {
      this.killTimer = setTimeout(() => running.kill('SIGKILL'), KILL_GRACE_MS);
      this.killTimer.unref();
    }

    return true;
  }

  async sessionFor(args, env) {
    clearTimeout(this.idleTimer);

    if (this.session?.alive && this.session.key === sessionKey(BLENDER_PATH, args, env)) {
      return this.session;
    }

    this.dropSession();

    console.log(`   Running: ${BLENDER_PATH} ${args.join(' ')}`);

    const session = new BlenderSession(BLENDER_PATH, args, env);

    this.session = session;
    await session.start();

    return session;
  }

  holdSession() {
    clearTimeout(this.idleTimer);

    if (!this.session || IDLE_MS <= 0) {
      this.dropSession();
      return;
    }

    this.idleTimer = setTimeout(() => this.dropSession(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  dropSession() {
    clearTimeout(this.idleTimer);

    const held = this.session;

    this.session = null;
    held?.kill();

    return held !== null;
  }

  async fetchBlend(jobId, blendPath, version = null) {
    const held = sceneName(blendPath) ?? `job_${jobId}${version ? `_${version}` : ''}`;
    const cached = path.join(SCRATCH_DIR, `${held}.blend`);

    if (fs.existsSync(cached)) return cached;

    fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    for (const stale of fs.readdirSync(SCRATCH_DIR)) {
      if (!stale.startsWith(`job_${jobId}_`) || stale === `${held}.blend`) continue;

      try {
        fs.rmSync(path.join(SCRATCH_DIR, stale), { force: true });
      } catch {
        console.warn(`Could not clear the old scene for job ${jobId}`);
      }
    }

    const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/blend`, {
      headers: workerHeaders()
    });

    if (!response.ok) throw new Error(`the server answered ${response.status}`);

    const partial = `${cached}.part`;
    fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(partial, cached);

    console.log(`Fetched the scene for job ${jobId}`);

    return cached;
  }

  async gatherAssets(lease, outputDir, remote) {
    const assets = lease.assets ?? [];

    if (assets.length === 0) return null;

    const given = {};

    for (const asset of assets) {
      if (!remote && asset.path && fs.existsSync(asset.path)) {
        given[asset.stored] = asset.path;
        continue;
      }

      const local = path.join(outputDir, 'supplied', asset.filename);

      if (!fs.existsSync(local)) {
        const response = await fetch(
          `${WORKER_BASE}/jobs/${lease.jobId}/assets/${asset.filename}`,
          { headers: workerHeaders() });

        if (!response.ok) {
          throw new Error(`the server answered ${response.status} for ${asset.filename}`);
        }

        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, Buffer.from(await response.arrayBuffer()));
      }

      given[asset.stored] = local;
    }

    return given;
  }

  async claimAndRender() {
    if (this.stopping) return false;

    const lease = await this.requestLease();

    if (!lease) return false;

    this.abandoned = false;

    if (lease.bake) await this.bakeLeasedScene(lease);
    else if (lease.composite) await this.assembleLeasedStill(lease);
    else await this.renderLeasedSpan(lease);

    return true;
  }

  engines() {
    this.engineList ??= renderableEngines(BLENDER_PATH);
    return this.engineList;
  }

  async requestLease() {
    this.waiting = new AbortController();

    try {
      const response = await fetch(`${WORKER_BASE}/lease`, {
        method: 'POST',
        signal: this.waiting.signal,
        headers: workerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          workerId: this.workerId,
          name: os.hostname(),
          engines: this.engines(),
          device: cyclesDevice().device,
          deviceWanted: cyclesDevice().wanted,
          wait: WAIT_SECONDS
        })
      });

      if (!response.ok || response.status === 204) return null;

      return (await response.json()).lease;
    } catch (error) {
      if (!this.stopping) console.error(`Could not ask for a frame: ${error.message}`);

      return null;
    }
  }

  async renderLeasedSpan(lease) {
    const { leaseId, jobId, frames, renderEngine, formats } = lease;
    const primary = primaryOf(formats);
    const extras = extrasOf(formats);

    const remote = process.env.WORKER_REMOTE === '1' || !fs.existsSync(lease.blendPath);

    let blendPath = lease.blendPath;
    const outputDir = remote ? path.join(SCRATCH_DIR, `job_${jobId}`) : lease.outputDir;

    fs.mkdirSync(outputDir, { recursive: true });

    if (remote) {
      try {
        blendPath = await this.fetchBlend(jobId, lease.blendPath, lease.blendVersion);
      } catch (error) {
        console.error(`Could not fetch the scene for job ${jobId}: ${error.message}`);
        await this.reportFrameFailure(
          jobId, frames[0], `Worker could not fetch the scene: ${error.message}`, leaseId);
        await this.releaseLease(leaseId);
        return;
      }
    }

    const outputScript = path.join(outputDir, `render_${this.workerId.replace(/\W/g, '_')}.py`);

    fs.writeFileSync(outputScript,
      (lease.tile ? TILE_SCRIPT + OUTPUT_SCRIPT : OUTPUT_SCRIPT) + DAEMON_SCRIPT);

    let assetManifest = '';

    try {
      const given = await this.gatherAssets(lease, outputDir, remote);

      if (given) {
        assetManifest = path.join(outputDir, `assets_${this.workerId.replace(/\W/g, '_')}.json`);
        fs.writeFileSync(assetManifest, JSON.stringify(given));
      }
    } catch (error) {
      console.error(`Could not gather the files for job ${jobId}: ${error.message}`);
      await this.reportFrameFailure(
        jobId, frames[0], `Worker could not fetch a supplied file: ${error.message}`, leaseId);
      await this.releaseLease(leaseId);
      return;
    }

    const sceneFrames = lease.tile ? [lease.sceneFrame] : frames;
    const prefix = lease.tile ? `tile_${lease.tile.index}_` : 'frame_';

    console.log(lease.tile
      ? `\n🎬 Job ${jobId}, tile ${lease.tile.index} of ${lease.tile.of} (${renderEngine})`
      : `\n🎬 Job ${jobId}, ${describeSpan(frames)} (${renderEngine})`);

    this.startRenewing(lease);

    const announced = new Set();
    const handled = new Set();
    let pump = Promise.resolve();

    const deliver = sceneFrame => {
      const index = sceneFrames.indexOf(sceneFrame);

      if (index === -1 || announced.has(index)) return;

      announced.add(index);
      pump = pump.then(async () => {
        const done = await this.deliverFrame(lease, {
          index, sceneFrames, outputDir, prefix, primary, extras, remote
        });

        if (done) handled.add(index);
      });
    };

    let failure = null;

    try {
      await this.renderFrames(
        blendPath, sceneFrames, outputDir, renderEngine,
        {
          resolutionPercent: lease.resolutionPercent,
          samples: lease.samples,
          allowScripts: lease.allowScripts
        },
        {
          primary,
          extras,
          prefix,
          outputScript,
          onFrame: deliver,
          exrCodec: lease.exrCodec,
          exrDepth: lease.exrDepth,
          jpegQuality: lease.jpegQuality,
          tile: lease.tile,
          assetManifest
        }
      );
    } catch (error) {
      failure = error;
    }

    try {
      await pump;

      if (!this.abandoned) await this.accountFor(lease, handled, failure);
    } finally {
      this.stopRenewing();
      this.holdSession();

      await this.releaseLease(leaseId);

      fs.rmSync(outputScript, { force: true });
    }
  }

  async bakeLeasedScene(lease) {
    const { leaseId, jobId, bake } = lease;
    const outputDir = path.join(SCRATCH_DIR, `bake_${jobId}`);

    console.log(`\n🧊 Job ${jobId}, baking ${bake.simulations.length} simulation(s) `
      + `up to frame ${bake.last}`);

    this.startRenewing(lease);

    const remote = process.env.WORKER_REMOTE === '1' || !fs.existsSync(lease.blendPath);
    const output = remote ? path.join(outputDir, 'baked.blend') : bake.path;

    fs.mkdirSync(remote ? outputDir : path.dirname(output), { recursive: true });

    try {
      const blendPath = remote ? await this.fetchBlend(jobId, lease.blendPath) : lease.blendPath;

      let attempt = await this.runBake(blendPath, outputDir, output, bake, remote);

      if (!attempt.failure && attempt.again) {
        fs.rmSync(remote ? path.join(outputDir, 'fluid') : bake.caches,
          { recursive: true, force: true });

        attempt = await this.runBake(output, outputDir, output, bake, remote, 'fill');
      }

      const failure = attempt.failure;

      if (this.abandoned) return;

      if (failure) await this.reportBake(jobId, leaseId, failure);
      else if (!await this.sendBaked(jobId, leaseId, remote ? output : null)) {
        await this.reportBake(jobId, leaseId, 'The scene was baked but could not be sent');
      }
    } catch (error) {
      if (!this.abandoned) await this.reportBake(jobId, leaseId, error.message);
    } finally {
      this.stopRenewing();
      await this.releaseLease(leaseId);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }

  runBake(blendPath, outputDir, output, bake, remote, stage = null) {
    return new Promise(resolve => {
      const script = path.join(outputDir, 'bake.py');

      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(script, BAKE_SCRIPT);

      const blender = launch(BLENDER_PATH,
        ['-b', blendPath, ...scriptsIn(bake.allowScripts), '-P', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: outputDir,
        env: {
          ...process.env,
          RENDERNET_BAKE_LAST: String(bake.last),
          RENDERNET_BAKE_OUT: output,
          RENDERNET_BAKE_CACHE: remote ? path.join(outputDir, 'fluid') : bake.caches,
          RENDERNET_BAKE_STAGE: stage ?? ''
        }
      });

      this.currentProcess = blender;

      let said = '';
      blender.stdout.on('data', chunk => { said = (said + chunk).slice(-OUTPUT_TAIL); });
      blender.stderr.on('data', chunk => { said = (said + chunk).slice(-OUTPUT_TAIL); });

      const answer = (failure, again = false) => resolve({ failure, again });

      blender.on('error', error => answer(error.message));

      blender.on('close', code => {
        this.currentProcess = null;

        if (code !== 0) return answer(lastLine(said) || `Blender exited with code ${code}`);

        const stuck = said.split('\n').find(line => line.includes(UNBAKED_MARKER));

        if (stuck) {
          return answer(stuck.slice(stuck.indexOf(UNBAKED_MARKER) + UNBAKED_MARKER.length).trim());
        }

        if (said.includes(AGAIN_MARKER)) return answer(null, true);

        if (!said.includes(BAKE_MARKER) || !fs.existsSync(output)) {
          return answer('Blender wrote no baked scene');
        }

        answer(null);
      });
    });
  }

  async sendBaked(jobId, leaseId, file) {
    const url = `${WORKER_BASE}/jobs/${jobId}/baked`;

    try {
      if (!file) {
        const said = await fetch(url, {
          method: 'POST',
          headers: workerHeaders({ 'Content-Type': 'application/json', 'x-lease-id': leaseId }),
          body: JSON.stringify({ inPlace: true })
        });

        return said.ok;
      }

      const form = new FormData();

      form.append('scene', fs.createReadStream(file), { filename: 'baked.blend' });

      const response = await fetch(url, {
        method: 'POST',
        headers: form.getHeaders(workerHeaders({ 'x-lease-id': leaseId })),
        body: form
      });

      return response.ok;
    } catch (error) {
      console.error(`Could not hand over the baked scene: ${error.message}`);
      return false;
    }
  }

  async reportBake(jobId, leaseId, error) {
    console.error(`❌ Job ${jobId}: the simulations could not be baked: ${error}`);

    await fetch(`${WORKER_BASE}/jobs/${jobId}/baked/failed`, {
      method: 'POST',
      headers: workerHeaders({ 'Content-Type': 'application/json', 'x-lease-id': leaseId }),
      body: JSON.stringify({ error })
    }).catch(reason => console.error(`Could not report it: ${reason.message}`));
  }

  async assembleLeasedStill(lease) {
    const { leaseId, jobId, composite } = lease;
    const outputDir = path.join(SCRATCH_DIR, `composite_${jobId}`);

    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`\n🧩 Job ${jobId}, putting ${composite.tiles} tiles together`);

    this.startRenewing(lease);

    const remote = process.env.WORKER_REMOTE === '1' || !fs.existsSync(lease.blendPath);

    try {
      const blendPath = remote
        ? await this.fetchBlend(jobId, lease.blendPath, lease.blendVersion)
        : lease.blendPath;
      const tiles = await this.gatherTiles(lease, outputDir, remote);
      const output = path.join(outputDir, composite.name);
      const failure = await this.putTogether(blendPath, outputDir, tiles, output, composite);

      if (this.abandoned) return;

      if (failure) await this.reportComposite(jobId, leaseId, failure);
      else if (!await this.uploadComposite(jobId, leaseId, output)) {
        await this.reportComposite(jobId, leaseId, 'The picture was made but could not be sent');
      }
    } catch (error) {
      if (!this.abandoned) await this.reportComposite(jobId, leaseId, error.message);
    } finally {
      this.stopRenewing();
      await this.releaseLease(leaseId);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }

  async gatherTiles(lease, outputDir, remote) {
    const extension = extensionOf(lease.composite.format);
    const tiles = [];

    for (let index = 1; index <= lease.composite.tiles; index++) {
      const name = tileName(index) + extension;
      const beside = path.join(lease.tilesDir, name);

      if (!remote && fs.existsSync(beside)) {
        tiles.push(beside);
        continue;
      }

      const response = await fetch(`${WORKER_BASE}/jobs/${lease.jobId}/tiles/${index}`, {
        headers: workerHeaders({ 'x-lease-id': lease.leaseId })
      });

      if (!response.ok) throw new Error(`Tile ${index} could not be fetched`);

      const here = path.join(outputDir, name);
      fs.writeFileSync(here, Buffer.from(await response.arrayBuffer()));
      tiles.push(here);
    }

    return tiles;
  }

  putTogether(blendPath, outputDir, tiles, output, composite) {
    return new Promise(resolve => {
      const script = path.join(outputDir, 'composite.py');

      fs.writeFileSync(script, COMPOSITE_SCRIPT);

      const spec = {
        tiles,
        count: composite.tiles,
        format: composite.format,
        resolutionPercent: composite.resolutionPercent ?? null,
        output
      };

      const blender = launch(BLENDER_PATH, [
        '-b', blendPath,
        ...scriptsIn(composite.allowScripts),
        '--factory-startup',
        '-noaudio',
        '-P', script
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RENDERNET_TILE_SPEC: JSON.stringify(spec) }
      });

      this.currentProcess = blender;

      let said = '';
      blender.stdout.on('data', chunk => { said = (said + chunk).slice(-OUTPUT_TAIL); });
      blender.stderr.on('data', chunk => { said = (said + chunk).slice(-OUTPUT_TAIL); });

      blender.on('error', error => resolve(error.message));

      blender.on('close', code => {
        this.currentProcess = null;

        if (code !== 0) return resolve(lastLine(said) || `Blender exited with code ${code}`);
        if (!fs.existsSync(output)) return resolve('Blender wrote no picture');

        resolve(null);
      });
    });
  }

  async uploadComposite(jobId, leaseId, file) {
    try {
      const form = new FormData();

      form.append('composite', fs.createReadStream(file), { filename: path.basename(file) });

      const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/composite`, {
        method: 'POST',
        headers: form.getHeaders(workerHeaders({ 'x-lease-id': leaseId })),
        body: form
      });

      return response.ok;
    } catch (error) {
      console.error(`Could not send the finished picture: ${error.message}`);
      return false;
    }
  }

  async reportComposite(jobId, leaseId, error) {
    console.error(`❌ Job ${jobId}: the tiles could not be put together: ${error}`);

    await fetch(`${WORKER_BASE}/jobs/${jobId}/composite/failed`, {
      method: 'POST',
      headers: workerHeaders({ 'Content-Type': 'application/json', 'x-lease-id': leaseId }),
      body: JSON.stringify({ error })
    }).catch(reason => console.error(`Could not report it: ${reason.message}`));
  }

  async deliverFrame(lease, { index, sceneFrames, outputDir, prefix, primary, extras, remote }) {
    if (this.abandoned) return true;

    const { leaseId, jobId, frames } = lease;
    const frame = frames[index];
    const stem = path.join(outputDir, prefix + String(sceneFrames[index]).padStart(4, '0'));
    const produced = filesFor(stem, primary, extras, frame);

    if (produced === null) return false;

    let delivered = true;
    let progress = null;

    for (const file of produced) {
      const handed = await this.handOverFrame(jobId, frame, file, leaseId, remote);

      if (handed.ok) {
        progress = handed.progress ?? progress;
        continue;
      }

      delivered = false;
      break;
    }

    for (const file of produced) fs.rmSync(file, { force: true });

    if (delivered) {
      const names = produced.map(file => path.basename(file)).join(', ');

      console.log(`✅ Job ${jobId}, frame ${frame} rendered`
        + `${progress === null ? '' : ` (${progress}%)`}: ${names}`);

      await this.reportProgress(jobId, frame);
    } else {
      await this.reportFrameFailure(jobId, frame, 'Frame rendered but upload failed', leaseId);
    }

    return true;
  }

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
    const every = Math.min(Math.max(Math.floor(lease.ttlMs / 3), 1000), RENEW_EVERY_MS);

    this.renewTimer = setInterval(async () => {
      const response = await fetch(`${WORKER_BASE}/leases/${lease.leaseId}/renew`, {
        method: 'POST',
        headers: workerHeaders()
      }).catch(() => null);

      if (!response || response.ok) return;

      console.warn(`Claim on ${lease.frames ? describeSpan(lease.frames) : `job ${lease.jobId}`}`
        + ' refused, abandoning it');
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

  async renderFrames(blendPath, frames, outputDir, renderEngine, overrides = {}, output = {}) {
    const { args, env } = blenderCommand(blendPath, outputDir, renderEngine, overrides, output);
    const session = await this.sessionFor(args, env);

    return session.renderSpan(frames, output.onFrame);
  }

  async handOverFrame(jobId, frameNumber, framePath, leaseId, remote) {
    if (remote) return this.uploadFrame(jobId, frameNumber, framePath, leaseId);

    try {
      const response = await fetch(`${WORKER_BASE}/jobs/${jobId}/frames/${frameNumber}/at`, {
        method: 'POST',
        headers: workerHeaders({ 'Content-Type': 'application/json', 'x-lease-id': leaseId }),
        body: JSON.stringify({ path: framePath })
      });

      if (response.ok) return { ok: true, progress: await progressFrom(response) };
    } catch {
    }

    return this.uploadFrame(jobId, frameNumber, framePath, leaseId);
  }

  async uploadFrame(jobId, frameNumber, framePath, leaseId) {
    try {
      const formData = new FormData();
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
        return { ok: false };
      }

      return { ok: true, progress: await progressFrom(response) };

    } catch (error) {
      console.error(`Upload error: ${error.message}`);
      return { ok: false };
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
      console.error(`Failed to report frame failure: ${err.message}`);
      return false;
    }
  }
}

export default RenderWorker;