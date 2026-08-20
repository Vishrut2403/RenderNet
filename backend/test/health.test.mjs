// The health endpoint: what it reports, and how much of it each caller is
// allowed to see. Runs without Blender.
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, auth, signUp, login, createFakeBlender, createFakeScene,
  submitJob, waitForJob, waitForCondition
} from './helpers.mjs';

const BLIND_PORT = 5594;
const PORT = 5595;

async function health(base, token) {
  const res = await fetch(`${base}/health`, { headers: token ? auth(token) : {} });
  return { status: res.status, body: await res.json() };
}

export default async function run() {
  const results = createResults('health');

  const sandbox = makeSandbox('health');
  const blindSandbox = makeSandbox('health-blind');

  let server;
  let blind;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const token = await adminSession(base);

    console.log('\n  What an unauthenticated caller is told');

    const anonymous = await health(base, null);
    results.check('health answers without a session', anonymous.status === 200);
    results.check('it says the farm is working', anonymous.body.status === 'ok',
      JSON.stringify(anonymous.body));
    results.check('it reports Blender as available when a path is configured',
      anonymous.body.blenderAvailable === true, JSON.stringify(anonymous.body));
    results.check('and nothing at all about the jobs',
      anonymous.body.queue === undefined && anonymous.body.current === undefined
        && anonymous.body.lastFailure === undefined,
      JSON.stringify(anonymous.body));

    console.log('\n  A machine that cannot render says so');

    // Pointed at a Blender that is not there, so the degraded answer is
    // exercised whether or not the machine running the suite has one.
    blind = await startServer({
      port: BLIND_PORT,
      cwd: blindSandbox,
      env: { BLENDER_PATH: path.join(blindSandbox, 'no-blender-here') }
    });

    const blindHealth = await health(blind.base, await adminSession(blind.base));
    results.check('a missing Blender is not reported as ok',
      blindHealth.body.blenderAvailable === false && blindHealth.body.status === 'degraded',
      JSON.stringify(blindHealth.body));
    results.check('and the problem is named',
      blindHealth.body.problems.some(problem => problem.includes('Blender')),
      JSON.stringify(blindHealth.body.problems));

    console.log('\n  What a signed-in caller is told');

    const idle = await health(base, token);
    results.check('the queue depth is reported',
      typeof idle.body.queue?.waiting === 'number' && idle.body.queue.rendering === false,
      JSON.stringify(idle.body.queue));
    results.check('and how much disk is left against the reserve',
      typeof idle.body.disk?.freeBytes === 'number'
        && idle.body.disk.minFreeBytes > 0 && idle.body.disk.low === false,
      JSON.stringify(idle.body.disk));
    results.check('no job is named as running while the queue is empty',
      idle.body.current === null, JSON.stringify(idle.body.current));
    results.check('nothing has failed yet', idle.body.lastFailure === null,
      JSON.stringify(idle.body.lastFailure));

    console.log('\n  The last failure is remembered');

    const broken = await submitJob(base, token, createFakeScene(sandbox, 'broken.blend'), {
      frameStart: 1, frameEnd: 1
    });
    const brokenJob = await waitForJob(base, token, broken.body.jobId, 30000);
    results.check('the broken job failed', brokenJob.status === 'failed', brokenJob.status);

    const afterFailure = await health(base, token);
    results.check('health reports which job failed last',
      afterFailure.body.lastFailure?.id === broken.body.jobId,
      JSON.stringify(afterFailure.body.lastFailure));
    results.check('and why it failed',
      typeof afterFailure.body.lastFailure?.error === 'string'
        && afterFailure.body.lastFailure.error.length > 0,
      JSON.stringify(afterFailure.body.lastFailure));

    console.log('\n  A job in flight is only named to the people entitled to it');

    await signUp(base, 'watcher', 'watcher-password');
    const watcherToken = await login(base, 'watcher', 'watcher-password');

    const slow = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });

    await waitForCondition(async () => (await health(base, token)).body.queue?.rendering,
      { label: 'the slow job to start' });

    const owner = await health(base, token);
    results.check('the owner sees which job is running and what it is called',
      owner.body.current?.id === slow.body.jobId
        && owner.body.current?.filename === 'slow.blend',
      JSON.stringify(owner.body.current));
    results.check('and how far through it is',
      owner.body.current?.totalFrames === 6 && typeof owner.body.current?.startedAt === 'string',
      JSON.stringify(owner.body.current));

    const watched = await health(base, watcherToken);
    results.check('somebody else can see that the farm is busy',
      watched.body.queue?.rendering === true && watched.body.current?.id === slow.body.jobId,
      JSON.stringify(watched.body.current));
    // Everything else about a job is behind the same access check, so the
    // health endpoint is not the place that starts handing out filenames.
    results.check('but not whose job it is or what it is called',
      watched.body.current?.filename === undefined && watched.body.current?.owner === undefined,
      JSON.stringify(watched.body.current));
    results.check('nor why somebody else\'s job failed',
      watched.body.lastFailure?.id === broken.body.jobId
        && watched.body.lastFailure?.error === null,
      JSON.stringify(watched.body.lastFailure));

    await fetch(`${base}/jobs/${slow.body.jobId}/cancel`, {
      method: 'POST', headers: auth(token)
    });
  } finally {
    await stopServer(server);
    await stopServer(blind);
    removeSandbox(sandbox);
    removeSandbox(blindSandbox);
  }

  return results;
}
