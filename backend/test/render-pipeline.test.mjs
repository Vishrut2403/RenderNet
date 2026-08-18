// Render pipeline behaviour that a real Blender cannot be made to exhibit on
// demand: a scene that floods stdout, one that takes long enough to cancel
// mid-render, and one that refuses to die on SIGTERM. Runs without Blender.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  login, auth, status, submitJob, waitForJob, getJob, adminSession, signUp,
  createFakeBlender, createFakeScene, waitForCondition
} from './helpers.mjs';

const PORT = 5593;

export default async function run() {
  const results = createResults('render-pipeline');
  const sandbox = makeSandbox('pipeline');
  // Deliberately not the data directory: on the workstation the server is
  // launched by Task Scheduler, which may start it anywhere.
  const elsewhere = makeSandbox('pipeline-cwd');
  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: elsewhere,
      dataDir: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const token = await adminSession(base);
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

    await signUp(base, 'plainuser', 'plainpass123');
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

    console.log('\n  An urgent job pauses the one rendering');
    const ordinary = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const ordinaryId = ordinary.body.jobId;

    await waitForCondition(
      async () => (await getJob(base, token, ordinaryId)).completedFrames >= 1,
      { label: 'the ordinary job to deliver a frame', timeoutMs: 30000 }
    );

    const beforePause = await getJob(base, token, ordinaryId);

    const urgent = await submitJob(base, token, createFakeScene(sandbox, 'urgent.blend'), {
      frameStart: 1, frameEnd: 2, priority: 1
    });

    const paused = await waitForCondition(
      async () => (await getJob(base, token, ordinaryId)).status === 'pending',
      { label: 'the running job to be paused' }
    );

    results.check('the running job is pushed back to the queue', paused);

    const whilePaused = await getJob(base, token, ordinaryId);
    results.check('it keeps every frame it had delivered',
      whilePaused.completedFrames === beforePause.completedFrames,
      `${beforePause.completedFrames} -> ${whilePaused.completedFrames}`);
    results.check('and records who displaced it', !!whilePaused.pausedBy, whilePaused.pausedBy);
    results.check('pausing is not counted as an interruption',
      (whilePaused.interruptions ?? 0) === 0, `got ${whilePaused.interruptions}`);

    const urgentDone = await waitForJob(base, token, urgent.body.jobId, 30000);
    results.check('the urgent job runs straight away', urgentDone.status === 'completed',
      urgentDone.status);

    const resumedAfterPause = await waitForJob(base, token, ordinaryId, 60000);
    results.check('the paused job then finishes on its own',
      resumedAfterPause.status === 'completed' && resumedAfterPause.completedFrames === 6,
      `${resumedAfterPause.status}, ${resumedAfterPause.completedFrames} frames`);

    // While a paused job's worker winds down, isRendering stays true and
    // currentJobId still points at it. A second urgent job arriving in that
    // window must not queue it twice. The window is milliseconds normally, so
    // this uses the stand-in that ignores SIGTERM and takes the full escalation.
    console.log('\n  A second urgent job does not queue the paused one twice');
    const wedged = await submitJob(base, token, createFakeScene(sandbox, 'stubborn.blend'), {
      frameStart: 1, frameEnd: 2
    });
    const wedgedId = wedged.body.jobId;

    await waitForCondition(
      async () => (await getJob(base, token, wedgedId)).status === 'rendering',
      { label: 'the stubborn job to start' }
    );

    const rush = [];
    for (const name of ['rush-one.blend', 'rush-two.blend']) {
      rush.push(await submitJob(base, token, createFakeScene(sandbox, name), {
        frameStart: 1, frameEnd: 1, priority: 1
      }));
    }

    const waitingIds = (await (await fetch(`${base}/jobs/queue/status`, {
      headers: auth(token)
    })).json()).queue.map(entry => entry.id);

    results.check('the paused job appears in the queue exactly once',
      waitingIds.filter(id => id === wedgedId).length <= 1, JSON.stringify(waitingIds));

    for (const job of rush) {
      const done = await waitForJob(base, token, job.body.jobId, 30000);
      results.check(`urgent job ${job.body.jobId} completes`, done.status === 'completed',
        done.status);
    }

    await fetch(`${base}/jobs/${wedgedId}/cancel`, { method: 'POST', headers: auth(token) });
    await waitForCondition(
      async () => (await getJob(base, token, wedgedId)).status === 'cancelled',
      { label: 'the stubborn job to be cancelled' }
    );

    console.log('\n  Deleting a job frees its space');
    const usageBefore = (await (await fetch(`${base}/jobs`, { headers: auth(token) })).json()).usage;
    results.check('usage is reported with the job list', usageBefore.bytes > 0,
      JSON.stringify(usageBefore));

    const deleted = await fetch(`${base}/jobs/${ordinaryId}`, {
      method: 'DELETE', headers: auth(token)
    });
    results.check('a finished job can be deleted', deleted.status === 200, `got ${deleted.status}`);
    results.check('its frames are gone from disk',
      !fs.existsSync(inSandbox(resumedAfterPause.outputFolder)));

    const usageAfter = (await (await fetch(`${base}/jobs`, { headers: auth(token) })).json()).usage;
    results.check('the space it used is released', usageAfter.bytes < usageBefore.bytes,
      `${usageBefore.bytes} -> ${usageAfter.bytes}`);
    results.check('the job is gone from the list',
      await status(`${base}/jobs/${ordinaryId}`, { headers: auth(token) }) === 404);

    // The workstation is switched off nightly, so a long render meets several
    // shutdowns before it finishes. Each one has to cost at most the frame in
    // flight, and none of them may count against the job.
    console.log('\n  Surviving repeated shutdowns mid-render');

    const restart = async () => {
      server.proc.kill('SIGKILL');
      await waitForCondition(
        () => server.proc.exitCode !== null || server.proc.signalCode !== null,
        { label: 'the server to die' }
      );

      server = await startServer({
        port: PORT,
        cwd: elsewhere,
        dataDir: sandbox,
        env: { BLENDER_PATH: path.join(sandbox, 'fake-blender') }
      });

      return adminSession(server.base);
    };

    const crashed = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const crashedId = crashed.body.jobId;

    let session = token;
    let delivered = 0;
    let firstFrameStamp = null;
    let crashedFolder = null;

    for (let evening = 1; evening <= 3; evening++) {
      const target = delivered + 1;

      await waitForCondition(
        async () => (await getJob(server.base, session, crashedId)).completedFrames >= target,
        { label: `frame ${target} to be delivered`, timeoutMs: 30000 }
      );

      const before = await getJob(server.base, session, crashedId);
      crashedFolder = inSandbox(before.outputFolder);

      if (!firstFrameStamp) {
        firstFrameStamp = fs.statSync(path.join(crashedFolder, 'frame_0001.png')).mtimeMs;
      }

      session = await restart();

      const after = await getJob(server.base, session, crashedId);

      results.check(`shutdown ${evening}: the job is queued again, not failed`,
        ['pending', 'rendering'].includes(after.status), after.status);
      results.check(`shutdown ${evening}: the ${before.completedFrames} frame(s) already done are kept`,
        after.completedFrames === before.completedFrames,
        `${before.completedFrames} -> ${after.completedFrames}`);

      delivered = after.completedFrames;
    }

    // Three interruptions is past the old abandonment threshold; a job that
    // keeps advancing must not be given up on.
    const finished = await waitForJob(server.base, session, crashedId, 60000);
    results.check('the job finishes after three shutdowns', finished.status === 'completed',
      `${finished.status}: ${finished.error || ''}`);
    results.check('every frame ends up rendered', finished.completedFrames === 6,
      `got ${finished.completedFrames}`);
    results.check('no frame was rendered twice',
      fs.readdirSync(crashedFolder).length === 6, fs.readdirSync(crashedFolder).join(','));
    // The strongest evidence that resume picks up rather than starts over.
    results.check('an already-delivered frame is never re-rendered',
      fs.statSync(path.join(crashedFolder, 'frame_0001.png')).mtimeMs === firstFrameStamp);

    console.log('\n  Giving up on a job that never gets anywhere');
    const doomed = await submitJob(base, session, createFakeScene(sandbox, 'hang.blend'), {
      frameStart: 1, frameEnd: 4
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitForCondition(
        async () => (await getJob(server.base, session, doomed.body.jobId)).status === 'rendering',
        { label: 'the doomed job to start' }
      );
      session = await restart();
    }

    const abandoned = await getJob(server.base, session, doomed.body.jobId);
    results.check('a job interrupted repeatedly without rendering anything is abandoned',
      abandoned.status === 'failed', abandoned.status);
    results.check('and says why', /without rendering/.test(abandoned.error || ''), abandoned.error);

    console.log('\n  Data lives where it was configured, not where it was launched');
    results.check('nothing was written to the working directory',
      fs.readdirSync(elsewhere).length === 0, fs.readdirSync(elsewhere).join(','));
    results.check('uploads and renders landed in the data directory',
      fs.existsSync(inSandbox('uploads')) && fs.existsSync(inSandbox('renders')));

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
    removeSandbox(elsewhere);
  }

  // A tiny quota on its own instance: the real 5GB limit is not reachable in a
  // test, and lowering it on the shared server would break everything above.
  const quotaBox = makeSandbox('quota');
  let quotaServer;

  try {
    console.log('\n  The disk quota holds');
    quotaServer = await startServer({
      port: PORT + 1,
      cwd: quotaBox,
      env: {
        BLENDER_PATH: createFakeBlender(quotaBox),
        USER_QUOTA_BYTES: '400'
      }
    });

    const token = await adminSession(quotaServer.base);
    const scene = createFakeScene(quotaBox, 'quota.blend');

    const first = await submitJob(quotaServer.base, token, scene, { frameStart: 1, frameEnd: 1 });
    results.check('an upload inside the quota is accepted', first.status === 200,
      `got ${first.status}`);

    const second = await submitJob(quotaServer.base, token, scene, { frameStart: 1, frameEnd: 1 });
    const third = await submitJob(quotaServer.base, token, scene, { frameStart: 1, frameEnd: 1 });
    const blocked = [second, third].find(res => res.status === 413);

    results.check('an upload over the quota is refused with 413', !!blocked,
      `got ${second.status} then ${third.status}`);
    results.check('and the message says where they stand',
      /GB of your/.test(blocked?.body?.error || ''), blocked?.body?.error);

    const usage = (await (await fetch(`${quotaServer.base}/jobs`, {
      headers: auth(token)
    })).json()).usage;
    results.check('usage reports the quota alongside the bytes used',
      usage.quota === 400 && usage.bytes > 0, JSON.stringify(usage));

    results.check('an admin can see everyone\'s usage',
      await status(`${quotaServer.base}/jobs/usage/all`, { headers: auth(token) }) === 200);

  } finally {
    await stopServer(quotaServer);
    removeSandbox(quotaBox);
  }

  return results;
}
