import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession, auth,
  createFakeBlender, createFakeScene, submitJob, waitForCondition, getJob, sleep
} from './helpers.mjs';

const QUIET_PORT = 5626;
const BUSY_PORT = 5627;
const CHECK_PORT = 5628;
const DRAIN_PORT = 5629;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function post(base, token, route, body) {
  const res = await fetch(`${base}/jobs/${route}`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function queued(base, token) {
  const res = await fetch(`${base}/jobs/queue/status`, { headers: auth(token) });
  return (await res.json()).queue.map(entry => entry.id);
}

function statusOf(base, token, jobId) {
  return getJob(base, token, jobId).then(job => job.status);
}

function fairShares(box) {
  const script = `
    import { stampJob, shareOf, levelUp } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'fairness.js')).href)};
    levelUp();
    const amy = { id: 1, owner: 'amy', totalFrames: 10, completedFrames: 0 };
    stampJob(amy);
    stampJob({ id: 2, owner: 'bob', totalFrames: 10, completedFrames: 0 });
    amy.completedFrames = 5;
    stampJob(amy);
    stampJob({ id: 3, owner: 'amy', totalFrames: 1, completedFrames: 0 });
    stampJob({ id: 4, owner: 'bob', totalFrames: 1, completedFrames: 0 });
    console.log(JSON.stringify({ amy: shareOf(3), bob: shareOf(4) }));
  `;

  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: box, DB_PATH: path.join(box, 'fairness.db') }
  });

  const line = (run.stdout ?? '').trim().split('\n').pop();

  try {
    return JSON.parse(line);
  } catch {
    return { error: run.stderr || run.stdout };
  }
}

