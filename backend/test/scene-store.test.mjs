// Scenes are stored by what is in them, so the same file sent again is the copy
// already on disk. What that buys is one file and one charge against the quota
// however many jobs render it; what it costs is that the file outlives any one
// of them, which is what most of this is about. Runs without Blender.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, signUp, login, submitJob, waitForJob, createFakeBlender, createFakeScene, auth,
  status
} from './helpers.mjs';

const PORT = 5614;

function storedScenes(sandbox) {
  const uploads = path.join(sandbox, 'uploads');

  if (!fs.existsSync(uploads)) return [];

  // Everything the stand-in records lives here too; the scenes are the
  // directories, one per hash.
  return fs.readdirSync(uploads, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

async function usageOf(base, token) {
  const summary = await (await fetch(`${base}/jobs/summary`, { headers: auth(token) })).json();
  return summary.usage.bytes;
}

export default async function run() {
  const results = createResults('scene-store');
  const sandbox = makeSandbox('scene-store');
  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SLOTS: '0' }
    });

    const base = server.base;
    const token = await adminSession(base);
    const scene = createFakeScene(sandbox, 'chair.blend');

    const submit = (file, extra = {}) =>
      submitJob(base, token, file, { frameStart: 1, frameEnd: 2, ...extra });

    const jobOf = async id =>
      (await fetch(`${base}/jobs/${id}`, { headers: auth(token) })).json();

    console.log('\n  The same scene sent twice');

    const first = await submit(scene);
    const afterOne = await usageOf(base, token);
    const second = await submit(scene);

    const one = await jobOf(first.body.jobId);
    const two = await jobOf(second.body.jobId);

    results.check('both jobs were accepted',
      first.status === 200 && second.status === 200, `${first.status}, ${second.status}`);
    results.check('only one copy is on disk', storedScenes(sandbox).length === 1,
      storedScenes(sandbox).join(','));
    results.check('and the second job renders the copy already there',
      one.filePath === two.filePath, `${one.filePath} then ${two.filePath}`);
    results.check('the file keeps the name it was given',
      path.basename(one.filePath) === 'chair.blend', one.filePath);
    results.check('sending it again costs the artist nothing',
      await usageOf(base, token) === afterOne, `${afterOne} then ${await usageOf(base, token)}`);

    console.log('\n  A scene sent under another name');

    const renamed = createFakeScene(sandbox, 'chair-final.blend');
    // Same bytes, different name: what is inside it is what decides.
    fs.writeFileSync(renamed, fs.readFileSync(scene));

    const third = await submit(renamed);
    const under = await jobOf(third.body.jobId);

    results.check('is still the one file', storedScenes(sandbox).length === 1,
      storedScenes(sandbox).join(','));
    results.check('rendered from the copy already stored',
      under.filePath === one.filePath, under.filePath);
    results.check('while the job records what this artist called it',
      under.originalFilename === 'chair-final.blend', under.originalFilename);

    console.log('\n  A scene with different bytes');

    const other = await submit(createFakeScene(sandbox, 'table.blend'));

    results.check('is a second copy on disk', storedScenes(sandbox).length === 2,
      storedScenes(sandbox).join(','));
    results.check('and is charged for', await usageOf(base, token) > afterOne);

    console.log('\n  What a shared scene outlives');

    // Cancelling is what clears a job's files, and these are queued rather than
    // rendered, so it is the one that has to respect the sharing.
    const drop = id =>
      status(`${base}/jobs/${id}/cancel`, { method: 'POST', headers: auth(token) });

    results.check('the first job can be cancelled', await drop(first.body.jobId) === 200);
    results.check('and the scene stays for the jobs still holding it',
      fs.existsSync(path.join(sandbox, one.filePath)), one.filePath);

    await drop(second.body.jobId);
    results.check('still there for the last of them',
      fs.existsSync(path.join(sandbox, one.filePath)), one.filePath);

    await drop(third.body.jobId);
    results.check('and gone once nothing renders it any more',
      !fs.existsSync(path.join(sandbox, one.filePath)), one.filePath);
    results.check('leaving the scene nobody cancelled alone',
      storedScenes(sandbox).length === 1, storedScenes(sandbox).join(','));

    console.log('\n  A job refused after its bytes have arrived');

    // The scene is on disk before the settings are looked at, so refusing has
    // to put it back - without taking the copy another job is rendering.
    const refused = await submit(createFakeScene(sandbox, 'table.blend'), { frameEnd: 0 });
    const still = await jobOf(other.body.jobId);

    results.check('the job is refused', refused.status === 400, JSON.stringify(refused.body));
    results.check('and the scene it shares is left where it was',
      fs.existsSync(path.join(sandbox, still.filePath)), still.filePath);

    const alone = createFakeScene(sandbox, 'lamp.blend');
    const nobodys = await submit(alone, { frameEnd: 0 });

    results.check('a refused job whose scene nobody else has takes it with it',
      nobodys.status === 400 && storedScenes(sandbox).length === 1,
      storedScenes(sandbox).join(','));

    console.log('\n  Two people who happen to send the same scene');

    await signUp(base, 'sculptor', 'chisel-and-mallet');
    const sculptor = await login(base, 'sculptor', 'chisel-and-mallet');
    const shared = createFakeScene(sandbox, 'shared.blend');

    await submit(shared);
    const before = await usageOf(base, sculptor);

    const theirs = await submitJob(base, sculptor, shared, { frameStart: 1, frameEnd: 2 });

    results.check('the second of them is accepted', theirs.status === 200,
      JSON.stringify(theirs.body));
    // One file on disk, but each of them is charged: otherwise whoever sent it
    // second renders for free and a quota stops meaning anything.
    results.check('and charged for it even though the bytes were already here',
      await usageOf(base, sculptor) > before,
      `${before} then ${await usageOf(base, sculptor)}`);

    console.log('\n  It still renders');

    server = await restartWithWorker(server, sandbox, PORT);

    const renderToken = await adminSession(server.base);
    const rendered = await submitJob(server.base, renderToken,
      createFakeScene(sandbox, 'render-me.blend'), { frameStart: 1, frameEnd: 2 });
    const done = await waitForJob(server.base, renderToken, rendered.body.jobId, 120000);

    results.check('a job of a content-addressed scene renders',
      done.status === 'completed' && done.completedFrames === 2,
      `${done.status}, ${done.completedFrames} of 2`);
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}

// The checks above want nothing rendering underneath them, so the farm only
// gets a worker once they are done.
async function restartWithWorker(server, sandbox, port) {
  await stopServer(server);

  return startServer({
    port,
    cwd: sandbox,
    env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SLOTS: '1' }
  });
}
