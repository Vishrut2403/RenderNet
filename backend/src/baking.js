import path from 'path';

const BAKE_DIR = 'bake';
const BAKED_SCENE = 'baked.blend';

// Under the job's own folder rather than in the scene store: a bake belongs to
// the job that asked for it and dies with it. In a folder of its own for the
// same reason a tiled still keeps its regions in one - what the artist is
// handed back is the frames.
export function bakedScenePath(job) {
  return path.join(job.outputFolder, BAKE_DIR, BAKED_SCENE);
}

export const BAKE_MARKER = 'RENDERNET_BAKED ';
export const UNBAKED_MARKER = 'RENDERNET_STILL_UNBAKED ';

// Shared by the check and the bake, so that what one calls unbaked is what the
// other bakes. A cache baked to disk keeps its frames in a folder beside the
// .blend rather than inside it, and uploading the scene on its own leaves them
// behind - Blender still says the cache is baked, and says '0 frames on disk'
// in the same breath. The count is the only thing that tells the two apart.
export const CACHES_PYTHON = `
def cached_frames(cache):
    found = re.search(r'\\d+', cache.info or '')

    return int(found.group()) if found else None


def unusable(cache):
    if not cache.is_baked:
        return True

    return cached_frames(cache) == 0


# What renders, which is neither the whole file nor either list on its own. The
# scene's objects miss what an instanced collection brings in; the dependency
# graph is evaluated for the viewport, so it misses an object hidden there and
# rendered anyway. Between them nothing that renders is left out, and another
# scene's simulations still are.
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
                yield obj, mod, cache

        for system in getattr(obj, 'particle_systems', []):
            yield obj, None, system.point_cache
`;

export const BAKE_SCRIPT = `import bpy, os, re
${CACHES_PYTHON}

LAST = int(os.environ['RENDERNET_BAKE_LAST'])
OUT = os.environ['RENDERNET_BAKE_OUT']


def stop(why):
    print('${UNBAKED_MARKER}' + why, flush=True)
    raise SystemExit(0)


# No further than the job goes: a cache set to 250 frames must not cost the
# evening when 24 are being rendered. Never shortened past its own start, and
# never lengthened - a cache the artist baked to frame 4 holds there in their
# Blender too, so carrying it further would render something they never saw.
def clamp(cache):
    if cache.frame_end > LAST:
        cache.frame_end = max(cache.frame_start, LAST)


# Frames written beside the .blend cannot travel with the copy this bake saves,
# so a cache kept on disk is baked into the file even when it is holding them.
def wants_baking(cache):
    return unusable(cache) or (cache.use_disk_cache and not cache.use_external)


# Blender bakes nothing for a cache that still says it is baked, so one holding
# no frames has to be let go of before it will be baked again.
def prepare(cache, may_move_it=True):
    if not wants_baking(cache):
        return

    if may_move_it and cache.use_disk_cache and not cache.use_external:
        cache.use_disk_cache = False

    clamp(cache)

    if cache.is_baked:
        with bpy.context.temp_override(point_cache=cache):
            bpy.ops.ptcache.free_bake()


# Listed before anything is touched: preparing a cache changes what the
# dependency graph the walk reads would say.
caches = list(point_caches())

for obj, mod, cache in caches:
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
