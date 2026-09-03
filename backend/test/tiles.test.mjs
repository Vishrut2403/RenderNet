// A still cut into regions the farm renders separately and puts back together.
// The plumbing runs against the stand-in Blender; whether the pieces land in
// the right places is checked further down, where a real one is installed.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession,
  auth, submitJob, waitForJob, createFakeBlender, createFakeScene, createFixtureBlend,
  blenderAvailable
} from './helpers.mjs';

const PORT = 5602;
const REAL_PORT = 5603;

// IHDR is fixed at the front of every PNG: width and height as big-endian
// 32-bit integers, which is all that is needed to see how a frame was divided.
function pngSize(file) {
  if (!fs.existsSync(file)) return null;

  const header = fs.readFileSync(file).subarray(16, 24);

  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

export default async function run() {
  const results = createResults('tiles');
  const sandbox = makeSandbox('tiles');

  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const admin = await adminSession(base);

    console.log('\n  A still cut into regions');

    const tiled = await submitJob(base, admin, createFakeScene(sandbox, 'still.blend'),
      { frameStart: 3, frameEnd: 3, tiles: 4, skipAssetCheck: true });

    results.check('a still can be submitted in tiles', tiled.status === 200,
      JSON.stringify(tiled.body));

    const finished = await waitForJob(base, admin, tiled.body.jobId, 60000);

    results.check('the job completes', finished.status === 'completed',
      `${finished.status}: ${finished.error || ''}`);
    results.check('its units of work are the tiles, not the frame',
      finished.totalFrames === 4 && finished.completedFrames === 4,
      `${finished.completedFrames} of ${finished.totalFrames}`);
    results.check('and it still says which frame of the scene it is',
      finished.frameStart === 3 && finished.frameEnd === 3,
      `${finished.frameStart}-${finished.frameEnd}`);

    const outputDir = path.join(sandbox, finished.outputFolder);

    results.check('every region is kept aside from the output',
      fs.readdirSync(path.join(outputDir, 'tiles')).length === 4,
      fs.readdirSync(path.join(outputDir, 'tiles')).join(','));
    results.check('and what is delivered is one picture',
      fs.readdirSync(outputDir).filter(name => name.endsWith('.png')).join(',')
        === 'frame_0003.png',
      fs.readdirSync(outputDir).join(','));

    const asked = JSON.parse(
      fs.readFileSync(path.join(sandbox, 'uploads', 'last-composite.txt'), 'utf8'));

    results.check('the pieces are handed over in order',
      asked.tiles.length === 4
      && asked.tiles.every((file, index) =>
        path.basename(file) === `tile_${String(index + 1).padStart(4, '0')}.png`),
      JSON.stringify(asked.tiles.map(file => path.basename(file))));
    results.check('with the count they were cut into', asked.count === 4, String(asked.count));

    const env = fs.readFileSync(path.join(sandbox, 'uploads', 'last-env.txt'), 'utf8');

    results.check('and each render was told which region to make',
      env.includes('RENDERNET_TILE_COUNT=4') && /RENDERNET_TILE_INDEX=[1-4]/.test(env),
      env.split('\n').filter(line => line.startsWith('RENDERNET_TILE')).join(' '));

    console.log('\n  What comes back');

    const token = await (await fetch(`${base}/download/${tiled.body.jobId}/token`,
      { method: 'POST', headers: auth(admin) })).json();

    const listed = await (await fetch(
      `${base}/download/${tiled.body.jobId}/files?token=${token.token}`)).json();

    results.check('the download offers the picture and not its pieces',
      listed.files.length === 1 && listed.files[0].filename === 'frame_0003.png',
      JSON.stringify(listed.files.map(file => file.filename)));

    const preview = await fetch(
      `${base}/download/${tiled.body.jobId}/preview?token=${token.token}`);

    results.check('and the preview is the finished picture, not a region',
      preview.status === 200 && preview.headers.get('x-frame-number') === '3',
      `${preview.status} ${preview.headers.get('x-frame-number')}`);

    console.log('\n  A region that will not render');

    const broken = await submitJob(base, admin, createFakeScene(sandbox, 'broken.blend'),
      { frameStart: 1, frameEnd: 1, tiles: 4, skipAssetCheck: true });
    const failed = await waitForJob(base, admin, broken.body.jobId, 60000);

    results.check('fails the still rather than delivering part of it',
      failed.status === 'failed', failed.status);
    results.check('and says how much of it was missing',
      /\d+ tiles? (all )?failed/.test(failed.error ?? ''), failed.error);
    results.check('leaving no half-made picture behind',
      !fs.existsSync(path.join(sandbox, failed.outputFolder, 'frame_0001.png')));

    console.log('\n  What may be cut up');

    const range = await submitJob(base, admin, createFakeScene(sandbox, 'range.blend'),
      { frameStart: 1, frameEnd: 4, tiles: 4, skipAssetCheck: true });

    results.check('a range of frames is refused', range.status === 400,
      JSON.stringify(range.body));

    const tooMany = await submitJob(base, admin, createFakeScene(sandbox, 'many.blend'),
      { frameStart: 1, frameEnd: 1, tiles: 17, skipAssetCheck: true });

    results.check('and so is cutting one into more pieces than the farm allows',
      tooMany.status === 400, JSON.stringify(tooMany.body));

    const twoFormats = await submitJob(base, admin, createFakeScene(sandbox, 'formats.blend'),
      { frameStart: 1, frameEnd: 1, tiles: 4, formats: ['PNG', 'JPEG'], skipAssetCheck: true });

    results.check('a tiled still is put back together in one format only',
      twoFormats.status === 400, JSON.stringify(twoFormats.body));
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  await againstRealBlender(results);

  return results;
}

// Whether a region lands where it belongs cannot be told from a stand-in that
// writes the same pixel whatever it is asked for.
async function againstRealBlender(results) {
  console.log('\n  Put back together by Blender itself');

  if (!blenderAvailable()) {
    for (const name of ['the tiles divide the frame between them',
      'the picture is the size it would have been rendered whole',
      'and it matches that render pixel for pixel']) {
      results.skipped(name, 'Blender not installed');
    }
    return;
  }

  const sandbox = makeSandbox('tiles-real');
  let server;

  try {
    server = await startServer({ port: REAL_PORT, cwd: sandbox });

    const { base } = server;
    const admin = await adminSession(base);

    // Off-centre in both directions: a region put back upside down or mirrored
    // would otherwise land somewhere that looks much the same.
    const blend = createFixtureBlend(sandbox, {
      extra: "bpy.data.objects['Cube'].location = (1.4, 0.3, 0.9)\n"
        + 's.render.resolution_x = 80\ns.render.resolution_y = 48\n'
        + 's.render.dither_intensity = 0\n'
    });

    const whole = await submitJob(base, admin, blend, { frameStart: 1, frameEnd: 1 });
    const wholeJob = await waitForJob(base, admin, whole.body.jobId, 180000);

    const cut = await submitJob(base, admin, blend,
      { frameStart: 1, frameEnd: 1, tiles: 4 });
    const cutJob = await waitForJob(base, admin, cut.body.jobId, 180000);

    const reference = path.join(sandbox, wholeJob.outputFolder, 'frame_0001.png');
    const composite = path.join(sandbox, cutJob.outputFolder, 'frame_0001.png');
    const tilesDir = path.join(sandbox, cutJob.outputFolder, 'tiles');
    const sizes = fs.existsSync(tilesDir)
      ? fs.readdirSync(tilesDir).sort().map(name => pngSize(path.join(tilesDir, name)))
      : [];

    results.check('the tiles divide the frame between them',
      sizes.length === 4
      && sizes[0]?.width + sizes[1]?.width === 80
      && sizes[0]?.height + sizes[2]?.height === 48,
      JSON.stringify(sizes));

    results.check('the picture is the size it would have been rendered whole',
      cutJob.status === 'completed'
      && pngSize(composite) !== null
      && JSON.stringify(pngSize(composite)) === JSON.stringify(pngSize(reference)),
      `${cutJob.status}: ${JSON.stringify(pngSize(composite))} `
      + `vs ${JSON.stringify(pngSize(reference))}`);

    // A tile put back mirrored or upside down moves whole features across the
    // frame; what is allowed here is the rounding of writing 8 bits twice.
    const difference = pngSize(composite) === null ? 1 : largestDifference(reference, composite);

    results.check('and it matches that render pixel for pixel',
      difference <= 2 / 255, `largest difference ${difference}`);
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }
}

// Blender is the thing that read and wrote both files, so it is also what says
// whether they hold the same pixels.
function largestDifference(reference, composite) {
  const script = `
import bpy, numpy, sys

def pixels(filepath):
    image = bpy.data.images.load(filepath)
    image.colorspace_settings.name = 'Non-Color'
    values = numpy.empty(len(image.pixels), dtype=numpy.float32)
    image.pixels.foreach_get(values)
    return values

a = pixels(r'${reference}')
b = pixels(r'${composite}')

if a.shape != b.shape:
    print('RENDERNET_DIFF 1.0')
else:
    print('RENDERNET_DIFF %f' % float(numpy.abs(a - b).max()))
`;

  const run = spawnSync('blender', ['-b', '--factory-startup', '--python-expr', script],
    { encoding: 'utf8', timeout: 180000 });

  const reported = (run.stdout ?? '').match(/RENDERNET_DIFF ([\d.]+)/);

  return reported ? Number(reported[1]) : 1;
}
