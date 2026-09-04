// Whose job runs next when several people are waiting for one machine, and the
// two overrides an admin has over that answer. The ordering half runs with no
// renderer at all, so the queue holds still and can be read; the override half
// needs work actually in flight and uses the stand-in Blender for it.
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession,
  signUp, login, auth, submitJob, waitForJob, waitForCondition, getJob,
  createFakeBlender, createFakeScene, sleep
} from './helpers.mjs';

const ORDER_PORT = 5612;
const OVERRIDE_PORT = 5613;
const SECRET = 'test-worker-secret';

// Nothing here may start rendering, or the order under test would change while
// it is being read. The farm's own renderers are switched off and its one
// machine offers an engine none of these jobs use.
async function offerAnotherEngine(base) {
  await fetch(`${base}/worker/lease`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-token': SECRET },
    body: JSON.stringify({ workerId: 'workbench-only', engines: ['BLENDER_WORKBENCH'] })
  });
}

async function queueOrder(base, token) {
  const res = await fetch(`${base}/jobs/queue/status`, { headers: auth(token) });
  const body = await res.json();

  return body.queue.map(entry => entry.id);
}

async function post(base, token, path, body) {
  const res = await fetch(`${base}/jobs/${path}`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function submit(base, token, scene, frames, extra = {}) {
  const { body } = await submitJob(base, token, scene,
    { frameStart: 1, frameEnd: frames, skipAssetCheck: true, ...extra });

  return body.jobId;
}

async function ordering(results) {
  const sandbox = makeSandbox('scheduling-order');

  let server;

  try {
    server = await startServer({
      port: ORDER_PORT,
      cwd: sandbox,
      env: { WORKER_SLOTS: '0' }
    });

    const { base } = server;
    const admin = await adminSession(base);

    // A fresh pair of names per scenario: an owner's turn is measured against
    // what that owner has already asked for, so reusing one would carry the
    // previous scenario's arithmetic into the next.
    for (const name of ['painter', 'sculptor', 'writer', 'editor', 'runner']) {
      await signUp(base, name, `${name}-password`);
    }

    const as = {};
    for (const name of ['painter', 'sculptor', 'writer', 'editor', 'runner']) {
      as[name] = await login(base, name, `${name}-password`);
    }

    await offerAnotherEngine(base);

    const scene = createFakeScene(sandbox, 'queued.blend');

    console.log('\n  Whose turn it is');

    const painter = [
      await submit(base, as.painter, scene, 4),
      await submit(base, as.painter, scene, 4),
      await submit(base, as.painter, scene, 4)
    ];
    const sculptor = await submit(base, as.sculptor, scene, 4);

    let order = await queueOrder(base, admin);
    const at = id => order.indexOf(id);

    results.check('somebody who has queued nothing goes second, not last',
      at(sculptor) === 1, `queue ${order.join(', ')}`);

    results.check('and the three-job owner keeps the machine for the first turn',
      at(painter[0]) === 0, `queue ${order.join(', ')}`);

    results.check('the jobs behind it stay in the order they were sent',
      at(painter[1]) < at(painter[2]), `queue ${order.join(', ')}`);

    console.log('\n  Measured in work rather than in jobs');

    const long = await submit(base, as.writer, scene, 40);
    const short = await submit(base, as.editor, scene, 2);

    order = await queueOrder(base, admin);

    results.check('a small job passes a large one submitted before it',
      at(short) < at(long), `queue ${order.join(', ')}`);

    console.log('\n  What outranks a turn');

    const urgent = await submit(base, as.runner, scene, 4, { priority: 1 });

    order = await queueOrder(base, admin);

    results.check('an urgent job goes in front of everybody',
      at(urgent) === 0, `queue ${order.join(', ')}`);

    const pinned = await post(base, admin, `${painter[2]}/pin`, { pinned: true });

    order = await queueOrder(base, admin);

    results.check('a pinned job is put in front even of an urgent one',
      pinned.status === 200 && at(painter[2]) === 0, `queue ${order.join(', ')}`);

    results.check('and the urgent one keeps second place',
      at(urgent) === 1, `queue ${order.join(', ')}`);

    const unpinned = await post(base, admin, `${painter[2]}/pin`, { pinned: false });

    order = await queueOrder(base, admin);

    results.check('unpinning puts it back where its turn says',
      unpinned.status === 200 && at(painter[2]) !== 0, `queue ${order.join(', ')}`);

    console.log('\n  Who may override');

    const byOwner = await post(base, as.painter, `${painter[0]}/pin`, { pinned: true });
    results.check('an owner cannot pin their own job to the front',
      byOwner.status === 403, String(byOwner.status));

    const heldByOwner = await post(base, as.painter, `${painter[0]}/hold`);
    results.check('nor hold one', heldByOwner.status === 403, String(heldByOwner.status));

    const badPin = await post(base, admin, `${painter[0]}/pin`, { pinned: 'yes' });
    results.check('and a pin has to say which way it means',
      badPin.status === 400, String(badPin.status));

    const missing = await post(base, admin, '999999/hold');
    results.check('a job that does not exist cannot be held',
      missing.status === 404, String(missing.status));
  } finally {
    if (server) await stopServer(server);
    removeSandbox(sandbox);
  }
}

async function overrides(results) {
  const sandbox = makeSandbox('scheduling-override');

  let server;

  try {
    server = await startServer({
      port: OVERRIDE_PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const admin = await adminSession(base);
    await signUp(base, 'painter', 'painter-password');
    const painter = await login(base, 'painter', 'painter-password');

    // 'slow' takes two seconds a frame, which is what makes a job catchable
    // while it is still going.
    const slow = createFakeScene(sandbox, 'slow-scene.blend');

    console.log('\n  Taking the machine back');

    const running = await submit(base, painter, slow, 8);

    await waitForCondition(async () => (await getJob(base, admin, running)).status === 'rendering',
      { label: 'the first job to start' });
    await waitForCondition(async () => (await getJob(base, admin, running)).completedFrames > 0,
      { label: 'a frame to land', timeoutMs: 30000 });

    const before = (await getJob(base, admin, running)).completedFrames;
    const held = await post(base, admin, `${running}/hold`);

    results.check('an admin can hold a job that is rendering',
      held.status === 200, JSON.stringify(held.body));

    await waitForCondition(async () => (await getJob(base, admin, running)).status === 'pending',
      { label: 'the held job to stop', timeoutMs: 30000 });

    const stopped = await getJob(base, admin, running);

    results.check('it keeps the frames it had already rendered',
      stopped.completedFrames >= before, `${stopped.completedFrames} vs ${before}`);

    results.check('and says who is holding it',
      stopped.heldBy === 'admin', String(stopped.heldBy));

    // Long enough that the queue would have promoted it again several times.
    await sleep(4000);

    results.check('a held job is not started again on its own',
      (await getJob(base, admin, running)).status === 'pending',
      (await getJob(base, admin, running)).status);

    console.log('\n  What runs while it is held');

    const urgentProject = await submit(base, admin, slow, 2);

    await waitForJob(base, admin, urgentProject, 60000);

    results.check('the job the machine was taken back for finishes',
      (await getJob(base, admin, urgentProject)).status === 'completed');

    results.check('while the held one is still waiting',
      (await getJob(base, admin, running)).status === 'pending');

    console.log('\n  Letting it go again');

    const released = await post(base, admin, `${running}/release`);

    results.check('releasing it answers plainly',
      released.status === 200, JSON.stringify(released.body));

    const finished = await waitForJob(base, admin, running, 120000);

    results.check('and the job runs to the end',
      finished.status === 'completed', finished.status);

    results.check('having rendered every frame once',
      finished.completedFrames === 8, String(finished.completedFrames));

    results.check('releasing a job nobody is holding says so',
      (await post(base, admin, `${running}/release`)).status === 400);

    results.check('and a finished job cannot be held',
      (await post(base, admin, `${running}/hold`)).status === 400);

    console.log('\n  Putting a project in front');

    const ordinary = await submit(base, painter, slow, 8);

    await waitForCondition(async () => (await getJob(base, admin, ordinary)).status === 'rendering',
      { label: 'the ordinary job to start' });

    const wanted = await submit(base, admin, slow, 2);
    const pinned = await post(base, admin, `${wanted}/pin`, { pinned: true });

    results.check('pinning a queued job answers plainly',
      pinned.status === 200, JSON.stringify(pinned.body));

    await waitForCondition(async () => (await getJob(base, admin, ordinary)).status === 'pending',
      { label: 'the running job to be pushed back', timeoutMs: 30000 });

    results.check('the job that was rendering is pushed back for it',
      (await getJob(base, admin, ordinary)).status === 'pending');

    const pinnedDone = await waitForJob(base, admin, wanted, 60000);
    const displaced = await getJob(base, admin, ordinary);

    results.check('the pinned job finishes while the other is still waiting',
      pinnedDone.status === 'completed' && displaced.status !== 'completed',
      `${pinnedDone.status}, displaced ${displaced.status}`);

    const resumed = await waitForJob(base, admin, ordinary, 120000);

    results.check('and the one it displaced carries on afterwards',
      resumed.status === 'completed', resumed.status);

    console.log('\n  What is not an admin\'s to reorder');

    // Pending, but waiting on a person rather than on the farm: putting it in
    // front would start a render nobody has agreed to yet.
    const unapproved = await submit(base, painter, slow, 12, { testFrame: 1 });

    await waitForCondition(
      async () => (await getJob(base, admin, unapproved)).approval === 'waiting',
      { label: 'the test frame to come back', timeoutMs: 60000 });

    const pinWaiting = await post(base, admin, `${unapproved}/pin`, { pinned: true });

    results.check('a job waiting on its owner cannot be put in front',
      pinWaiting.status === 400 && /waiting on its owner/.test(pinWaiting.body.error),
      JSON.stringify(pinWaiting.body));

    results.check('nor held',
      /waiting on its owner/.test((await post(base, admin, `${unapproved}/hold`)).body.error));
  } finally {
    if (server) await stopServer(server);
    removeSandbox(sandbox);
  }
}

export default async function run() {
  const results = createResults('scheduling');

  await ordering(results);
  await overrides(results);

  return results;
}
