// Being told there is work rather than asking every couple of seconds: the
// lease request that waits, and the bus that ends the wait. Runs with and
// without Redis, since a farm on one machine is expected to have neither.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, createFakeBlender, createFakeScene, submitJob, waitForCondition, getJob
} from './helpers.mjs';

const PORT = 5622;
const REDIS_PORT = 5623;
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function lease(base, wait) {
  const started = Date.now();

  return fetch(`${base}/worker/lease`, {
    method: 'POST',
    headers: { 'x-worker-token': 'test-worker-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'asking', wait })
  }).then(async response => ({ status: response.status, ms: Date.now() - started }));
}

// Two processes, one Redis: what an EventEmitter cannot do and the reason this
// is worth a dependency at all. Nothing is published until the other side says
// it is listening, because a subscription that is not up yet misses the message
// entirely - pub/sub keeps nothing for a subscriber who was not there.
function busProcess(script) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, REDIS_URL },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  let err = '';
  let sayReady = () => {};

  const ready = new Promise(resolve => { sayReady = resolve; });

  child.stdout.on('data', chunk => {
    out += chunk;
    if (out.includes('ready')) sayReady();
  });

  child.stderr.on('data', chunk => { err += chunk; });

  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => (code === 0
      ? resolve(out.trim())
      : reject(new Error(err || `exit ${code}`))));
  });

  ended.catch(() => sayReady());

  return { ready, ended };
}

async function redisIsThere() {
  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: REDIS_URL });

    client.on('error', () => {});
    await client.connect();
    await client.quit();

    return true;
  } catch {
    return false;
  }
}

export default async function run() {
  const results = createResults('events');
  const sandbox = makeSandbox('events');
  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SECRET: 'test-worker-secret' }
    });

    const { base } = server;
    const token = await adminSession(base);

    console.log('\n  Asking for work when there is none');

    const at_once = await lease(base, 0);

    results.check('without a wait the answer comes straight back',
      at_once.status === 204 && at_once.ms < 500, `${at_once.status} in ${at_once.ms}ms`);

    const held = await lease(base, 1);

    results.check('with one it is held until the time is up',
      held.status === 204 && held.ms >= 900, `${held.status} in ${held.ms}ms`);

    console.log('\n  Being told the moment there is some');

    // Asked for first and submitted after, so the answer can only come from the
    // announcement: at the moment of asking there was nothing to hand out.
    const waiting = lease(base, 20);
    await new Promise(resolve => setTimeout(resolve, 200));

    await submitJob(base, token, createFakeScene(sandbox, 'told.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });

    const answered = await waiting;

    results.check('a job arriving ends the wait',
      answered.status === 200, `${answered.status} after ${answered.ms}ms`);
    results.check('and does it in well under a poll',
      answered.ms < 1500, `took ${answered.ms}ms`);

    console.log('\n  A farm with no Redis still renders');

    const plain = await submitJob(base, token, createFakeScene(sandbox, 'plain.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });

    await waitForCondition(
      async () => (await getJob(base, token, plain.body.jobId)).status === 'completed',
      { label: 'the job to finish without a bus', timeoutMs: 60000 });

    results.check('a job finishes with the local bus alone', true);

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  const brokenSandbox = makeSandbox('events-noredis');
  let broken;

  try {
    console.log('\n  When Redis is configured but not there');

    broken = await startServer({
      port: PORT + 2,
      cwd: brokenSandbox,
      env: {
        BLENDER_PATH: createFakeBlender(brokenSandbox),
        WORKER_SECRET: 'test-worker-secret',
        // Nothing listens here; the farm is expected to say so and carry on.
        REDIS_URL: 'redis://127.0.0.1:6399'
      }
    });

    const brokenToken = await adminSession(broken.base);
    const job = await submitJob(broken.base, brokenToken,
      createFakeScene(brokenSandbox, 'noredis.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });

    await waitForCondition(
      async () => (await getJob(broken.base, brokenToken, job.body.jobId)).status === 'completed',
      { label: 'a job to finish with Redis unreachable', timeoutMs: 60000 });

    results.check('the farm starts and renders anyway', true);
  } catch (error) {
    results.check('the farm starts and renders anyway', false, error.message);
  } finally {
    if (broken) await stopServer(broken);
    removeSandbox(brokenSandbox);
  }

  if (!await redisIsThere()) {
    console.log(`\n  Skipping the Redis checks: nothing answering at ${REDIS_URL}`);
    return results;
  }

  console.log('\n  Across two processes, over Redis');

  try {
    // One process waits, another announces, and they share nothing but Redis.
    const listener = busProcess(`
      import { startBus, waitFor, WORK, stopBus } from ${JSON.stringify(path.join(SRC, 'bus.js'))};
      await startBus();
      console.log('ready');
      const heard = await waitFor(WORK, 10000);
      await stopBus();
      console.log(heard ? 'heard' : 'silence');
    `);

    await listener.ready;

    const teller = busProcess(`
      import { startBus, announce, WORK, stopBus } from ${JSON.stringify(path.join(SRC, 'bus.js'))};
      await startBus();
      console.log('ready');
      announce(WORK);
      await new Promise(resolve => setTimeout(resolve, 300));
      await stopBus();
    `);

    await teller.ended;

    const heard = await listener.ended;

    results.check('an announcement in one process reaches a wait in another',
      heard.includes('heard'), JSON.stringify(heard));
  } catch (error) {
    results.check('an announcement in one process reaches a wait in another', false, error.message);
  }

  const redisSandbox = makeSandbox('events-redis');
  let onRedis;

  try {
    onRedis = await startServer({
      port: REDIS_PORT,
      cwd: redisSandbox,
      env: {
        BLENDER_PATH: createFakeBlender(redisSandbox),
        WORKER_SECRET: 'test-worker-secret',
        REDIS_URL
      }
    });

    const redisToken = await adminSession(onRedis.base);
    const waiting = lease(onRedis.base, 20);

    await new Promise(resolve => setTimeout(resolve, 200));
    await submitJob(onRedis.base, redisToken, createFakeScene(redisSandbox, 'onredis.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });

    const answered = await waiting;

    results.check('a farm on Redis answers a held request the same way',
      answered.status === 200 && answered.ms < 1500, `${answered.status} after ${answered.ms}ms`);
  } finally {
    if (onRedis) await stopServer(onRedis);
    removeSandbox(redisSandbox);
  }

  return results;
}
