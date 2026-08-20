// Workers as separate processes. The claim worth proving here is that two of
// them share one job without ever being given the same frame. Losing a worker
// is covered by the lease-expiry checks and the shutdown-survival test, which
// can force that state without needing to find a process id. Runs without Blender.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  createResults, BACKEND_ROOT, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForJob, createFakeBlender, createFakeScene, waitForCondition, auth
} from './helpers.mjs';

const PORT = 5598;

// "[worker-1] 🎬 Job 17..., frame 3 (CYCLES)" - the pool tags each worker's
// output with which one it came from, so the log says who rendered what.
const RENDER_LINE = /\[worker-(\d+)\][^\n]*frame (\d+) \(/g;

function rendersFromLog(log) {
  const renders = [];

  for (const match of log.matchAll(RENDER_LINE)) {
    renders.push({ worker: match[1], frame: Number(match[2]) });
  }

  return renders;
}

export default async function run() {
  const results = createResults('workers');
  const sandbox = makeSandbox('workers');
  let server;
  let remoteWorker;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SLOTS: '2' }
    });

    const token = await adminSession(server.base);

    console.log('\n  Two workers share one job');

    const shared = await submitJob(server.base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const job = await waitForJob(server.base, token, shared.body.jobId, 120000);

    results.check('the job completed', job.status === 'completed', job.status);
    results.check('every frame was delivered', job.completedFrames === 6,
      `${job.completedFrames} of 6`);

    const renders = rendersFromLog(server.getLog());
    const workers = new Set(renders.map(render => render.worker));

    results.check('both workers took part', workers.size === 2, [...workers].join(','));

    results.check('the log records what was rendered', renders.length >= 6,
      `${renders.length} render lines`);

    // The point of the whole lease layer: two workers asking at the same moment
    // must never be given the same frame, or both would render and upload it.
    const frames = renders.map(render => render.frame);
    const duplicates = frames.filter((frame, index) => frames.indexOf(frame) !== index);

    results.check('no frame was rendered twice', duplicates.length === 0,
      `rendered ${frames.sort((a, b) => a - b).join(',')}`);
    results.check('between them they covered the whole range',
      new Set(frames).size === 6, [...new Set(frames)].join(','));

    console.log('\n  A worker with nothing to claim starts the next job');

    const shortJob = await submitJob(server.base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 1
    });
    const longJob = await submitJob(server.base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 4
    });

    const listJobs = async () =>
      (await (await fetch(`${server.base}/jobs`, { headers: auth(token) })).json()).jobs;

    const bothRunning = await waitForCondition(
      async () => {
        const running = (await listJobs()).filter(job => job.status === 'rendering');
        return running.some(job => job.id === shortJob.body.jobId)
          && running.some(job => job.id === longJob.body.jobId);
      },
      { label: 'both jobs to be rendering at once', timeoutMs: 60000 }
    );

    // With one frame between them and two workers, the second worker would sit
    // idle until the first job finished if it could not start the next one.
    results.check('the second job starts before the first has finished', bothRunning);

    for (const submitted of [shortJob, longJob]) {
      const finished = await waitForJob(server.base, token, submitted.body.jobId, 120000);
      results.check(`job ${submitted.body.jobId} finished`, finished.status === 'completed',
        finished.status);
    }

    console.log('\n  A worker somewhere else fetches the scene for itself');

    // Started by hand rather than by the server, told to behave as though it
    // were on another machine: it downloads the .blend over HTTP and renders in
    // its own scratch space instead of reading the server's.
    const elsewhere = makeSandbox('worker-elsewhere');

    remoteWorker = spawn(process.execPath, [path.join(BACKEND_ROOT, 'src', 'worker-main.js')], {
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${PORT}`,
        WORKER_SECRET: 'test-worker-secret',
        BLENDER_PATH: createFakeBlender(elsewhere),
        WORKER_SCRATCH_DIR: elsewhere,
        WORKER_REMOTE: '1',
        WORKER_ID: 'far-away'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let remoteLog = '';
    remoteWorker.stdout.on('data', chunk => { remoteLog += chunk; });
    remoteWorker.stderr.on('data', chunk => { remoteLog += chunk; });

    const distant = await submitJob(server.base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 3
    });
    const distantJob = await waitForJob(server.base, token, distant.body.jobId, 120000);

    results.check('the job finished', distantJob.status === 'completed', distantJob.status);

    await waitForCondition(() => remoteLog.includes('Fetched the scene'),
      { label: 'the distant worker to fetch the scene' });

    results.check('the distant worker fetched the scene over HTTP',
      remoteLog.includes(`Fetched the scene for job ${distant.body.jobId}`), remoteLog.slice(-400));
    results.check('and rendered frames of it',
      /frame \d+ \(/.test(remoteLog), remoteLog.slice(-400));
    results.check('keeping its own copy rather than the server\'s',
      fs.existsSync(path.join(elsewhere, `job_${distant.body.jobId}.blend`)));

    removeSandbox(elsewhere);

  } finally {
    remoteWorker?.kill('SIGKILL');
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
