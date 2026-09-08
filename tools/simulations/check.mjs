#!/usr/bin/env node
// Every kind of simulation Blender can run, rendered twice: the way the artist
// would render it - the whole range in one Blender - and the way the farm does,
// which is to bake or fill the scene first and then render one frame of it on
// its own. The two have to come out the same, and a difference here is the farm
// delivering a picture nobody would get at home.
//
// It builds its own scenes, drives the checking and baking the farm really uses,
// and needs Blender itself, so it is not part of the test suite: it takes
// minutes and it is what to run after the workstation's Blender is upgraded,
// since most of what it covers is behaviour Blender never promised.
//
//   node tools/simulations/check.mjs            every scene
//   node tools/simulations/check.mjs hair gas   only those
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..', '..', 'backend', 'src');

const { checkScene } = await import(path.join(BACKEND, 'preflight.js'));
const { BAKE_SCRIPT, AGAIN_MARKER, BAKE_MARKER, UNBAKED_MARKER } =
  await import(path.join(BACKEND, 'baking.js'));
const { findBlenderExecutable } = await import(path.join(BACKEND, 'utils', 'blender-check.js'));

const BLENDER = findBlenderExecutable();

if (!BLENDER) {
  console.error('Blender is not on PATH and BLENDER_PATH is unset');
  process.exit(2);
}

const WORK = process.env.SIMULATION_CHECK_DIR
  || path.join(os.tmpdir(), 'rendernet-simulations');

// The last frame is the one compared: a simulation is furthest from its
// starting state there, so it is where getting it wrong shows most.
const SCENES = {
  cloth: 24,
  softbody: 24,
  hair: 24,
  particles: 24,
  gas: 8,
  gasnoise: 8,
  liquid: 6,
  paint: 12,
  ocean: 20,
  gnsim: 20,
  mixed: 8
};

