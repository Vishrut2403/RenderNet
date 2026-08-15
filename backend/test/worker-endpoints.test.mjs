// Worker callback endpoints, exercised in-process against the real queue.
// Blender is never spawned, so this suite runs anywhere.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { File } from 'node:buffer';
import { createResults, makeSandbox, removeSandbox, sleep, snapshotEnv } from './helpers.mjs';

const PORT = 5591;
const SECRET = 'test-secret-abc123';

export default async function run() {
  const results = createResults('worker-endpoints');
  const sandbox = makeSandbox('worker');
  const originalCwd = process.cwd();
  const restoreEnv = snapshotEnv(['WORKER_SECRET', 'BLENDER_PATH', 'API_URL', 'DB_PATH']);

  // Set before importing queue.js: db.js and render-worker.js read these at
  // module load. /bin/false makes the dispatched render fail instantly.
  process.env.WORKER_SECRET = SECRET;
  process.env.BLENDER_PATH = '/bin/false';
  process.env.API_URL = `http://127.0.0.1:${PORT}`;
  process.env.DB_PATH = path.join(sandbox, 'worker-test.db');

  process.chdir(sandbox);

  const queue = await import('../src/queue.js');
  const workerRouter = (await import('../src/routes/worker.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/worker', workerRouter);
  const server = app.listen(PORT);

  const base = `http://127.0.0.1:${PORT}/api/worker`;
  const secretHeader = { 'x-worker-secret': SECRET };
  const json = { ...secretHeader, 'Content-Type': 'application/json' };

  try {
    const jobId = queue.addToQueue({
      filePath: 'uploads/test.blend',
      frameStart: 1,
      frameEnd: 4,
      renderEngine: 'CYCLES',
      owner: 'admin',
      originalFilename: 'test.blend'
    });

    // Let the doomed render settle, then restore the mid-render state a live
    // worker would be reporting against.
    await sleep(1500);

    const job = queue.getJob(jobId);
    Object.assign(job, {
      status: 'rendering',
      progress: 0,
      currentFrame: null,
      completedFrames: 0,
      failedFrames: 0,
      uploadedFrames: [],
      frameErrors: [],
      completedAt: null,
      error: null
    });

    console.log('\n  Authentication');
    let res = await fetch(`${base}/jobs/${jobId}/progress`, {
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

    res = await fetch(`${base}/jobs/99999999/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('unknown job is 404', res.status === 404, `got ${res.status}`);

    console.log('\n  Progress');
    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 2 })
    });
    let body = await res.json();
    results.check('progress accepted', res.status === 200, `got ${res.status}`);
    results.check('progress computed server-side (frame 2 of 1-4 is 50%)',
      body.progress === 50, `got ${body.progress}`);

    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST', headers: json, body: JSON.stringify({ currentFrame: 'abc' })
    });
    results.check('non-integer frame rejected', res.status === 400, `got ${res.status}`);

    console.log('\n  Frame upload');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const form = new FormData();
    form.set('frame', new File([png], 'arbitrary-name.png', { type: 'image/png' }));
    res = await fetch(`${base}/jobs/${jobId}/frames/3`, {
      method: 'POST', headers: secretHeader, body: form
    });
    body = await res.json();
    results.check('upload accepted', res.status === 200, `got ${res.status}`);
    results.check('stored under canonical name', body.stored === 'frame_0003.png', `got ${body.stored}`);
    results.check('file written to job output folder',
      fs.existsSync(path.join(sandbox, queue.getJob(jobId).outputFolder, 'frame_0003.png')));
    results.check('progress advanced to 75%', body.progress === 75, `got ${body.progress}`);

    const outOfRange = new FormData();
    outOfRange.set('frame', new File([png], 'x.png', { type: 'image/png' }));
    res = await fetch(`${base}/jobs/${jobId}/frames/99`, {
      method: 'POST', headers: secretHeader, body: outOfRange
    });
    results.check('frame outside job range rejected', res.status === 400, `got ${res.status}`);

    console.log('\n  Frame failure');
    res = await fetch(`${base}/jobs/${jobId}/frames/4/failed`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ error: 'Blender exited with code 1' })
    });
    body = await res.json();
    results.check('failure recorded', res.status === 200 && body.failedFrames === 1, JSON.stringify(body));
    results.check('error detail retained',
      queue.getJob(jobId).frameErrors[0].error === 'Blender exited with code 1');

    console.log('\n  Completion');
    res = await fetch(`${base}/jobs/${jobId}/complete`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ successfulFrames: 3, failedFrames: 1 })
    });
    body = await res.json();
    results.check('completion accepted', res.status === 200, `got ${res.status}`);
    results.check('partial success still completes', body.status === 'completed', `got ${body.status}`);
    results.check('progress pinned to 100', queue.getJob(jobId).progress === 100);
    results.check('completedAt stamped', !!queue.getJob(jobId).completedAt);

    console.log('\n  Cancelled jobs are not resurrected');
    queue.getJob(jobId).status = 'cancelled';
    res = await fetch(`${base}/jobs/${jobId}/complete`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ successfulFrames: 4, failedFrames: 0 })
    });
    body = await res.json();
    results.check('late completion ignored', body.status === 'cancelled', `got ${body.status}`);

  } finally {
    server.close();
    process.chdir(originalCwd);
    restoreEnv();
    removeSandbox(sandbox);
  }

  return results;
}
