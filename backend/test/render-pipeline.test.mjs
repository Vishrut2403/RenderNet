// Render pipeline behaviour that a real Blender cannot be made to exhibit on
// demand: a scene that floods stdout, one that takes long enough to cancel
// mid-render, and one that refuses to die on SIGTERM. Runs without Blender.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  login, auth, status, submitJob, waitForJob, getJob,
  createFakeBlender, createFakeScene, waitForCondition
} from './helpers.mjs';

const PORT = 5593;

export default async function run() {
  const results = createResults('render-pipeline');
  const sandbox = makeSandbox('pipeline');
  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const token = await login(base, 'admin', 'admin123');
    const inSandbox = relative => path.join(sandbox, relative);

    console.log('\n  A scene that floods stdout still finishes');
    const noisy = await submitJob(base, token, createFakeScene(sandbox, 'noisy.blend'), {
      frameStart: 1, frameEnd: 2
    });
    // 400KB per frame with nobody draining the pipe used to block Blender
    // mid-write, leaving the job rendering forever.
    const noisyJob = await waitForJob(base, token, noisy.body.jobId, 30000);
    results.check('noisy render completes instead of hanging',
      noisyJob.status === 'completed', `${noisyJob.status}: ${noisyJob.error || ''}`);
    results.check('every frame arrived', noisyJob.completedFrames === 2,
      `got ${noisyJob.completedFrames}`);

    console.log('\n  Blender failures report their output');
    const broken = await submitJob(base, token, createFakeScene(sandbox, 'broken.blend'), {
      frameStart: 1, frameEnd: 1
    });
    const brokenJob = await waitForJob(base, token, broken.body.jobId, 30000);
    results.check('failed render is marked failed', brokenJob.status === 'failed', brokenJob.status);
    results.check('stdout detail survives into the frame error',
      brokenJob.frameErrors[0]?.error.includes('cannot read scene'),
      JSON.stringify(brokenJob.frameErrors[0]?.error));

    console.log('\n  Cancelling mid-render');
    const slow = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const slowId = slow.body.jobId;

    const queued = await submitJob(base, token, createFakeScene(sandbox, 'next.blend'), {
      frameStart: 1, frameEnd: 1
    });
    const queuedId = queued.body.jobId;

    results.check('second job waits behind the first',
      (await getJob(base, token, queuedId)).status === 'pending');

    await waitForCondition(
      async () => (await getJob(base, token, slowId)).completedFrames >= 1,
      { label: 'the first frame to land' }
    );

    const slowBefore = await getJob(base, token, slowId);
    results.check('cancel accepted while rendering',
      await status(`${base}/jobs/${slowId}/cancel`, { method: 'POST', headers: auth(token) }) === 200);

    const scratch = inSandbox(path.join('worker-tmp', `job_${slowId}`));
    const renders = inSandbox(slowBefore.outputFolder);

    const cleared = await waitForCondition(
      () => !fs.existsSync(renders) && !fs.existsSync(scratch) && !fs.existsSync(inSandbox(slowBefore.filePath)),
      { label: 'the cancelled job files to be removed' }
    );

    results.check('cancelled job leaves no render output, scratch or upload behind', cleared,
      `renders=${fs.existsSync(renders)} scratch=${fs.existsSync(scratch)}`);

    const slowAfter = await getJob(base, token, slowId);
    results.check('cancelled job stays cancelled', slowAfter.status === 'cancelled', slowAfter.status);
    results.check('killing the frame is not recorded as a render failure',
      slowAfter.frameErrors.length === 0, JSON.stringify(slowAfter.frameErrors));
    results.check('cancelled job keeps the progress it had',
      slowAfter.completedFrames === slowBefore.completedFrames,
      `${slowBefore.completedFrames} -> ${slowAfter.completedFrames}`);

    const nextJob = await waitForJob(base, token, queuedId, 30000);
    results.check('the queue moves on to the next job', nextJob.status === 'completed', nextJob.status);

    console.log('\n  Cancelling a Blender that ignores SIGTERM');
    const stubborn = await submitJob(base, token, createFakeScene(sandbox, 'stubborn.blend'), {
      frameStart: 1, frameEnd: 2
    });
    const stubbornId = stubborn.body.jobId;

    await waitForCondition(
      async () => (await getJob(base, token, stubbornId)).status === 'rendering',
      { label: 'the stubborn job to start' }
    );

    const after = await submitJob(base, token, createFakeScene(sandbox, 'after.blend'), {
      frameStart: 1, frameEnd: 1
    });

    await fetch(`${base}/jobs/${stubbornId}/cancel`, { method: 'POST', headers: auth(token) });

    // SIGTERM is ignored, so the queue only moves once the escalation lands.
    const followUp = await waitForJob(base, token, after.body.jobId, 30000);
    results.check('SIGKILL escalation releases the queue', followUp.status === 'completed', followUp.status);

    console.log('\n  Cleanup endpoint');
    results.check('anonymous cleanup rejected',
      await status(`http://127.0.0.1:${PORT}/api/cleanup`, { method: 'POST' }) === 401);

    await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plainuser', password: 'plainpass123' })
    });
    const userToken = await login(base, 'plainuser', 'plainpass123');

    results.check('non-admin cleanup rejected',
      await status(`http://127.0.0.1:${PORT}/api/cleanup`, {
        method: 'POST', headers: auth(userToken)
      }) === 403);

    console.log('\n  Cleanup leaves queued work alone');
    const blocker = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const waiting = await submitJob(base, token, createFakeScene(sandbox, 'waiting.blend'), {
      frameStart: 1, frameEnd: 1
    });

    const waitingJob = await getJob(base, token, waiting.body.jobId);
    results.check('the job under test is still queued', waitingJob.status === 'pending', waitingJob.status);

    // Backdate it well past the 48 hour cutoff.
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000);
    fs.utimesSync(inSandbox(waitingJob.filePath), stale, stale);

    results.check('admin can trigger cleanup',
      await status(`http://127.0.0.1:${PORT}/api/cleanup`, {
        method: 'POST', headers: auth(token)
      }) === 200);

    results.check('a queued job keeps its .blend through a sweep',
      fs.existsSync(inSandbox(waitingJob.filePath)));
    results.check('the queued job record survives too',
      (await getJob(base, token, waiting.body.jobId)).status === 'pending');

    for (const id of [blocker.body.jobId, waiting.body.jobId]) {
      await fetch(`${base}/jobs/${id}/cancel`, { method: 'POST', headers: auth(token) });
    }

    console.log('\n  Recovering a job interrupted by a crash');
    const crashed = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const crashedId = crashed.body.jobId;

    await waitForCondition(
      async () => (await getJob(base, token, crashedId)).completedFrames >= 2,
      { label: 'two frames to be delivered', timeoutMs: 30000 }
    );

    const crashedFolder = inSandbox((await getJob(base, token, crashedId)).outputFolder);
    const secondFrame = path.join(crashedFolder, 'frame_0002.png');
    results.check('frames from the interrupted attempt are on disk', fs.existsSync(secondFrame));

    server.proc.kill('SIGKILL');
    await waitForCondition(() => server.proc.exitCode !== null || server.proc.signalCode !== null,
      { label: 'the server to die' });

    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: path.join(sandbox, 'fake-blender') }
    });

    const resumedToken = await login(server.base, 'admin', 'admin123');
    const resumed = await getJob(server.base, resumedToken, crashedId);

    results.check('the interrupted job is queued again',
      ['pending', 'rendering'].includes(resumed.status), resumed.status);
    results.check('its counters are reset', resumed.completedFrames === 0, `got ${resumed.completedFrames}`);
    // The retry restarts from the first frame, so the old frame 2 would sit in
    // the listing and the ZIP as output nothing in this run produced.
    results.check('output from the abandoned attempt is cleared', !fs.existsSync(secondFrame));

    await fetch(`${server.base}/jobs/${crashedId}/cancel`, {
      method: 'POST', headers: auth(resumedToken)
    });

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
