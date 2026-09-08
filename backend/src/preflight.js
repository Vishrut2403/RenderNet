import fs from 'fs';
import os from 'os';
import path from 'path';
import { launch, terminate } from './utils/process-control.js';
import { findBlenderExecutable } from './utils/blender-check.js';
import { REFERENCED_PYTHON, SUPPLIED_PYTHON } from './scene-references.js';
import { CACHES_PYTHON } from './baking.js';

const MARKER = 'RENDERNET_PREFLIGHT ';
const TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 120 * 1000;

// Packed files are skipped because packing is the fix being asked for.
const SCRIPT = `import bpy, os, json, re
${REFERENCED_PYTHON}
${SUPPLIED_PYTHON}
${CACHES_PYTHON}


def described(scene):
    render = scene.render
    cycles = getattr(scene, 'cycles', None)

    return {
        'name': scene.name,
        'frameStart': scene.frame_start,
        'frameEnd': scene.frame_end,
        'frameStep': scene.frame_step,
        'engine': render.engine,
        'width': render.resolution_x,
        'height': render.resolution_y,
        'resolutionPercent': render.resolution_percentage,
        'samples': getattr(cycles, 'samples', None),
        'format': render.image_settings.file_format,
        'camera': scene.camera.name if scene.camera else None
    }


# A simulation nobody has baked is stepped from the start of the range as it
# renders, so a frame is only right if every frame before it was rendered first,
# in the same Blender. A farm does neither. Mantaflow fluids are left out:
# nothing readable here says whether one has been baked.
def named(obj, mod):
    return '%s (%s)' % (obj.name, mod.type.replace('_', ' ').lower() if mod else 'particles')


def why_not_here(obj):
    # A cache on a linked object belongs to the file it was linked from and is
    # not written into the one linking it; Blender bakes nothing at all for an
    # object switched off in the viewport. Baking either would look like it
    # worked and deliver frames of a simulation nobody would see at home.
    if obj.library is not None:
        return 'linked'

    if obj.hide_viewport:
        return 'hidden'

    return None


def unbaked():
    for obj, mod, cache in point_caches():
        if unusable(cache) and why_not_here(obj) is None:
            yield named(obj, mod)

    world = bpy.context.scene.rigidbody_world

    if world is not None and unusable(world.point_cache):
        yield 'the scene (rigid body)'


def unbakeable():
    for obj, mod, cache in point_caches():
        why = why_not_here(obj)

        if unusable(cache) and why is not None:
            yield {'name': named(obj, mod), 'why': why}


# Before anything is judged: a file already handed over is not missing, and a
# library only shows what it needs once it has been opened.
apply_supplied(os.environ.get('RENDERNET_ASSETS', ''))

missing = []
unpacked = []

for block in referenced():
    if getattr(block, 'packed_file', None):
        continue

    stored = block.filepath

    if not stored or stored == '<builtin>':
        continue

    resolved = os.path.normpath(
        bpy.path.native_pathsep(bpy.path.abspath(stored, library=block.library)))

    # Here is not the same as packed: a machine somewhere else is sent the
    # .blend and nothing beside it.
    if os.path.exists(resolved):
        unpacked.append(resolved)
    else:
        # Both: the path as the file stores it is what names the datablock to
        # repoint later, and the resolved one is what says where it looked.
        missing.append({'stored': stored, 'resolved': resolved})

print('${MARKER}' + json.dumps({
    'missing': sorted({item['stored']: item for item in missing}.values(),
                      key=lambda item: item['resolved']),
    'unpacked': sorted(set(unpacked)),
    'unbaked': sorted(set(unbaked())),
    'unbakeable': sorted(unbakeable(), key=lambda entry: entry['name']),
    'active': bpy.context.scene.name,
    'scenes': [described(scene) for scene in bpy.data.scenes]
}))
`;

function parse(output) {
  const line = output.split('\n').reverse().find(text => text.includes(MARKER));

  if (!line) return null;

  try {
    return JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length));
  } catch {
    return null;
  }
}

let queued = Promise.resolve();

// One Blender at a time, whoever is asking: a burst of uploads would otherwise
// put a Blender per job on a machine that is meant to be spending itself on
// renders.
function readBlend(blendPath, supplied) {
  const next = queued.then(() => openScene(blendPath, supplied));

  queued = next.catch(() => {});

  return next;
}

// What would make this scene render wrongly rather than not at all: files it
// reaches for and did not bring, files only this machine can see, and
// simulations nobody has baked. Anything that goes wrong with the check itself
// lets the job through: a broken preflight must not be able to stop the farm.
// Reports from before this named a missing file by its resolved path alone.
function asDependency(entry) {
  return typeof entry === 'string'
    ? { stored: entry, resolved: entry, name: basename(entry) }
    : { ...entry, name: basename(entry.stored ?? entry.resolved ?? '') };
}

function basename(file) {
  return String(file).split(/[\\/]/).pop();
}

export function checkScene(blendPath, supplied = null) {
  return readBlend(blendPath, supplied).then(report => ({
    checked: report !== null,
    missing: (report?.missing ?? []).map(asDependency),
    unpacked: report?.unpacked ?? [],
    unbaked: report?.unbaked ?? [],
    unbakeable: report?.unbakeable ?? []
  }));
}

// What the scene already says about itself.
export function readScene(blendPath) {
  return readBlend(blendPath).then(report => (report === null
    ? { read: false, active: null, scenes: [], unbaked: [] }
    : {
      read: true,
      active: report.active ?? null,
      scenes: report.scenes ?? [],
      unbaked: report.unbaked ?? []
    }));
}

function openScene(blendPath, supplied = null) {
  return new Promise(resolve => {
    const blender = findBlenderExecutable();

    if (!blender) return resolve(null);

    const scriptPath = path.join(os.tmpdir(), `rendernet-preflight-${process.pid}.py`);
    fs.writeFileSync(scriptPath, SCRIPT);

    const probe = launch(blender, ['-b', blendPath, '-P', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RENDERNET_ASSETS: supplied ?? '' }
    });

    let output = '';
    probe.stdout.on('data', chunk => { output += chunk; });
    probe.stderr.on('data', chunk => { output += chunk; });

    const done = result => {
      clearTimeout(timer);
      fs.rmSync(scriptPath, { force: true });
      resolve(result);
    };

    const timer = setTimeout(() => {
      terminate(probe);
      console.warn(`Reading ${path.basename(blendPath)} timed out; rendering anyway`);
      done(null);
    }, TIMEOUT_MS);

    timer.unref?.();

    probe.on('error', error => {
      console.warn(`The scene could not be read: ${error.message}`);
      done(null);
    });

    probe.on('close', () => {
      const report = parse(output);

      if (!report) {
        console.warn(`Reading ${path.basename(blendPath)} said nothing; rendering anyway`);
        return done(null);
      }

      done(report);
    });
  });
}

