// Who may fetch a finished render, with what, and whether any of it survives the
// machine being restarted. None of it needs a real Blender - only frames on
// disk - so it runs on every platform the farm is tested on rather than on the
// one that happens to have Blender installed.
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession,
  signUp, login, auth, status, submitJob, waitForJob, waitForCondition, getJob,
  createFakeBlender, createFakeFfmpeg, createFakeScene
} from './helpers.mjs';

const PORT = 5604;

async function mint(base, jobId, token) {
  const res = await fetch(`${base}/download/${jobId}/token`, {
    method: 'POST', headers: auth(token)
  });

  return { status: res.status, body: await res.json() };
}

export default async function run() {
  const results = createResults('downloads');
  const sandbox = makeSandbox('downloads');

  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: {
        BLENDER_PATH: createFakeBlender(sandbox),
        FFMPEG_PATH: createFakeFfmpeg(sandbox)
      }
    });

    const { base } = server;
    const admin = await adminSession(base);
    await signUp(base, 'onlooker', 'onlooker-password');
    const onlooker = await login(base, 'onlooker', 'onlooker-password');

    const scene = createFakeScene(sandbox, 'delivered.blend');
    const first = await submitJob(base, admin, scene,
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });
    const second = await submitJob(base, admin, scene,
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });

    const jobId = first.body.jobId;
    const other = second.body.jobId;

    await waitForJob(base, admin, jobId, 60000);
    await waitForJob(base, admin, other, 60000);

    await fetch(`${base}/jobs/${jobId}/video`, { method: 'POST', headers: auth(admin) });
    await waitForCondition(async () => (await getJob(base, admin, jobId)).video === 'ready',
      { label: 'the video to be made', timeoutMs: 30000 });

    console.log('\n  Who may fetch a finished render');

    const scoped = (await mint(base, jobId, admin)).body.token;
    const frameUrl = `${base}/download/files/render_${jobId}/frame_0001.png`;

    results.check('the owner downloads with the session it signed in with',
      await status(`${base}/download/${jobId}/zip`, { headers: auth(admin) }) === 200);
    results.check('a scoped token opens the job it was minted for',
      await status(`${frameUrl}?token=${scoped}`) === 200);
    results.check('nothing at all opens it without one',
      await status(`${base}/download/${jobId}/zip`) === 401);
    results.check('and somebody else cannot mint one',
      (await mint(base, jobId, onlooker)).status === 403);

    console.log('\n  What a link in the address bar may carry');

    // A URL is copied, bookmarked and kept in history, so the one thing it must
    // never carry is the session itself.
    results.check('never the session token',
      await status(`${frameUrl}?token=${admin}`) === 401);

    const elsewhere = (await mint(base, other, admin)).body.token;

    results.check('a token for one job does not open another',
      await status(`${frameUrl}?token=${elsewhere}`) === 403);
    results.check('and a token with a character changed opens nothing',
      await status(`${frameUrl}?token=${scoped.slice(0, -2)}xy`) === 401);

    console.log('\n  Reaching past the job folder');

    // Separators are written in the URL rather than as path segments, so the
    // server sees the traversal rather than the client's own resolution of it.
    for (const attempt of ['..%2f..%2fusers.json', '..%2f..%2ftest.db',
      '..%5c..%5cusers.json', '%2e%2e%2f%2e%2e%2fusers.json']) {
      results.check(`${attempt} is refused`,
        await status(`${base}/download/files/render_${jobId}/${attempt}?token=${scoped}`) === 404);
    }

    console.log('\n  What the listing says');

    const listing = await (await fetch(`${base}/download/${jobId}/files`,
      { headers: auth(admin) })).json();

    results.check('every frame that rendered is offered',
      listing.files.filter(file => file.filename.endsWith('.png')).length === 2,
      JSON.stringify(listing.files.map(file => file.filename)));
    results.check('the video is offered beside them',
      listing.files.some(file =>
        file.filename.endsWith('.mp4') && file.previewable === false),
      JSON.stringify(listing.files.map(file => file.filename)));
    // The browser composes the fetchable URL; baking in an origin and a token
    // here breaks any deployment where the API is not same-origin.
    results.check('paths are API-relative and carry no token',
      listing.files.every(file =>
        file.path === `/download/files/render_${jobId}/${file.filename}`)
      && !JSON.stringify(listing).includes('token'),
      JSON.stringify(listing.files.map(file => file.path)));

    console.log('\n  Across a restart');

    await stopServer(server);
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    results.check('the session signed in before it still works',
      await status(`${server.base}/jobs`, { headers: auth(admin) }) === 200);

    const recovered = await getJob(server.base, admin, jobId);

    results.check('the job is still there and still finished',
      recovered.status === 'completed', recovered.status);
    results.check('with the progress it had', recovered.progress === 100,
      String(recovered.progress));
    results.check('and its frames still download',
      await status(`${server.base}/download/${jobId}/zip`, { headers: auth(admin) }) === 200);
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
