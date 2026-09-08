// What an uploaded scene says about itself before anybody has typed a frame
// range: the settings the form is offered, the ones it is not, and what
// happens when the file cannot be read at all. Nothing renders here.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  signUp, login, auth, createFakeBlender, createFixtureBlend, blenderAvailable
} from './helpers.mjs';

const PORT = 5614;
const SIZE = 2048;

async function open(base, token, filename, size = SIZE) {
  const res = await fetch(`${base}/upload/session`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, size })
  });

  return { status: res.status, body: await res.json() };
}

async function send(base, token, uploadId, bytes, offset = 0) {
  const res = await fetch(`${base}/upload/session/${uploadId}?offset=${offset}`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
    body: bytes
  });

  return { status: res.status, body: await res.json() };
}

async function inspect(base, token, uploadId) {
  const res = await fetch(`${base}/upload/session/${uploadId}/inspect`, {
    method: 'POST',
    headers: auth(token)
  });

  return { status: res.status, body: await res.json() };
}

// Opened, sent in full, and left waiting for its settings.
async function arrive(base, token, filename) {
  const started = await open(base, token, filename);
  await send(base, token, started.body.uploadId, Buffer.alloc(SIZE, 7));

  return started.body.uploadId;
}

// Closed again afterwards: only three uploads may be open at once, and these
// are read rather than submitted.
async function read(base, token, filename) {
  const uploadId = await arrive(base, token, filename);
  const report = await inspect(base, token, uploadId);

  await fetch(`${base}/upload/session/${uploadId}`, { method: 'DELETE', headers: auth(token) });

  return report.body;
}

function openings(sandbox, name) {
  const log = path.join(sandbox, 'uploads', 'readings.txt');

  if (!fs.existsSync(log)) return 0;

  return fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes(name)).length;
}