const BUILD = `import bpy, math, os, sys
here = os.environ['WORK'] + os.sep
kind = os.environ['KIND']

def stage(frames):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, frames
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 200
    bpy.ops.object.camera_add(location=(7, -7, 5), rotation=(math.radians(63), 0, math.radians(45)))
    scene.camera = bpy.context.object
    bpy.ops.object.light_add(type='SUN', location=(3, -3, 9))
    bpy.context.object.data.energy = 5
    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, -1.2))
    return scene
if kind == 'softbody':
    scene = stage(24)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 3))
    blob = bpy.context.object
    blob.name = 'Blob'
    soft = blob.modifiers.new('Soft', 'SOFT_BODY')
    blob.soft_body.use_goal = False
    blob.soft_body.mass = 2

elif kind == 'hair':
    scene = stage(24)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 2))
    head = bpy.context.object
    head.name = 'Head'
    system = head.modifiers.new('Hair', 'PARTICLE_SYSTEM')
    settings = head.particle_systems[0].settings
    settings.type = 'HAIR'
    settings.count = 200
    settings.hair_length = 1.5
    head.particle_systems[0].use_hair_dynamics = True

elif kind == 'particles':
    scene = stage(24)
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.15, location=(20, 0, 0))
    bit = bpy.context.object
    bit.name = 'Bit'
    bpy.ops.mesh.primitive_cube_add(size=1.5, location=(0, 0, 4))
    emitter = bpy.context.object
    emitter.name = 'Fountain'
    emitter.modifiers.new('Particles', 'PARTICLE_SYSTEM')
    settings = emitter.particle_systems[0].settings
    settings.count = 300
    settings.frame_end = 12
    settings.lifetime = 40
    settings.render_type = 'OBJECT'
    settings.instance_object = bit
    settings.particle_size = 1.0
    settings.physics_type = 'NEWTON'
    settings.normal_factor = 3.0

elif kind in ('gas', 'gasnoise', 'liquid'):
    scene = stage(8 if kind != 'liquid' else 6)
    bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 2))
    domain = bpy.context.object
    domain.name = 'Domain'
    fluid = domain.modifiers.new('Fluid', 'FLUID')
    fluid.fluid_type = 'DOMAIN'
    settings = fluid.domain_settings
    settings.resolution_max = 24
    settings.cache_frame_end = scene.frame_end
    settings.cache_directory = here + kind + '_cache'

    if kind == 'liquid':
        settings.domain_type = 'LIQUID'
        settings.use_mesh = True
        settings.use_spray_particles = True
        settings.use_foam_particles = True
    else:
        settings.domain_type = 'GAS'
        settings.use_noise = kind == 'gasnoise'
        material = bpy.data.materials.new('Smoke')
        material.use_nodes = True
        material.node_tree.nodes.clear()
        out = material.node_tree.nodes.new('ShaderNodeOutputMaterial')
        volume = material.node_tree.nodes.new('ShaderNodeVolumePrincipled')
        volume.inputs['Density'].default_value = 5.0
        material.node_tree.links.new(volume.outputs['Volume'], out.inputs['Volume'])
        domain.data.materials.append(material)

    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.5, location=(0, 0, 3 if kind == 'liquid' else 0.6))
    source = bpy.context.object
    source.name = 'Source'
    flow = source.modifiers.new('Fluid', 'FLUID')
    flow.fluid_type = 'FLOW'
    flow.flow_settings.flow_type = 'LIQUID' if kind == 'liquid' else 'SMOKE'
    flow.flow_settings.flow_behavior = 'GEOMETRY' if kind == 'liquid' else 'INFLOW'

elif kind == 'paint':
    scene = stage(12)
    bpy.ops.mesh.primitive_grid_add(size=6, x_subdivisions=40, y_subdivisions=40)
    canvas = bpy.context.object
    canvas.name = 'Canvas'
    canvas.modifiers.new('Paint', 'DYNAMIC_PAINT').ui_type = 'CANVAS'
    bpy.ops.dpaint.type_toggle(type='CANVAS')
    surface = canvas.modifiers['Paint'].canvas_settings.canvas_surfaces.active
    surface.frame_end = 12
    material = bpy.data.materials.new('Painted')
    material.use_nodes = True
    tree = material.node_tree
    colour = tree.nodes.new('ShaderNodeVertexColor')
    colour.layer_name = surface.output_name_a
    tree.links.new(colour.outputs['Color'], tree.nodes['Principled BSDF'].inputs['Base Color'])
    canvas.data.materials.append(material)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.7, location=(-3, 0, 0.2))
    brush = bpy.context.object
    brush.name = 'Brush'
    brush.modifiers.new('Paint', 'DYNAMIC_PAINT').ui_type = 'BRUSH'
    with bpy.context.temp_override(object=brush, active_object=brush):
        bpy.ops.dpaint.type_toggle(type='BRUSH')
    brush.keyframe_insert('location', frame=1)
    brush.location = (3, 0, 0.2)
    brush.keyframe_insert('location', frame=12)

elif kind == 'ocean':
    scene = stage(20)
    bpy.ops.mesh.primitive_plane_add(size=10, location=(0, 0, 1))
    sea = bpy.context.object
    sea.name = 'Sea'
    ocean = sea.modifiers.new('Ocean', 'OCEAN')
    ocean.use_foam = True
    ocean.foam_layer_name = 'foam'
    ocean.resolution = 8
    ocean.time = 0.0
    ocean.keyframe_insert('time', frame=1)
    ocean.time = 4.0
    ocean.keyframe_insert('time', frame=20)
    material = bpy.data.materials.new('Water')
    material.use_nodes = True
    tree = material.node_tree
    foam = tree.nodes.new('ShaderNodeVertexColor')
    foam.layer_name = 'foam'
    tree.links.new(foam.outputs['Color'], tree.nodes['Principled BSDF'].inputs['Base Color'])
    sea.data.materials.append(material)

elif kind == 'gnsim':
    scene = stage(20)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2, 0, 0.5))
    obj = bpy.context.object
    obj.name = 'Stepper'
    group = bpy.data.node_groups.new('Sim', 'GeometryNodeTree')
    group.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    group.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    start = group.nodes.new('NodeGroupInput')
    end = group.nodes.new('NodeGroupOutput')
    sim_in = group.nodes.new('GeometryNodeSimulationInput')
    sim_out = group.nodes.new('GeometryNodeSimulationOutput')
    sim_in.pair_with_output(sim_out)
    move = group.nodes.new('GeometryNodeTransform')
    move.inputs['Translation'].default_value = (0.15, 0, 0)
    links = group.links
    links.new(start.outputs['Geometry'], sim_in.inputs['Geometry'])
    links.new(sim_in.outputs['Geometry'], move.inputs['Geometry'])
    links.new(move.outputs['Geometry'], sim_out.inputs['Geometry'])
    links.new(sim_out.outputs['Geometry'], end.inputs['Geometry'])
    obj.modifiers.new('GN', 'NODES').node_group = group

elif kind == 'cloth':
    scene = stage(24)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 1))
    bpy.context.object.modifiers.new('Collision', 'COLLISION')
    bpy.ops.mesh.primitive_grid_add(size=4, x_subdivisions=24, y_subdivisions=24, location=(0, 0, 3))
    cloth = bpy.context.object
    cloth.name = 'Cloth'
    cloth.modifiers.new('Cloth', 'CLOTH')
    bpy.ops.mesh.primitive_cube_add(size=0.8, location=(2.5, 0, 4))
    bpy.ops.rigidbody.object_add()
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -1.15))
    bpy.ops.rigidbody.object_add()
    bpy.context.object.rigid_body.type = 'PASSIVE'

elif kind == 'mixed':
    scene = stage(8)
    # Cloth over a sphere, smoke beside it, and a simulation zone stepping past.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.8, location=(-3, 0, 1))
    bpy.context.object.modifiers.new('Collision', 'COLLISION')
    bpy.ops.mesh.primitive_grid_add(size=3, x_subdivisions=20, y_subdivisions=20,
                                    location=(-3, 0, 2.6))
    bpy.context.object.name = 'Cloth'
    bpy.context.object.modifiers.new('Cloth', 'CLOTH')

    bpy.ops.mesh.primitive_cube_add(size=3, location=(2, 0, 1.5))
    domain = bpy.context.object
    domain.name = 'Domain'
    fluid = domain.modifiers.new('Fluid', 'FLUID')
    fluid.fluid_type = 'DOMAIN'
    settings = fluid.domain_settings
    settings.domain_type = 'GAS'
    settings.resolution_max = 20
    settings.cache_frame_end = 8
    settings.cache_directory = here + 'mixed_cache'
    smoke = bpy.data.materials.new('Smoke')
    smoke.use_nodes = True
    smoke.node_tree.nodes.clear()
    out = smoke.node_tree.nodes.new('ShaderNodeOutputMaterial')
    volume = smoke.node_tree.nodes.new('ShaderNodeVolumePrincipled')
    volume.inputs['Density'].default_value = 5.0
    smoke.node_tree.links.new(volume.outputs['Volume'], out.inputs['Volume'])
    domain.data.materials.append(smoke)
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.4, location=(2, 0, 0.4))
    flow = bpy.context.object.modifiers.new('Fluid', 'FLUID')
    flow.fluid_type = 'FLOW'
    flow.flow_settings.flow_type = 'SMOKE'
    flow.flow_settings.flow_behavior = 'INFLOW'

    bpy.ops.mesh.primitive_cube_add(size=0.8, location=(0, 3, 0.5))
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
    move = group.nodes.new('GeometryNodeTransform')
    move.inputs['Translation'].default_value = (0.2, 0, 0)
    group.links.new(into.outputs['Geometry'], opens.inputs['Geometry'])
    group.links.new(opens.outputs['Geometry'], move.inputs['Geometry'])
    group.links.new(move.outputs['Geometry'], closes.inputs['Geometry'])
    group.links.new(closes.outputs['Geometry'], outof.inputs['Geometry'])
    stepper.modifiers.new('GN', 'NODES').node_group = group
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=here + kind + '.blend')
print('BUILT', kind)
`;

