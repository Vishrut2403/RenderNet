// Worker callback endpoints, exercised in-process against the real queue. A
// stand-in for Blender sits on its first frame for a minute, so the callbacks
// run against a job that is genuinely mid-render rather than one forced into
// that state by hand.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { File } from 'node:buffer';
import {
  createResults, makeSandbox, removeSandbox, sleep, snapshotEnv,
  createFakeBlender, createFakeScene, FAKE_BLENDER_SUPPORTED
} from './helpers.mjs';

const PORT = 5591;
const SECRET = 'test-secret-abc123';

export default async function run() {
  const results = createResults('worker-endpoints');

  if (!FAKE_BLENDER_SUPPORTED) {
    results.skipped('worker callback suite', 'the Blender stand-in cannot run on Windows');
    return results;
  }

  const sandbox = makeSandbox('worker');
  const originalCwd = process.cwd();
  const restoreEnv = snapshotEnv(['WORKER_SECRET', 'BLENDER_PATH', 'API_URL', 'DB_PATH', 'DATA_DIR']);

  // Set before importing queue.js: db.js and render-worker.js read these at
  // module load.
  process.env.WORKER_SECRET = SECRET;
  process.env.BLENDER_PATH = createFakeBlender(sandbox);
  process.env.API_URL = `http://127.0.0.1:${PORT}`;
  process.env.DATA_DIR = sandbox;
  process.env.DB_PATH = path.join(sandbox, 'worker-test.db');

  process.chdir(sandbox);
  fs.mkdirSync('uploads', { recursive: true });

  const queue = await import('../src/queue.js');
  const workerRouter = (await import('../src/routes/worker.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/worker', workerRouter);
  const server = app.listen(PORT);

  const base = `http://127.0.0.1:${PORT}/api/worker`;
  const secretHeader = { 'x-worker-secret': SECRET };
  const json = { ...secretHeader, 'Content-Type': 'application/json' };

  const submit = scene => queue.addToQueue({
    filePath: createFakeScene('uploads', scene),
    frameStart: 1,
    frameEnd: 4,
    renderEngine: 'CYCLES',
    owner: 'admin',
    originalFilename: scene
  });

  const settle = async (id, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = queue.getJob(id);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await sleep(100);
    }

    throw new Error(`Job ${id} did not settle`);
  };

  try {
    console.log('\n  A job rendering end to end in process');
    const quickId = submit('quick.blend');
    const quick = await settle(quickId);

    results.check('the worker renders and delivers every frame',
      quick.status === 'completed' && quick.completedFrames === 4,
      `${quick.status}, ${quick.completedFrames} frames`);
    results.check('progress pinned to 100', quick.progress === 100, `got ${quick.progress}`);
    results.check('completedAt stamped', !!quick.completedAt);

    // The worker's closing tally is advisory; the server counts what arrived.
    let res = await fetch(`${base}/jobs/${quickId}/complete`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ successfulFrames: 99, failedFrames: 99 })
    });
    let body = await res.json();
    results.check('final counts come from what the server received',
      body.completedFrames === 4 && body.failedFrames === 0,
      JSON.stringify({ completed: body.completedFrames, failed: body.failedFrames }));

    // This one occupies the worker for a minute so the callbacks below run
    // against a job that is genuinely mid-render; the next stays queued behind
    // it, which is the state a cancellation has to be safe in.
    const jobId = submit('hang.blend');
    const queuedId = submit('hang-two.blend');

    await sleep(500);
    results.check('job is rendering while its frames are outstanding',
      queue.getJob(jobId).status === 'rendering', queue.getJob(jobId).status);

    console.log('\n  Authentication');
    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('missing secret is rejected', res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': 'wrong-length-value' },
      body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('wrong secret is rejected', res.status === 401, `got ${res.status}`);

    // Same character count as the secret, one byte longer once encoded, which
    // is what a raw timingSafeEqual comparison throws on.
    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': 'tést-secret-abc123' },
      body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('multi-byte secret of the same length is rejected, not a server error',
      res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/jobs/99999999/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('unknown job is 404', res.status === 404, `got ${res.status}`);

    console.log('\n  Frame upload');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const uploadFrame = async frame => {
      const form = new FormData();
      form.set('frame', new File([png], 'arbitrary-name.png', { type: 'image/png' }));
      const response = await fetch(`${base}/jobs/${jobId}/frames/${frame}`, {
        method: 'POST', headers: secretHeader, body: form
      });
      return { status: response.status, body: await response.json() };
    };

    let upload = await uploadFrame(3);
    results.check('upload accepted', upload.status === 200, `got ${upload.status}`);
    results.check('stored under canonical name', upload.body.stored === 'frame_0003.png',
      `got ${upload.body.stored}`);
    results.check('file written to job output folder',
      fs.existsSync(path.join(sandbox, queue.getJob(jobId).outputFolder, 'frame_0003.png')));
    results.check('progress counts frames delivered, not frame position (1 of 4)',
      upload.body.progress === 25, `got ${upload.body.progress}`);

    upload = await uploadFrame(1);
    results.check('a second frame advances progress to 50%', upload.body.progress === 50,
      `got ${upload.body.progress}`);

    const outOfRange = new FormData();
    outOfRange.set('frame', new File([png], 'x.png', { type: 'image/png' }));
    res = await fetch(`${base}/jobs/${jobId}/frames/99`, {
      method: 'POST', headers: secretHeader, body: outOfRange
    });
    results.check('frame outside job range rejected', res.status === 400, `got ${res.status}`);

    console.log('\n  Progress');
    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 2 })
    });
    body = await res.json();
    results.check('progress accepted', res.status === 200, `got ${res.status}`);
    results.check('reported frame is recorded', body.currentFrame === 2, `got ${body.currentFrame}`);
    results.check('progress stays tied to delivered frames', body.progress === 50,
      `got ${body.progress}`);

    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 'abc' })
    });
    results.check('non-integer frame rejected', res.status === 400, `got ${res.status}`);

    console.log('\n  Frame retries');
    const failFrame = async () => {
      const response = await fetch(`${base}/jobs/${jobId}/frames/4/failed`, {
        method: 'POST', headers: json,
        body: JSON.stringify({ error: 'Blender exited with code 1' })
      });
      return response.json();
    };

    body = await failFrame();
    results.check('first failure asks the worker to retry', body.retry === true, JSON.stringify(body));
    results.check('a frame with attempts left is not counted as failed',
      body.failedFrames === 0, `got ${body.failedFrames}`);

    body = await failFrame();
    results.check('second failure still retries', body.retry === true, JSON.stringify(body));

    body = await failFrame();
    results.check('third failure gives up on the frame', body.retry === false, JSON.stringify(body));
    results.check('the exhausted frame is counted as failed', body.failedFrames === 1,
      `got ${body.failedFrames}`);
    results.check('error detail retained',
      queue.getJob(jobId).frameErrors[0].error === 'Blender exited with code 1',
      JSON.stringify(queue.getJob(jobId).frameErrors));

    console.log('\n  Cancelled jobs are not resurrected');
    const outputFolder = path.join(sandbox, queue.getJob(queuedId).outputFolder);
    results.check('cancelling the queued job succeeds', queue.cancelJob(queuedId).success);
    results.check('its output folder is removed', !fs.existsSync(outputFolder));

    res = await fetch(`${base}/jobs/${queuedId}/complete`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ successfulFrames: 4, failedFrames: 0 })
    });
    body = await res.json();
    results.check('late completion ignored', body.status === 'cancelled', `got ${body.status}`);

    res = await fetch(`${base}/jobs/${queuedId}/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 4 })
    });
    results.check('late progress rejected', res.status === 409, `got ${res.status}`);

    const lateFrame = new FormData();
    lateFrame.set('frame', new File([png], 'late.png', { type: 'image/png' }));
    res = await fetch(`${base}/jobs/${queuedId}/frames/2`, {
      method: 'POST', headers: secretHeader, body: lateFrame
    });
    results.check('late frame upload rejected', res.status === 409, `got ${res.status}`);
    results.check('late frame does not recreate the deleted output folder',
      !fs.existsSync(outputFolder));

    res = await fetch(`${base}/jobs/${queuedId}/frames/2/failed`, {
      method: 'POST', headers: json, body: JSON.stringify({ error: 'signal SIGTERM' })
    });
    results.check('late frame failure rejected', res.status === 409, `got ${res.status}`);

    const untouched = queue.getJob(queuedId);
    results.check('cancelled job counters are left alone',
      untouched.progress === 0 && untouched.completedFrames === 0
      && untouched.frameErrors.length === 0,
      JSON.stringify({ progress: untouched.progress, done: untouched.completedFrames }));

  } finally {
    // Stops the stand-in Blender still sitting on its first frame.
    for (const job of queue.getAllJobs()) {
      if (job.status === 'rendering' || job.status === 'pending') queue.cancelJob(job.id);
    }

    server.close();
    process.chdir(originalCwd);
    restoreEnv();
    removeSandbox(sandbox);
  }

  return results;
}