export default async function run() {
  const results = createResults('scene reading');
  const sandbox = makeSandbox('scene-reading');

  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SLOTS: '0' }
    });

    const { base } = server;

    await signUp(base, 'modeller', 'modeller-password');
    await signUp(base, 'onlooker', 'onlooker-password');
    const modeller = await login(base, 'modeller', 'modeller-password');
    const onlooker = await login(base, 'onlooker', 'onlooker-password');

    console.log('\n  What the scene already says');

    const plain = await read(base, modeller, 'plain.blend');

    results.check('a scene that has arrived can be read',
      plain.read === true, JSON.stringify(plain));

    results.check('and gives the frame range it was saved with',
      plain.settings.frameStart === 1 && plain.settings.frameEnd === 250,
      JSON.stringify(plain.settings));

    results.check('its engine, resolution and samples',
      plain.settings.renderEngine === 'CYCLES'
      && plain.settings.resolutionPercent === 50
      && plain.settings.samples === 128,
      JSON.stringify(plain.settings));

    results.check('the format it writes',
      plain.settings.format === 'OPEN_EXR', String(plain.settings.format));

    results.check('and the camera it would render through',
      plain.settings.camera === 'Camera', String(plain.settings.camera));

    console.log('\n  What the farm cannot offer');

    const exotic = await read(base, modeller, 'exotic.blend');

    results.check('an engine this farm does not run is left out rather than suggested',
      exotic.read === true && exotic.settings.renderEngine === null,
      JSON.stringify(exotic.settings));

    results.check('a format it does not write, likewise',
      exotic.settings.format === null, String(exotic.settings.format));

    results.check('and samples are left out with the engine they belong to',
      exotic.settings.samples === null, String(exotic.settings.samples));

    results.check('while the frame range still comes back',
      exotic.settings.frameEnd === 250, String(exotic.settings.frameEnd));

    console.log('\n  Scenes, cameras and steps');

    const several = await read(base, modeller, 'two-scenes.blend');

    results.check('every scene in the file is named',
      several.scenes.join(',') === 'Backdrop,Scene', JSON.stringify(several.scenes));

    results.check('and the settings come from the one that would render',
      several.active === 'Scene' && several.settings.frameEnd === 250,
      `${several.active}, ${several.settings.frameEnd}`);

    const cameraless = await read(base, modeller, 'cameraless.blend');

    results.check('a scene with no camera says so',
      cameraless.read === true && cameraless.settings.camera === null,
      JSON.stringify(cameraless.settings));

    const stepped = await read(base, modeller, 'stepped.blend');

    results.check('a frame step is reported rather than silently dropped',
      stepped.settings.frameStep === 3, String(stepped.settings.frameStep));

    console.log('\n  When it cannot be read');

    const unreadable = await read(base, modeller, 'unreadable.blend');

    results.check('a scene Blender says nothing about is unread, not an error',
      unreadable.read === false && unreadable.settings === null,
      JSON.stringify(unreadable));

    const half = await open(base, modeller, 'half.blend');
    await send(base, modeller, half.body.uploadId, Buffer.alloc(SIZE / 2, 7));
    const early = await inspect(base, modeller, half.body.uploadId);

    results.check('an upload still arriving cannot be read',
      early.status === 409, `${early.status} ${JSON.stringify(early.body)}`);

    const mine = await arrive(base, modeller, 'private.blend');
    const peek = await inspect(base, onlooker, mine);

    results.check('nor can somebody else\'s upload', peek.status === 404, String(peek.status));

    const overlong = await open(base, modeller, `${'a'.repeat(120)}.blend`);

    results.check('and a filename too long for the disk is refused before the bytes',
      overlong.status === 400, `${overlong.status} ${JSON.stringify(overlong.body)}`);

    console.log('\n  What reading it costs');

    const twice = await arrive(base, modeller, 'counted-once.blend');
    await inspect(base, modeller, twice);
    await inspect(base, modeller, twice);

    results.check('asking twice opens Blender once',
      openings(sandbox, 'counted-once') === 1, String(openings(sandbox, 'counted-once')));

    const queued = await fetch(`${base}/upload/session/${twice}/finish`, {
      method: 'POST',
      headers: { ...auth(modeller), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frameStart: '1', frameEnd: '4', renderEngine: 'CYCLES', skipAssetCheck: '1'
      })
    });
    const job = await queued.json();

    results.check('and the job is queued from the bytes already sent',
      queued.status === 200 && Number.isInteger(job.jobId), JSON.stringify(job));
  } finally {
    if (server) await stopServer(server);
    removeSandbox(sandbox);
  }

  await whatBlenderActuallySays(results);

  return results;
}