const RENDER = `import bpy, os
scene = bpy.context.scene
scene.render.image_settings.file_format = 'PNG'

for number in [int(n) for n in os.environ['FRAMES'].split(',')]:
    scene.frame_set(number)
    scene.render.filepath = os.environ['OUT'] + str(number).zfill(4)
    bpy.ops.render.render(write_still=True)
`;

const DIFF = `import bpy, numpy, os

def pixels(at):
    image = bpy.data.images.load(at)
    seen = numpy.array(image.pixels[:]).reshape(-1, 4)[:, :3]
    bpy.data.images.remove(image)
    return seen

apart = numpy.abs(pixels(os.environ['A']) - pixels(os.environ['B']))
print('DIFF %.8f %.4f' % (apart.max(), 100.0 * (apart.max(axis=1) > 0.01).mean()))
`;

function blender(args, env = {}) {
  return spawnSync(BLENDER, args, {
    cwd: WORK, encoding: 'utf8', timeout: 3600000, env: { ...process.env, ...env, WORK }
  });
}

function script(name, contents) {
  const at = path.join(WORK, name);
  fs.writeFileSync(at, contents);
  return at;
}

function render(scene, frames, out) {
  blender(['-b', scene, '-P', script('render.py', RENDER)],
    { FRAMES: frames.join(','), OUT: out });
}

function compare(a, b) {
  const said = blender(['-b', '--factory-startup', '-P', script('diff.py', DIFF)],
    { A: a, B: b }).stdout ?? '';
  const line = said.split('\n').find(text => text.startsWith('DIFF ')) ?? '';
  const [, most, share] = line.split(' ');

  return { most: Number(most), share: Number(share) };
}

