// A .blend is somebody else's file, and Blender will run Python it carries as
// it opens one. On a farm several people submit to, that is code execution on
// the workstation, so every place a scene is opened has to say no. Needs a real
// Blender: the stand-in has no Python to run.
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForCondition, waitForJob, getJob,
  createFixtureBlend, blenderAvailable
} from './helpers.mjs';

const PORT = 5624;

// A text datablock set to register runs when the file is opened, on a machine
// that allows it. This one only writes a file, which is the whole point: if the
// marker appears, anything else could have happened instead.
function hostileScene(box, marker) {
  return createFixtureBlend(box, {
    name: 'untrusted.blend',
    extra: `
text = bpy.data.texts.new('payload.py')
text.write("import pathlib; pathlib.Path(r'${marker}').write_text('ran')")
text.use_module = True
bpy.ops.mesh.primitive_cube_add()
camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
s.collection.objects.link(camera)
s.camera = camera
camera.location = (4, -4, 3)
`
  });
}

// A cube whose height is worked out by a function the file defines. At frame 24
// it sits high in shot; without the function it stays on the floor, so the two
// renders are nothing like each other.
function drivenScene(box) {
  return createFixtureBlend(box, {
    name: 'driven.blend',
    extra: `
text = bpy.data.texts.new('rig.py')
text.write("import bpy\\ndef lift(f):\\n    return f * 0.25\\n"
           "bpy.app.driver_namespace['lift'] = lift\\n")
text.use_module = True

bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.object
driver = cube.driver_add('location', 2).driver
driver.type = 'SCRIPTED'
driver.expression = 'lift(frame)'

camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
s.collection.objects.link(camera)
s.camera = camera
camera.location = (14, -14, 5)
camera.rotation_euler = (1.3, 0, 0.785)
light = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
s.collection.objects.link(light)
light.location = (5, -5, 10)
s.frame_start = 24
s.frame_end = 24
`
  });
}

const DIFF = `import bpy, numpy, os

def pixels(at):
    image = bpy.data.images.load(at)
    seen = numpy.array(image.pixels[:]).reshape(-1, 4)[:, :3]
    bpy.data.images.remove(image)
    return seen

apart = numpy.abs(pixels(os.environ['A']) - pixels(os.environ['B']))
print('DIFF %.4f' % (100.0 * (apart.max(axis=1) > 0.01).mean()))
`;

// The share of pixels that differ, as the simulation matrix measures it. -1 if
// either picture is not there to compare.
function differing(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return -1;

  const at = path.join(path.dirname(a), 'diff.py');
  fs.writeFileSync(at, DIFF);

  const said = spawnSync(process.env.BLENDER_PATH || 'blender',
    ['-b', '--factory-startup', '-P', at],
    { encoding: 'utf8', env: { ...process.env, A: a, B: b } }).stdout ?? '';
  const line = said.split('\n').find(text => text.startsWith('DIFF ')) ?? '';

  return line ? Number(line.split(' ')[1]) : -1;
}

export default async function run() {
  const results = createResults('untrusted-scenes');
  const names = [
    'reading a scene does not run what it carries',
    'and it still reports what the scene contains',
    'rendering one does not run it either',
    'while the frame itself still arrives',
    'and it runs them when the artist says to',
    'a scene whose drivers need it is refused rather than rendered wrong',
    'and once allowed, its frame is the one Blender renders by hand'
  ];

  if (!blenderAvailable()) {
    for (const name of names) results.skipped(name, 'Blender not installed');
    return results;
  }

  const box = makeSandbox('untrusted');
  let server;

  try {
    console.log('\n  A scene that would rather run code than render');

    // The scene is opened before anybody has approved anything, so this is the
    // earliest place the farm touches a stranger's file.
    const readMarker = path.join(box, 'READ_RAN.txt');
    const blend = hostileScene(box, readMarker);

    const { checkScene } = await import('../src/preflight.js');
    const read = await checkScene(blend, { frameStart: 1, frameEnd: 1 });

    results.check('reading a scene does not run what it carries',
      !fs.existsSync(readMarker), 'the scene wrote its marker while being read');
    results.check('and it still reports what the scene contains',
      read && typeof read === 'object', JSON.stringify(read));

    const renderMarker = path.join(box, 'RENDER_RAN.txt');
    const forRender = hostileScene(box, renderMarker);

    server = await startServer({ port: PORT, cwd: box });

    const token = await adminSession(server.base);
    const job = await submitJob(server.base, token, forRender,
      { frameStart: 1, frameEnd: 1, skipAssetCheck: true });

    await waitForCondition(
      async () => ['completed', 'failed'].includes(
        (await getJob(server.base, token, job.body.jobId)).status),
      { label: 'the untrusted scene to render', timeoutMs: 180000 });

    const finished = await getJob(server.base, token, job.body.jobId);

    results.check('rendering one does not run it either',
      !fs.existsSync(renderMarker), 'the scene executed code on the farm');
    // Refusing to run its scripts must not turn into refusing to render it.
    results.check('while the frame itself still arrives',
      finished.status === 'completed' && finished.completedFrames === 1,
      `${finished.status}, ${finished.completedFrames} frame(s)`);

    // The way out for a rig whose drivers call its own functions: the person who
    // owns the file says it may run, for that job and no other.
    const allowedMarker = path.join(box, 'ALLOWED_RAN.txt');
    const allowed = await submitJob(server.base, token, hostileScene(box, allowedMarker),
      { frameStart: 1, frameEnd: 1, skipAssetCheck: true, allowScripts: true });

    await waitForCondition(
      async () => ['completed', 'failed'].includes(
        (await getJob(server.base, token, allowed.body.jobId)).status),
      { label: 'the trusted scene to render', timeoutMs: 180000 });

    results.check('and it runs them when the artist says to',
      fs.existsSync(allowedMarker), 'the scene was allowed its scripts and still did not run them');
    console.log('\n  A scene whose drivers are worked out by Python');

    const driven = drivenScene(box);
    const refused = await submitJob(server.base, token, driven,
      { frameStart: 24, frameEnd: 24 });

    const stopped = await waitForJob(server.base, token, refused.body.jobId, 120000);

    results.check('a scene whose drivers need it is refused rather than rendered wrong',
      stopped.status === 'failed' && /drivers?/i.test(stopped.error || ''),
      `${stopped.status}: ${stopped.error || ''}`);

    // The farm's frame against one rendered here by hand from the same file:
    // the only standard that says the drivers really worked.
    const wanted = await submitJob(server.base, token, driven,
      { frameStart: 24, frameEnd: 24, allowScripts: true });

    const rendered = await waitForJob(server.base, token, wanted.body.jobId, 180000);
    const byHand = path.join(box, 'byhand_0024.png');

    await new Promise((resolve, reject) => {
      const blender = spawn(process.env.BLENDER_PATH || 'blender',
        ['-b', driven, '-o', path.join(box, 'byhand_####'), '-f', '24'], { stdio: 'ignore' });

      blender.on('exit', code => (code === 0 ? resolve() : reject(new Error(`blender ${code}`))));
      blender.on('error', reject);
    });

    const ours = path.join(box, rendered.outputFolder ?? '', 'frame_0024.png');

    // Pixels rather than bytes: two PNGs of the same picture are not the same
    // file, and it is the picture that has to match.
    const apart = differing(ours, byHand);

    results.check('and once allowed, its frame is the one Blender renders by hand',
      rendered.status === 'completed' && apart === 0,
      `${rendered.status}, ${apart}% of pixels differ`);
  } finally {
    if (server) await stopServer(server);
    removeSandbox(box);
  }

  return results;
}
