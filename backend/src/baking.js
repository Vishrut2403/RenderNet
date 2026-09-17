import path from 'path';

const BAKE_DIR = 'bake';
const BAKED_SCENE = 'baked.blend';

export function bakedScenePath(job) {
  return path.join(job.outputFolder, BAKE_DIR, BAKED_SCENE);
}

export function fluidCachePath(job) {
  return path.join(job.outputFolder, BAKE_DIR, 'fluid');
}

export const BAKE_MARKER = 'RENDERNET_BAKED ';
export const AGAIN_MARKER = 'RENDERNET_BAKE_AGAIN';
export const UNBAKED_MARKER = 'RENDERNET_STILL_UNBAKED ';

export const CACHES_PYTHON = `
def cached_frames(cache):
    found = re.search(r'\\d+', cache.info or '')

    return int(found.group()) if found else None


def unusable(cache):
    if not cache.is_baked:
        return True

    return cached_frames(cache) == 0


def rendered_objects():
    seen = {}

    def take(obj):
        if obj.hide_render:
            return

        seen[obj.name_full] = obj
        group = obj.instance_collection

        if group is not None:
            for inside in group.all_objects:
                if not inside.hide_render:
                    seen[inside.name_full] = inside

    for obj in bpy.context.scene.objects:
        take(obj)

    for instance in bpy.context.evaluated_depsgraph_get().object_instances:
        take(instance.object.original)

    return seen.values()


def point_caches():
    for obj in rendered_objects():
        for mod in obj.modifiers:
            cache = getattr(mod, 'point_cache', None)

            if cache is not None and mod.show_render:
                yield obj, mod.type.replace('_', ' ').lower(), cache

        for system in getattr(obj, 'particle_systems', []):
            kind = system.settings.type

            if kind == 'HAIR':
                cloth = getattr(system, 'cloth', None)

                if system.use_hair_dynamics and cloth is not None:
                    yield obj, 'hair', cloth.point_cache

                continue

            if kind != 'EMITTER':
                continue

            yield obj, 'particles', system.point_cache


def simulation_zones(obj):
    for mod in obj.modifiers:
        if mod.type != 'NODES' or not mod.show_render:
            continue

        for item in getattr(mod, 'bakes', []):
            node = getattr(item, 'node', None)

            if node is not None and node.bl_idname == 'GeometryNodeSimulationOutput':
                yield mod
                break


def simulated_objects():
    for obj in rendered_objects():
        held = list(simulation_zones(obj))

        if held:
            yield obj, held


def fluid_domains():
    for obj in rendered_objects():
        for mod in obj.modifiers:
            if mod.type != 'FLUID' or not mod.show_render:
                continue

            settings = getattr(mod, 'domain_settings', None)

            if settings is not None:
                yield obj, settings


PARTICLE_FLAGS = ('use_spray_particles', 'use_foam_particles',
                  'use_bubble_particles', 'use_tracer_particles')


def fluid_parts(settings):
    yield 'data'

    gas = settings.domain_type == 'GAS'

    if gas and settings.use_noise:
        yield 'noise'

    if not gas and settings.use_mesh:
        yield 'mesh'

    if not gas and any(getattr(settings, flag, False) for flag in PARTICLE_FLAGS):
        yield 'particles'

    if settings.use_guide:
        yield 'guiding'


def fluid_frames(settings, part):
    folder = os.path.join(
        bpy.path.native_pathsep(bpy.path.abspath(settings.cache_directory)), part)

    found = set()

    try:
        names = os.listdir(folder)
    except OSError:
        return found

    for name in names:
        try:
            found.add(int(name.rsplit('_', 1)[-1].split('.')[0]))
        except ValueError:
            continue

    return found


def fluid_ready(settings, last, ignore=None):
    if last <= 0:
        return True

    for part in fluid_parts(settings):
        frames = fluid_frames(settings, part)

        if last not in frames:
            return False

        if ignore is not None and not frames - {ignore}:
            return False

    return True
`;

