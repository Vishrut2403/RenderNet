import fs from 'fs';
import os from 'os';
import path from 'path';
import { launch, terminate } from './utils/process-control.js';
import { findBlenderExecutable } from './utils/blender-check.js';

const MARKER = 'RENDERNET_PREFLIGHT ';
const TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 120 * 1000;
const REPORTED = 8;

// Walked datablock by datablock rather than through blend_paths, which also
// reports Blender's own bundled assets - stored relative to the .blend, so they
// resolve somewhere else entirely once a file is uploaded, and every scene
// would look broken. Packed files are skipped because packing is the fix being
// asked for.
const SCRIPT = `import bpy, os, json


def referenced():
    data = bpy.data

    for image in data.images:
        if image.source in {'FILE', 'SEQUENCE', 'MOVIE', 'TILED'}:
            yield image

    for group in (data.libraries, data.sounds, data.movieclips, data.volumes,
                  data.cache_files, data.fonts):
        for block in group:
            yield block


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
def unbaked():
    for obj in bpy.data.objects:
        for mod in obj.modifiers:
            cache = getattr(mod, 'point_cache', None)

            if mod.show_render and cache is not None and not cache.is_baked:
                yield '%s (%s)' % (obj.name, mod.type.replace('_', ' ').lower())

        for system in getattr(obj, 'particle_systems', []):
            if not system.point_cache.is_baked:
                yield '%s (particles)' % obj.name

    world = bpy.context.scene.rigidbody_world

    if world is not None and not world.point_cache.is_baked:
        yield 'the scene (rigid body)'


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
        missing.append(resolved)

print('${MARKER}' + json.dumps({
    'missing': sorted(set(missing)),
    'unpacked': sorted(set(unpacked)),
    'unbaked': sorted(set(unbaked())),
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
function readBlend(blendPath) {
  const next = queued.then(() => openScene(blendPath));

  queued = next.catch(() => {});

  return next;
}

// What would make this scene render wrongly rather than not at all: files it
// reaches for and did not bring, files only this machine can see, and
// simulations nobody has baked. Anything that goes wrong with the check itself
// lets the job through: a broken preflight must not be able to stop the farm.
export function checkScene(blendPath) {
  return readBlend(blendPath).then(report => ({
    checked: report !== null,
    missing: report?.missing ?? [],
    unpacked: report?.unpacked ?? [],
    unbaked: report?.unbaked ?? []
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

function openScene(blendPath) {
  return new Promise(resolve => {
    const blender = findBlenderExecutable();

    if (!blender) return resolve(null);

    const scriptPath = path.join(os.tmpdir(), `rendernet-preflight-${process.pid}.py`);
    fs.writeFileSync(scriptPath, SCRIPT);

    const probe = launch(blender, ['-b', blendPath, '-P', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe']
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

export function unbakedMessage(unbaked) {
  const shown = unbaked.slice(0, REPORTED);
  const rest = unbaked.length - shown.length;

  return `${unbaked.length} simulation${unbaked.length === 1 ? '' : 's'} in the scene `
    + `${unbaked.length === 1 ? 'has' : 'have'} no baked cache: `
    + `${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}. `
    + 'The farm renders frames side by side and out of order, which a simulation '
    + 'stepped as it renders cannot survive. In Blender: bake the cache, save, '
    + 'and upload again.';
}

export function missingAssetsMessage(missing) {
  const shown = missing.slice(0, REPORTED).map(file => path.basename(file));
  const rest = missing.length - shown.length;

  return `${missing.length} file${missing.length === 1 ? '' : 's'} the scene needs `
    + `${missing.length === 1 ? 'is' : 'are'} not packed into it and not on this machine: `
    + `${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}. `
    + 'In Blender: File → External Data → Pack Resources, save, and upload again.';
}
