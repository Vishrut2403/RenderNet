import fs from 'fs';
import os from 'os';
import path from 'path';
import { launch, terminate } from './utils/process-control.js';
import { findBlenderExecutable } from './utils/blender-check.js';
import { REFERENCED_PYTHON, SUPPLIED_PYTHON } from './scene-references.js';
import { CACHES_PYTHON } from './baking.js';

const MARKER = 'RENDERNET_PREFLIGHT ';
const TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 120 * 1000;

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


def named(obj, label):
    return '%s (%s)' % (obj.name, label)


LAST_FRAME = int(os.environ.get('RENDERNET_LAST_FRAME', 0))
OPENED_ON = bpy.context.scene.frame_current


def why_not_here(obj):
    if obj.library is not None:
        return 'linked'

    if obj.hide_viewport:
        return 'hidden'

    return None


def unbaked():
    for obj, label, cache in point_caches():
        if unusable(cache) and why_not_here(obj) is None:
            yield named(obj, label)

    for obj, settings in fluid_domains():
        if not fluid_ready(settings, LAST_FRAME, OPENED_ON) and why_not_here(obj) is None:
            yield '%s (%s)' % (obj.name, settings.domain_type.lower())

    for obj, mods in simulated_objects():
        if why_not_here(obj) is None:
            yield '%s (simulation nodes)' % obj.name

    world = bpy.context.scene.rigidbody_world

    if world is not None and unusable(world.point_cache):
        yield 'the scene (rigid body)'


def unbakeable():
    for obj, label, cache in point_caches():
        why = why_not_here(obj)

        if unusable(cache) and why is not None:
            yield {'name': named(obj, label), 'why': why}

    for obj, settings in fluid_domains():
        why = why_not_here(obj)

        if not fluid_ready(settings, LAST_FRAME, OPENED_ON) and why is not None:
            yield {'name': '%s (%s)' % (obj.name, settings.domain_type.lower()), 'why': why}


def fluids_wanted():
    return [obj.name for obj, settings in fluid_domains()
            if not fluid_ready(settings, LAST_FRAME, OPENED_ON) and why_not_here(obj) is None]


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

    if os.path.exists(resolved):
        unpacked.append(resolved)
    else:
        missing.append({'stored': stored, 'resolved': resolved})

def scripted_drivers():
    wanted = set()

    def look(holder, name):
        animation = getattr(holder, 'animation_data', None)

        for channel in getattr(animation, 'drivers', None) or []:
            driver = channel.driver

            if driver.type == 'SCRIPTED' and not driver.is_simple_expression:
                wanted.add('%s: %s' % (name, driver.expression))

    for attribute in dir(bpy.data):
        try:
            collection = getattr(bpy.data, attribute)
        except Exception:
            continue

        if not isinstance(collection, bpy.types.bpy_prop_collection):
            continue

        for block in collection:
            if not isinstance(block, bpy.types.ID):
                continue

            look(block, block.name)

            look(getattr(block, 'node_tree', None), block.name)

    return wanted


print('${MARKER}' + json.dumps({
    'scriptedDrivers': sorted(scripted_drivers()),
    'missing': sorted({item['stored']: item for item in missing}.values(),
                      key=lambda item: item['resolved']),
    'unpacked': sorted(set(unpacked)),
    'unbaked': sorted(set(unbaked())),
    'unbakeable': sorted(unbakeable(), key=lambda entry: entry['name']),
    'fluids': sorted(fluids_wanted()),
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

function readBlend(blendPath, supplied, lastFrame) {
  const next = queued.then(() => openScene(blendPath, supplied, lastFrame));

  queued = next.catch(() => {});

  return next;
}

function asDependency(entry) {
  return typeof entry === 'string'
    ? { stored: entry, resolved: entry, name: basename(entry) }
    : { ...entry, name: basename(entry.stored ?? entry.resolved ?? '') };
}

function basename(file) {
  return String(file).split(/[\\/]/).pop();
}

export function checkScene(blendPath, supplied = null, lastFrame = 0) {
  return readBlend(blendPath, supplied, lastFrame).then(report => ({
    checked: report !== null,
    missing: (report?.missing ?? []).map(asDependency),
    unpacked: report?.unpacked ?? [],
    unbaked: report?.unbaked ?? [],
    unbakeable: report?.unbakeable ?? [],
    fluids: report?.fluids ?? [],
    scriptedDrivers: report?.scriptedDrivers ?? []
  }));
}

export function readScene(blendPath) {
  return readBlend(blendPath).then(report => (report === null
    ? { read: false, active: null, scenes: [], unbaked: [], scriptedDrivers: [] }
    : {
      read: true,
      active: report.active ?? null,
      scenes: report.scenes ?? [],
      unbaked: report.unbaked ?? [],
      scriptedDrivers: report.scriptedDrivers ?? []
    }));
}

function openScene(blendPath, supplied = null, lastFrame = 0) {
  return new Promise(resolve => {
    const blender = findBlenderExecutable();

    if (!blender) return resolve(null);

    const scriptPath = path.join(os.tmpdir(), `rendernet-preflight-${process.pid}.py`);

    try {
      fs.writeFileSync(scriptPath, SCRIPT);
    } catch {
      return resolve(null);
    }

    const probe = launch(blender, ['-b', blendPath, '--disable-autoexec', '-P', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RENDERNET_ASSETS: supplied ?? '',
        RENDERNET_LAST_FRAME: String(lastFrame || 0)
      }
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

