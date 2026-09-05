// What an uploaded scene says about itself before anybody has typed a frame
// range: the settings the form is offered, the ones it is not, and what
// happens when the file cannot be read at all. Nothing renders here.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  signUp, login, auth, createFakeBlender
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

  return results;
}