// Only the .blend is uploaded, so anything a simulation left beside it stays on
// the machine that made it.
function hideCaches(kind) {
  for (const stray of fs.readdirSync(WORK)) {
    if (stray.startsWith(`${kind}_cache`) || stray.startsWith('blendcache_')) {
      fs.rmSync(path.join(WORK, stray), { recursive: true, force: true });
    }
  }
}

function uploaded(kind) {
  const folder = path.join(WORK, 'farm', kind);

  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });

  const at = path.join(folder, 'uploaded.blend');
  fs.copyFileSync(path.join(WORK, `${kind}.blend`), at);

  return { folder, at };
}

// What the worker does with a bake claim, in the same order and with the same
// scripts: a scene carrying a fluid is written out pointing at the job's folder
// and opened a second time to be filled.
function bake(kind, farm, last) {
  const out = path.join(farm.folder, 'baked.blend');
  const caches = path.join(farm.folder, 'fluid');
  const env = {
    RENDERNET_BAKE_LAST: String(last),
    RENDERNET_BAKE_OUT: out,
    RENDERNET_BAKE_CACHE: caches
  };

  const at = script('bake.py', BAKE_SCRIPT);
  let said = blender(['-b', farm.at, '-P', at], env).stdout ?? '';

  if (said.includes(AGAIN_MARKER)) {
    fs.rmSync(caches, { recursive: true, force: true });
    said = blender(['-b', out, '-P', at], { ...env, RENDERNET_BAKE_STAGE: 'fill' }).stdout ?? '';
  }

  if (said.includes(BAKE_MARKER)) return { scene: out };

  const stuck = said.split('\n').find(line => line.includes(UNBAKED_MARKER));

  return { failed: stuck ? stuck.slice(stuck.indexOf(UNBAKED_MARKER)).trim() : 'no answer' };
}

const wanted = process.argv.slice(2).filter(name => name in SCENES);
const kinds = wanted.length > 0 ? wanted : Object.keys(SCENES);

fs.mkdirSync(WORK, { recursive: true });
console.log(`Working in ${WORK}\n`);

const rows = [];

for (const kind of kinds) {
  const last = SCENES[kind];

  hideCaches(kind);

  const built = blender(['-b', '--factory-startup', '-P', script('build.py', BUILD)], { KIND: kind });

  if (!(built.stdout ?? '').includes('BUILT')) {
    rows.push({ kind, note: 'could not be built', ok: false });
    continue;
  }

  // Building the scene writes the frame it was saved on into the cache, and a
  // render that reads that frame back rather than simulating it comes out
  // slightly different. Both sides of this comparison start from nothing.
  hideCaches(kind);

  const truth = path.join(WORK, `truth_${kind}_`);
  render(path.join(WORK, `${kind}.blend`), Array.from({ length: last }, (_, at) => at + 1), truth);

  hideCaches(kind);

  const farm = uploaded(kind);
  const report = await checkScene(farm.at, null, last);
  const asked = [...report.unbaked, ...report.fluids.map(name => `${name} fluid`)];
  let scene = farm.at;

  if (asked.length > 0) {
    const done = bake(kind, farm, last);

    if (done.failed) {
      rows.push({ kind, asked, note: done.failed, ok: false });
      console.log(`${kind}: bake failed`);
      continue;
    }

    scene = done.scene;
  }

  render(scene, [last], path.join(WORK, `farm_${kind}_`));

  const frame = String(last).padStart(4, '0');
  const { most, share } = compare(`${truth}${frame}.png`, path.join(WORK, `farm_${kind}_${frame}.png`));
  // A frame is the same picture when no pixel differs by more than sampling
  // noise; Cycles lands a single 8-bit step either way from run to run.
  const ok = share === 0;

  rows.push({ kind, asked, most, share, ok });
  console.log(`${kind}: ${ok ? 'same picture' : 'DIFFERENT'} (${share.toFixed(2)}% of pixels)`);
}

console.log('\n%s', 'scene        asked to bake                     largest difference  pixels');

for (const row of rows) {
  const asked = (row.asked ?? []).join(', ') || '-';
  const detail = row.note
    ? row.note
    : `${row.most.toFixed(8)}          ${row.share.toFixed(2)}%`;

  console.log(`${row.kind.padEnd(12)} ${asked.slice(0, 32).padEnd(33)} ${detail}`);
}

const wrong = rows.filter(row => !row.ok);

console.log(wrong.length === 0
  ? `\nEvery scene came back the same picture the artist would have rendered.`
  : `\n${wrong.length} scene(s) did not: ${wrong.map(row => row.kind).join(', ')}`);

process.exit(wrong.length === 0 ? 0 : 1);