// Everything above answers a stand-in that makes the report up. The report is
// really produced by a Python script inside Blender, and nothing else here ever
// runs it - so a change to that script could go in inert and the suite would
// stay green.
async function whatBlenderActuallySays(results) {
  const names = ['a texture the scene did not bring is missing',
    'one it did bring but did not pack is named apart',
    'and a simulation with no cache is named too',
    'a cache baked into the file is left alone',
    'but one baked to disk and left behind counts as unbaked',
    'and one baked only part of the way is left alone as well',
    'a simulation in a scene nobody renders is nobody\'s problem',
    'and one linked from another file is named as one to bake there',
    'so is one on an object switched off in the viewport',
    'while one inside an instanced collection is baked like any other',
    'a fluid whose frames did not come with the file is asked for',
    'and one whose frames are here is left alone',
    'a domain still wants the noise pass it was set up to use',
    'and a geometry nodes simulation is baked whether or not it says it needs it'];

  if (!blenderAvailable()) {
    for (const name of names) results.skipped(name, 'Blender not installed');
    return;
  }

  const box = makeSandbox('preflight-real');

  try {
    console.log('\n  What Blender itself reports about a scene');

    const onDisk = path.join(box, 'floor.png');
    fs.writeFileSync(onDisk, Buffer.alloc(64, 7));

    // Textures need a user or Blender drops them when the file is saved, so
    // each one goes on a material of its own.
    const blend = createFixtureBlend(box, {
      name: 'checked.blend',
      extra: `
def textured(name, filepath, x):
    bpy.ops.mesh.primitive_plane_add(location=(x, 0, 0))
    obj = bpy.context.object
    obj.name = name
    material = bpy.data.materials.new(name + 'Mat')
    material.use_nodes = True
    node = material.node_tree.nodes.new('ShaderNodeTexImage')
    image = bpy.data.images.new(name + 'Img', 8, 8)
    image.source = 'FILE'
    image.filepath = filepath
    node.image = image
    obj.data.materials.append(material)
    return obj

flag = textured('Flag', r'${onDisk}', 0)
flag.modifiers.new('Cloth', 'CLOTH')
textured('Wall', r'${path.join(box, 'nowhere', 'gone.png')}', 3)
`
    });

    const { checkScene } = await import('../src/preflight.js');
    const report = await checkScene(blend);
    // A missing file is reported as what the scene stores and where that led,
    // so it can be replaced; one that is merely unpacked is still just a path.
    const named = list =>
      list.map(entry => (typeof entry === 'string' ? path.basename(entry) : entry.name));

    results.check(names[0], named(report.missing).join(',') === 'gone.png',
      JSON.stringify(named(report.missing)));
    results.check(names[1], named(report.unpacked).join(',') === 'floor.png',
      JSON.stringify(named(report.unpacked)));
    results.check(names[2], report.unbaked.some(what => what.includes('cloth')),
      JSON.stringify(report.unbaked));

    // Baked to disk, which puts the frames in a folder beside the .blend rather
    // than inside it. Blender says the cache is baked either way, so the only
    // thing that tells them apart is how much it says it is holding.
    const beside = path.join(box, 'cached', 'diskcached.blend');

    fs.mkdirSync(path.dirname(beside), { recursive: true });

    const cached = createFixtureBlend(path.dirname(beside), {
      name: 'diskcached.blend',
      extra: `
bpy.context.scene.frame_end = 4
bpy.ops.mesh.primitive_grid_add(size=2, location=(0, 0, 2))
grid = bpy.context.object
grid.modifiers.new('Cloth', 'CLOTH')
cache = grid.modifiers['Cloth'].point_cache

# Saved first: a cache on disk is written beside the file, so it needs a path.
bpy.ops.wm.save_as_mainfile(filepath=r'${beside}')
cache.use_disk_cache = True
cache.frame_end = 4

with bpy.context.temp_override(object=grid, point_cache=cache):
    bpy.ops.ptcache.bake(bake=True)
`
    });

    const here = await checkScene(cached);

    results.check(names[3], here.unbaked.length === 0, JSON.stringify(here.unbaked));

    // Only the .blend travels: the folder of frames stays on the machine that
    // baked it, which is what an upload of one file amounts to.
    const alone = path.join(box, 'uploaded.blend');

    fs.copyFileSync(cached, alone);

    const orphaned = await checkScene(alone);

    results.check(names[4], orphaned.unbaked.some(what => what.includes('cloth')),
      JSON.stringify(orphaned.unbaked));

    // Baked to frame 4 of a longer scene. Blender holds a baked cache at its
    // last frame rather than stepping past it, and holds it in every launch on
    // every machine, so the farm renders those frames exactly as the artist's
    // own Blender does. Baking it further would render something they never saw.
    const short = createFixtureBlend(box, {
      name: 'shortbake.blend',
      extra: `
bpy.context.scene.frame_end = 12
bpy.ops.mesh.primitive_grid_add(size=2, location=(0, 0, 2))
grid = bpy.context.object
grid.modifiers.new('Cloth', 'CLOTH')
cache = grid.modifiers['Cloth'].point_cache
cache.frame_end = 4

with bpy.context.temp_override(object=grid, point_cache=cache):
    bpy.ops.ptcache.bake(bake=True)
`
    });

    const partly = await checkScene(short);

    results.check(names[5], partly.unbaked.length === 0, JSON.stringify(partly.unbaked));

    // Blender bakes the caches of one scene, and the one that renders is the
    // one the form was filled in from. A sim in another scene of the same file
    // would otherwise be asked for and never delivered.
    const aside = createFixtureBlend(box, {
      name: 'twoscenes.blend',
      extra: `
# Held on to: bpy.data.scenes is ordered by name, so the one that renders is
# not whichever happens to be first once another has been added.
rendered = bpy.context.scene
elsewhere = bpy.data.scenes.new('Elsewhere')
bpy.context.window.scene = elsewhere
bpy.ops.mesh.primitive_grid_add(size=2, location=(0, 0, 2))
bpy.context.object.modifiers.new('Cloth', 'CLOTH')
bpy.context.window.scene = rendered
`
    });

    const other = await checkScene(aside);

    results.check(names[6], other.unbaked.length === 0, JSON.stringify(other.unbaked));

    // A cache belongs to the file its object came from. Bake a linked one here
    // and the frames in memory are never written into the scene that links it,
    // so it reads as unbaked again the moment that scene is reopened.
    const library = createFixtureBlend(box, {
      name: 'library.blend',
      extra: `
bpy.ops.mesh.primitive_grid_add(size=2, location=(0, 0, 2))
bpy.context.object.name = 'Borrowed'
bpy.context.object.modifiers.new('Cloth', 'CLOTH')
`
    });

    const links = createFixtureBlend(box, {
      name: 'links.blend',
      extra: `
bpy.ops.wm.link(filepath=r'${library}' + '/Object/Borrowed',
                directory=r'${library}' + '/Object/', filename='Borrowed')
`
    });

    const linked = await checkScene(links);

    results.check(names[7],
      linked.unbakeable.some(entry => entry.name.includes('Borrowed') && entry.why === 'linked')
        && linked.unbaked.length === 0,
      `${JSON.stringify(linked.unbakeable)} / ${JSON.stringify(linked.unbaked)}`);

    // Switched off in the viewport and rendered anyway, which is how a heavy
    // simulation is worked with. Blender bakes nothing for it, and stepping it
    // as the frames render gives a picture of its own, so it is sent back.
    const tucked = createFixtureBlend(box, {
      name: 'tucked.blend',
      extra: `
bpy.ops.mesh.primitive_grid_add(size=2, location=(0, 0, 2))
grid = bpy.context.object
grid.name = 'Tucked'
grid.modifiers.new('Cloth', 'CLOTH')
grid.hide_viewport = True
`
    });

    const offscreen = await checkScene(tucked);

    results.check(names[8],
      offscreen.unbakeable.some(entry => entry.name.includes('Tucked') && entry.why === 'hidden')
        && offscreen.unbaked.length === 0,
      `${JSON.stringify(offscreen.unbakeable)} / ${JSON.stringify(offscreen.unbaked)}`);

    // Inside a collection the scene only instances: it renders, so it counts,
    // even though the scene's own object list names the empty and not the cloth.
    const instanced = createFixtureBlend(box, {
      name: 'instanced.blend',
      extra: `
group = bpy.data.collections.new('Flags')
bpy.ops.mesh.primitive_grid_add(size=2, location=(0, 0, 2))
inside = bpy.context.object
inside.name = 'Instanced'
inside.modifiers.new('Cloth', 'CLOTH')
# Out of whatever collection it landed in: the startup file nests one inside
# the scene's own, so this is not always the scene collection.
for holding in list(inside.users_collection):
    holding.objects.unlink(inside)

group.objects.link(inside)
bpy.ops.object.collection_instance_add(collection='Flags', location=(0, 0, 0))
`
    });

    const brought = await checkScene(instanced);

    results.check(names[9], brought.unbaked.some(what => what.includes('Instanced')),
      JSON.stringify(brought.unbaked));

    // Smoke keeps its frames in a folder the scene names, and that name is the
    // artist's own machine - Blender's default is a directory under /tmp. So
    // what counts is files on this disk for the frames being rendered, not the
    // domain's own idea of whether it has been baked.
    const fluidCache = path.join(box, 'smokecache');

    const smoke = createFixtureBlend(box, {
      name: 'smoke.blend',
      extra: `
bpy.context.scene.frame_end = 8
bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 2))
domain = bpy.context.object
domain.name = 'Domain'
fluid = domain.modifiers.new('Fluid', 'FLUID')
fluid.fluid_type = 'DOMAIN'
fluid.domain_settings.resolution_max = 16
fluid.domain_settings.cache_directory = r'${fluidCache}'
`
    });

    const wanted = await checkScene(smoke, null, 8);

    results.check(names[10],
      wanted.fluids.includes('Domain') && wanted.unbaked.some(what => what.includes('Domain')),
      `${JSON.stringify(wanted.fluids)} / ${JSON.stringify(wanted.unbaked)}`);

    // The frames themselves, without the minutes of simulation that would write
    // them: what the check reads is the folder.
    const frames = path.join(fluidCache, 'data');

    fs.mkdirSync(frames, { recursive: true });

    for (let number = 1; number <= 8; number++) {
      fs.writeFileSync(path.join(frames, `fluid_data_000${number}.vdb`), 'frame');
    }

    const held = await checkScene(smoke, null, 8);

    results.check(names[11], held.fluids.length === 0, JSON.stringify(held.fluids));

    // A domain writes a folder per kind of frame it makes, and the render needs
    // every one it was set up to use. Noise is a second pass over the base
    // simulation, and a scene missing it renders the smoke without it.
    const noisy = createFixtureBlend(box, {
      name: 'noisy.blend',
      extra: `
bpy.context.scene.frame_end = 8
bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 2))
domain = bpy.context.object
domain.name = 'Domain'
fluid = domain.modifiers.new('Fluid', 'FLUID')
fluid.fluid_type = 'DOMAIN'
fluid.domain_settings.resolution_max = 16
fluid.domain_settings.use_noise = True
fluid.domain_settings.cache_directory = r'${fluidCache}'
`
    });

    const withoutNoise = await checkScene(noisy, null, 8);

    results.check(names[12], withoutNoise.fluids.includes('Domain'),
      JSON.stringify(withoutNoise.fluids));

    // Nothing a simulation zone exposes says whether it holds baked frames -
    // the bake items read the same either way - so one is always baked, and a
    // scene with one always reports it.
    const stepping = createFixtureBlend(box, {
      name: 'stepping.blend',
      extra: `
bpy.ops.mesh.primitive_cube_add(size=1)
stepper = bpy.context.object
stepper.name = 'Stepper'
group = bpy.data.node_groups.new('Sim', 'GeometryNodeTree')
group.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
group.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
into = group.nodes.new('NodeGroupInput')
outof = group.nodes.new('NodeGroupOutput')
opens = group.nodes.new('GeometryNodeSimulationInput')
closes = group.nodes.new('GeometryNodeSimulationOutput')
opens.pair_with_output(closes)
group.links.new(into.outputs['Geometry'], opens.inputs['Geometry'])
group.links.new(opens.outputs['Geometry'], closes.inputs['Geometry'])
group.links.new(closes.outputs['Geometry'], outof.inputs['Geometry'])
stepper.modifiers.new('GN', 'NODES').node_group = group
`
    });

    const zoned = await checkScene(stepping, null, 20);

    results.check(names[13], zoned.unbaked.some(what => what.includes('Stepper')),
      JSON.stringify(zoned.unbaked));
  } finally {
    removeSandbox(box);
  }
}