export const BAKE_SCRIPT = `import bpy, os, re
${CACHES_PYTHON}

LAST = int(os.environ['RENDERNET_BAKE_LAST'])
OUT = os.environ['RENDERNET_BAKE_OUT']
CACHES = os.environ['RENDERNET_BAKE_CACHE']
FILLING = os.environ.get('RENDERNET_BAKE_STAGE') == 'fill'


def stop(why):
    print('${UNBAKED_MARKER}' + why, flush=True)
    raise SystemExit(0)


def clamp(cache):
    if cache.frame_end > LAST:
        cache.frame_end = max(cache.frame_start, LAST)


def wants_baking(cache):
    return unusable(cache) or (cache.use_disk_cache and not cache.use_external)


def prepare(cache, may_move_it=True):
    if not wants_baking(cache):
        return

    if may_move_it and cache.use_disk_cache and not cache.use_external:
        cache.use_disk_cache = False

    clamp(cache)

    if cache.is_baked:
        with bpy.context.temp_override(point_cache=cache):
            bpy.ops.ptcache.free_bake()


def hair_short(cache):
    return (cached_frames(cache) or 0) < LAST - cache.frame_start + 1


def render_range(first):
    engine = scene.render.engine
    percent = scene.render.resolution_percentage
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_percentage = 5

    try:
        for number in range(first, LAST + 1):
            scene.frame_set(number)
            bpy.ops.render.render(write_still=False)
    finally:
        scene.render.engine = engine
        scene.render.resolution_percentage = percent


scene = bpy.context.scene

everything = list(point_caches())
caches = [entry for entry in everything if entry[1] != 'hair']
hair = [entry for entry in everything if entry[1] == 'hair' and hair_short(entry[2])]
fluids = [(obj, settings) for obj, settings in fluid_domains()
          if not fluid_ready(settings, LAST, scene.frame_current)]

if fluids and not FILLING:
    for obj, settings in fluids:
        settings.cache_directory = os.path.join(CACHES, re.sub(r'[^\\w.-]', '_', obj.name))

    for obj, label, cache in caches:
        prepare(cache)

    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=OUT, compress=True, relative_remap=False)
    print('${AGAIN_MARKER}', flush=True)
    raise SystemExit(0)

# Before the point caches, because baking those walks the range as well, and
# what is walked over is filled by stepping rather than by rendering. Filled
# first, everything after it reads what is already there.
replay = [(obj, settings) for obj, settings in fluids if settings.cache_type == 'REPLAY']

if replay or hair:
    starts = [settings.cache_frame_start for _, settings in replay]
    starts += [cache.frame_start for _, _, cache in hair]
    render_range(min(starts))

for obj, settings in fluids:
    if settings.cache_type != 'REPLAY':
        with bpy.context.temp_override(scene=scene, active_object=obj, object=obj):
            bpy.ops.fluid.bake_all()

short = [obj.name for obj, settings in fluids if not fluid_ready(settings, LAST)]
short += [obj.name for obj, _, cache in hair if hair_short(cache)]

if short:
    stop('%s came back without frames to render from' % ', '.join(short))

for obj, label, cache in caches:
    prepare(cache)

world = bpy.context.scene.rigidbody_world

if world is not None:
    # Blender 5.1 segfaults on writing use_disk_cache here, so this is the one
    # cache that cannot be moved into the file.
    if world.point_cache.use_disk_cache and not world.point_cache.use_external:
        stop("the rigid body cache is kept on disk, where it cannot travel with "
             "the scene. Turn Disk Cache off in Blender and upload again")

    prepare(world.point_cache, may_move_it=False)

bpy.ops.ptcache.bake_all(bake=True)

# Baking everything leaves hair dynamics alone, so whatever is still empty is
# baked on its own.
for obj, label, cache in caches:
    if unusable(cache):
        with bpy.context.temp_override(object=obj, active_object=obj, point_cache=cache):
            bpy.ops.ptcache.bake(bake=True)

for obj, mods in simulated_objects():
    for mod in mods:
        # Into the file rather than a folder beside it, for the same reason a
        # point cache is: the baked scene has to be one thing to send.
        mod.bake_target = 'PACKED'

    with bpy.context.temp_override(scene=scene, active_object=obj, object=obj,
                                   selected_objects=[obj]):
        done = bpy.ops.object.simulation_nodes_cache_bake(selected=True)

    if 'FINISHED' not in done:
        stop("%s has a simulation the farm could not bake" % obj.name)

left = [cache for _, _, cache in caches if unusable(cache)]

if world is not None and unusable(world.point_cache):
    left.append(world.point_cache)

if left:
    stop('%d of the caches in this scene came back with nothing in them' % len(left))

# No .blend1 beside it: a second copy of the scene against the same quota.
bpy.context.preferences.filepaths.save_version = 0

# Paths are left exactly as they were: a file the artist handed over is remapped
# at render time by the path this scene stores, and saving into another folder
# would rewrite the very string that mapping is keyed on.
bpy.ops.wm.save_as_mainfile(filepath=OUT, compress=True, relative_remap=False)
print('${BAKE_MARKER}' + str(os.path.getsize(OUT)), flush=True)
`;