export default async function run() {
  const results = createResults('queue-edges');
  const box = makeSandbox('queue-edges');
  const servers = [];

  const start = async options => {
    fs.mkdirSync(options.cwd, { recursive: true });
    const server = await startServer(options);
    servers.push(server);
    return server;
  };

  try {
    const blender = createFakeBlender(box);

    console.log('\n  Paying for a job once');

    const shares = fairShares(box);

    results.check('a job put back part-way is not charged for twice',
      shares.amy !== undefined && shares.amy === shares.bob, JSON.stringify(shares));

    console.log('\n  Releasing and approving jobs that are gone');

    const quiet = await start({
      port: QUIET_PORT,
      cwd: path.join(box, 'quiet'),
      dataDir: path.join(box, 'quiet'),
      env: { BLENDER_PATH: blender, WORKER_SLOTS: '0' }
    });
    const quietToken = await adminSession(quiet.base);
    const held = (await submitJob(quiet.base, quietToken, createFakeScene(box, 'held.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true })).body.jobId;

    await post(quiet.base, quietToken, `${held}/hold`);
    await post(quiet.base, quietToken, `${held}/cancel`);

    const released = await post(quiet.base, quietToken, `${held}/release`);
    const stillQueued = (await queued(quiet.base, quietToken)).includes(held);

    results.check('a held job that was cancelled cannot be released back into the queue',
      released.status === 400 && !stillQueued,
      `release answered ${released.status}; back in the queue: ${stillQueued}`);

    const busy = await start({
      port: BUSY_PORT,
      cwd: path.join(box, 'busy'),
      dataDir: path.join(box, 'busy'),
      env: { BLENDER_PATH: blender }
    });
    const busyToken = await adminSession(busy.base);
    const tested = (await submitJob(busy.base, busyToken, createFakeScene(box, 'tested.blend'),
      { frameStart: 1, frameEnd: 3, testFrame: 1, skipAssetCheck: true })).body.jobId;

    await waitForCondition(
      async () => (await getJob(busy.base, busyToken, tested)).approval === 'waiting',
      { label: 'the test frame', timeoutMs: 30000 });

    await post(busy.base, busyToken, `${tested}/cancel`);

    const approved = await post(busy.base, busyToken, `${tested}/approve`);

    await sleep(1500);

    const afterApproval = await statusOf(busy.base, busyToken, tested);

    results.check('a test-frame job that was cancelled cannot be approved back to life',
      approved.status >= 400 && afterApproval === 'cancelled',
      `approve answered ${approved.status}; the job is now ${afterApproval}`);

    console.log('\n  Making room for a job that cannot start');

    const running = (await submitJob(busy.base, busyToken, createFakeScene(box, 'hang.blend'),
      { frameStart: 1, frameEnd: 1, skipAssetCheck: true })).body.jobId;

    await waitForCondition(
      async () => (await statusOf(busy.base, busyToken, running)) === 'rendering',
      { label: 'the long job to start', timeoutMs: 30000 });

    const blocked = (await submitJob(busy.base, busyToken, createFakeScene(box, 'blocked.blend'),
      { frameStart: 1, frameEnd: 1, skipAssetCheck: true })).body.jobId;

    await post(busy.base, busyToken, `${blocked}/hold`);

    const raised = await post(busy.base, busyToken, `${blocked}/priority`, { priority: 1 });

    await sleep(500);

    const runningNow = await statusOf(busy.base, busyToken, running);

    results.check('raising a held job to urgent does not pause the one rendering',
      raised.status === 200 && runningNow === 'rendering',
      `priority answered ${raised.status}; the rendering job is now ${runningNow}`);

    console.log('\n  Letting a paused job go before its workers have stopped');

    const drain = await start({
      port: DRAIN_PORT,
      cwd: path.join(box, 'drain'),
      dataDir: path.join(box, 'drain'),
      env: { BLENDER_PATH: blender, LEASE_TTL_MS: '6000' }
    });
    const drainToken = await adminSession(drain.base);
    const paused = (await submitJob(drain.base, drainToken, createFakeScene(box, 'slow.blend'),
      { frameStart: 1, frameEnd: 3, skipAssetCheck: true })).body.jobId;

    await waitForCondition(
      async () => (await statusOf(drain.base, drainToken, paused)) === 'rendering',
      { label: 'the slow job to start', timeoutMs: 30000 });

    await sleep(300);
    await post(drain.base, drainToken, `${paused}/hold`);
    await post(drain.base, drainToken, `${paused}/release`);

    await fetch(`${drain.base}/worker/lease`, {
      method: 'POST',
      headers: { 'x-worker-token': 'test-worker-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'passer-by', engines: ['CYCLES'], wait: 0 })
    });

    const finished = await waitForCondition(
      async () => (await statusOf(drain.base, drainToken, paused)) === 'completed',
      { label: 'the released job to finish', timeoutMs: 60000 });

    results.check('a job released while still stopping finishes rather than sticking',
      finished, `the job is ${await statusOf(drain.base, drainToken, paused)}`);

    console.log('\n  A scene check that cannot run');

    const checking = await start({
      port: CHECK_PORT,
      cwd: path.join(box, 'check'),
      dataDir: path.join(box, 'check'),
      env: { BLENDER_PATH: blender }
    });

    const blocker = path.join(os.tmpdir(), `rendernet-preflight-${checking.proc.pid}.py`);
    fs.mkdirSync(blocker, { recursive: true });

    try {
      const checkToken = await adminSession(checking.base);
      const unchecked = (await submitJob(checking.base, checkToken,
        createFakeScene(box, 'unchecked.blend'), { frameStart: 1, frameEnd: 2 })).body.jobId;

      const through = await waitForCondition(
        async () => (await statusOf(checking.base, checkToken, unchecked)) === 'completed',
        { label: 'the job to get past a check that could not run', timeoutMs: 30000 });

      results.check('a scene check that fails lets the job through instead of holding it',
        through, `the job is ${await statusOf(checking.base, checkToken, unchecked)}`);
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true });
    }
  } finally {
    for (const server of servers) await stopServer(server);
    removeSandbox(box);
  }

  return results;
}
