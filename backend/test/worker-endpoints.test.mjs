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
  createFakeBlender, createFakeScene, waitForCondition
} from './helpers.mjs';
import { checkLeases } from './lease-checks.mjs';

const PORT = 5591;
const SECRET = 'test-secret-abc123';

export default async function run() {
  const results = createResults('worker-endpoints');

  const sandbox = makeSandbox('worker');
  const originalCwd = process.cwd();
  const restoreEnv = snapshotEnv(
    ['WORKER_SECRET', 'BLENDER_PATH', 'API_URL', 'DB_PATH', 'DATA_DIR', 'MAX_FRAME_SPAN',
      'MAX_FRAME_BYTES']);

  // Set before importing queue.js: db.js and render-worker.js read these at
  // module load.
  process.env.WORKER_SECRET = SECRET;
  process.env.BLENDER_PATH = createFakeBlender(sandbox);
  process.env.API_URL = `http://127.0.0.1:${PORT}`;
  process.env.DATA_DIR = sandbox;
  process.env.DB_PATH = path.join(sandbox, 'worker-test.db');
  // The callbacks below need frames the running worker has not taken, and the
  // job it sits on is short. Spans are proved against the endpoints by claiming
  // one here by hand rather than by leaving the worker room to take them.
  process.env.MAX_FRAME_SPAN = '1';
  // Small enough to reach without moving megabytes about; what matters is that
  // the cap is a setting rather than a number written into the route.
  process.env.MAX_FRAME_BYTES = '2048';

  process.chdir(sandbox);
  fs.mkdirSync('uploads', { recursive: true });

  const queue = await import('../src/queue.js');
  const views = await import('../src/job-views.js');
  const { jobs } = await import('../src/job-store.js');
  const db = await import('../src/db.js');
  const workerRouter = (await import('../src/routes/worker.js')).default;
  const registry = await import('../src/worker-registry.js');
  // index.js does this at boot; this suite mounts the router on its own.
  const tokens = await import('../src/worker-tokens.js');
  tokens.importSharedSecret();
  // Frames may only be sent by the machine holding the claim, so the stand-in
  // claims them as the machine whose token it sends.
  const standIn = tokens.machineFor(SECRET).id;

  const app = express();
  app.use(express.json());
  app.use('/api/worker', workerRouter);
  const server = app.listen(PORT);

  const base = `http://127.0.0.1:${PORT}/api/worker`;
  const secretHeader = { 'x-worker-token': SECRET };
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
      const job = views.getJob(id);
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

    results.check('final counts come from what the server received',
      quick.completedFrames === 4 && quick.failedFrames === 0,
      JSON.stringify({ completed: quick.completedFrames, failed: quick.failedFrames }));

    let res;
    let body;

    // This one occupies the worker for a minute so the callbacks below run
    // against a job that is genuinely mid-render; the next stays queued behind
    // it, which is the state a cancellation has to be safe in.
    const jobId = submit('hang.blend');
    const queuedId = submit('hang-two.blend');

    await sleep(500);
    results.check('job is rendering while its frames are outstanding',
      views.getJob(jobId).status === 'rendering', views.getJob(jobId).status);

    console.log('\n  Authentication');
    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('missing secret is rejected', res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-token': 'wrong-length-value' },
      body: JSON.stringify({ currentFrame: 1 })
    });
    results.check('wrong secret is rejected', res.status === 401, `got ${res.status}`);

    // Same character count as the secret, one byte longer once encoded, which
    // is what a raw timingSafeEqual comparison throws on.
    res = await fetch(`${base}/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-token': 'tést-secret-abc123' },
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

    // A frame may only be sent by whoever holds the claim on it, so this stands
    // in for a worker and claims everything the running one has not already
    // taken - which is frame 1, the one the stand-in Blender is sitting on.
    // The worker runs in its own process now, so it takes a moment to start up
    // and claim the frame it is going to sit on.
    await waitForCondition(
      () => db.liveLeases().some(lease => lease.jobId === jobId && lease.frame === 1),
      { label: 'the worker to claim its first frame' }
    );

    // Taken as one span and then singly, so both the frames a single claim
    // covers and the frames it does not are under test below.
    const claims = new Map();
    const span = db.leaseFrames(jobId, standIn, 600_000, 2);

    for (const frame of span?.frames ?? []) claims.set(frame, span.leaseId);

    for (;;) {
      const claim = db.leaseFrames(jobId, standIn, 600_000, 1);
      if (!claim) break;
      claims.set(claim.frames[0], claim.leaseId);
    }

    results.check('the frame the worker is rendering cannot be claimed',
      !claims.has(1) && claims.has(2), [...claims.keys()].join(','));
    results.check('one claim covers a span of frames',
      span?.frames.join(',') === '2,3', JSON.stringify(span?.frames));

    const uploadFrame = async (frame, leaseId) => {
      const form = new FormData();
      form.set('frame', new File([png], 'arbitrary-name.png', { type: 'image/png' }));
      const response = await fetch(`${base}/jobs/${jobId}/frames/${frame}`, {
        method: 'POST',
        headers: leaseId ? { ...secretHeader, 'x-lease-id': leaseId } : secretHeader,
        body: form
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };

    const unclaimed = await uploadFrame(3, null);
    results.check('a frame sent without a claim is refused', unclaimed.status === 409,
      `got ${unclaimed.status}`);

    const wrongFrame = await uploadFrame(3, claims.get(4));
    results.check('a claim on another frame does not authorise this one',
      wrongFrame.status === 409, `got ${wrongFrame.status}`);

    const oversized = new FormData();
    oversized.set('frame', new File([Buffer.alloc(4096)], 'frame.png', { type: 'image/png' }));

    const refused = await fetch(`${base}/jobs/${jobId}/frames/3`, {
      method: 'POST',
      headers: { ...secretHeader, 'x-lease-id': claims.get(3) },
      body: oversized
    });

    results.check('a frame past the size limit is refused, and told what the limit is',
      refused.status === 413 && /may not exceed/.test((await refused.json()).error ?? ''),
      `got ${refused.status}`);

    // A render cut short leaves a file with the right name and the wrong bytes,
    // which nothing downstream would notice until somebody opened the ZIP.
    const truncated = new FormData();
    truncated.set('frame', new File([Buffer.alloc(64)], 'frame.png', { type: 'image/png' }));

    const wrongInside = await fetch(`${base}/jobs/${jobId}/frames/3`, {
      method: 'POST',
      headers: { ...secretHeader, 'x-lease-id': claims.get(3) },
      body: truncated
    });

    results.check('a file that is not the picture it is named as is refused',
      wrongInside.status === 422, `got ${wrongInside.status}`);
    results.check('and no frame is recorded for it',
      views.getJob(jobId).completedFrames === 0,
      `${views.getJob(jobId).completedFrames} delivered`);

    let upload = await uploadFrame(3, claims.get(3));
    results.check('upload accepted', upload.status === 200, `got ${upload.status}`);
    results.check('stored under canonical name', upload.body.stored === 'frame_0003.png',
      `got ${upload.body.stored}`);
    results.check('file written to job output folder',
      fs.existsSync(path.join(sandbox, views.getJob(jobId).outputFolder, 'frame_0003.png')));
    results.check('progress counts frames delivered, not frame position (1 of 4)',
      upload.body.progress === 25, `got ${upload.body.progress}`);

    upload = await uploadFrame(2, claims.get(2));
    results.check('a second frame advances progress to 50%', upload.body.progress === 50,
      `got ${upload.body.progress}`);
    // Frames 2 and 3 were claimed together, so the same lease id had to carry
    // both of them - one claim, several frames.
    results.check('every frame a span covers may be sent under its one claim',
      claims.get(2) === claims.get(3) && upload.status === 200, claims.get(2));

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
    // A frame that failed goes back into circulation without its claim, so each
    // attempt is a fresh one - which is what lets another worker pick it up.
    const failFrame = async () => {
      if (!db.getLease(claims.get(4))) {
        const again = db.leaseFrames(jobId, standIn, 600_000, 1);
        claims.set(again.frames[0], again.leaseId);
      }

      const response = await fetch(`${base}/jobs/${jobId}/frames/4/failed`, {
        method: 'POST',
        headers: { ...json, 'x-lease-id': claims.get(4) },
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
      views.getJob(jobId).frameErrors[0].error === 'Blender exited with code 1',
      JSON.stringify(views.getJob(jobId).frameErrors));

    console.log('\n  Cancelled jobs are not resurrected');
    const outputFolder = path.join(sandbox, views.getJob(queuedId).outputFolder);
    results.check('cancelling the queued job succeeds', queue.cancelJob(queuedId).success);
    results.check('its output folder is removed', !fs.existsSync(outputFolder));

    results.check('a cancelled job stays cancelled',
      views.getJob(queuedId).status === 'cancelled', views.getJob(queuedId).status);

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

    const untouched = views.getJob(queuedId);
    results.check('cancelled job counters are left alone',
      untouched.progress === 0 && untouched.completedFrames === 0
      && untouched.frameErrors.length === 0,
      JSON.stringify({ progress: untouched.progress, done: untouched.completedFrames }));

    console.log('\n  Frame leases');
    await checkLeases(db, results);

    console.log('\n  A machine part way through a span is still here');

    // A worker asks for work once a span, so on a long one it can go minutes
    // without saying anything but the renewals - and a machine dropped from the
    // registry stops counting towards how wide the next span may be.
    db.markFramePending(jobId, 4);
    const busy = db.leaseFrames(jobId, 'busy-machine', 600_000, 1);

    registry.announceWorker({ workerId: 'busy-machine', name: 'busy', engines: ['CYCLES'] });
    registry.announceWorker({ workerId: 'quiet-machine', name: 'quiet', engines: ['CYCLES'] });

    // Six minutes on, past the five a machine is counted as current for.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;

    try {
      results.check('the claim can still be renewed',
        queue.renewFrameLease(busy.leaseId).ok === true);

      const here = registry.machines().map(machine => machine.id);

      results.check('a machine that has only renewed is still counted',
        here.includes('busy-machine'), here.join(','));
      results.check('while one that has said nothing at all is not',
        !here.includes('quiet-machine'), here.join(','));
    } finally {
      Date.now = realNow;
    }

  } finally {
    // Stops the stand-in Blender still sitting on its first frame.
    for (const job of jobs.values()) {
      if (job.status === 'rendering' || job.status === 'pending') queue.cancelJob(job.id);
    }

    queue.stopWorkers();
    server.close();
    process.chdir(originalCwd);
    restoreEnv();
    removeSandbox(sandbox);
  }

  return results;
}
