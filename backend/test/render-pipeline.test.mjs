// Render pipeline behaviour that a real Blender cannot be made to exhibit on
// demand: a scene that floods stdout, one that takes long enough to cancel
// mid-render, and one that refuses to stop when asked. Runs without Blender.
import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  login, auth, status, submitJob, waitForJob, getJob, adminSession, signUp,
  createFakeBlender, createFakeScene, waitForCondition, stubbornIsUnkillable,
  fakeBlenderPath
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

    console.log('\n  Cancelling a Blender that refuses to stop');
    const stubborn = await submitJob(base, token, createFakeScene(sandbox, 'stubborn.blend'), {
      frameStart: 1, frameEnd: 2
    });
    const stubbornId = stubborn.body.jobId;

    await stubbornIsUnkillable(sandbox, stubbornId);

    const after = await submitJob(base, token, createFakeScene(sandbox, 'after.blend'), {
      frameStart: 1, frameEnd: 1
    });

    const cancelledAt = Date.now();
    await fetch(`${base}/jobs/${stubbornId}/cancel`, { method: 'POST', headers: auth(token) });

    // A polite stop is ignored, so the queue only moves once the forceful one
    // lands - SIGKILL on POSIX, taskkill on Windows. Left to itself the
    // stand-in exits after 60s, so the bound is what separates a real
    // escalation from simply outwaiting the process.
    const released = await waitForCondition(
      async () => (await getJob(base, token, after.body.jobId)).status === 'completed',
      { timeoutMs: 25000, label: 'the queue to be released by a forceful kill' }
    );
    const releasedIn = Date.now() - cancelledAt;

    results.check('forceful termination releases the queue', released, `after ${releasedIn}ms`);
    results.check('and does not wait out the process on its own', releasedIn < 25000,
      `${releasedIn}ms`);

    console.log('\n  Previewing a frame while the render is still going');
    const previewing = await submitJob(base, token, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 4
    });
    const previewId = previewing.body.jobId;

    const previewUrl = `${base}/download/${previewId}/preview`;

    results.check('nothing to preview before the first frame lands',
      await status(previewUrl, { headers: auth(token) }) === 404);

    await waitForCondition(
      async () => (await getJob(base, token, previewId)).completedFrames > 0,
      { label: 'the first frame of the previewed job' }
    );

    const midRender = await getJob(base, token, previewId);
    results.check('the job is still rendering', midRender.status === 'rendering', midRender.status);

    const preview = await fetch(previewUrl, { headers: auth(token) });
    const image = Buffer.from(await preview.arrayBuffer());

    results.check('a frame is served while the job runs', preview.status === 200, `got ${preview.status}`);
    results.check('and it really is a PNG',
      image.subarray(1, 4).toString() === 'PNG', image.subarray(0, 8).toString('hex'));
    results.check('the frame it came from is named',
      Number(preview.headers.get('x-frame-number')) > 0, preview.headers.get('x-frame-number'));

    results.check('the listing still refuses until the job stops',
      await status(`${base}/download/${previewId}/files`, { headers: auth(token) }) === 400);

    await signUp(base, 'peeper', 'peeperpass123');
    const peeperToken = await login(base, 'peeper', 'peeperpass123');

    results.check('another user cannot preview it',
      await status(previewUrl, { headers: auth(peeperToken) }) === 403);
    results.check('and an anonymous request cannot either',
      await status(previewUrl) === 401);

    await fetch(`${base}/jobs/${previewId}/cancel`, { method: 'POST', headers: auth(token) });
    await waitForCondition(
      async () => (await getJob(base, token, previewId)).status === 'cancelled',
      { label: 'the previewed job to be cancelled' }
    );

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
    // this uses the stand-in that refuses to stop and has to be killed outright.
    console.log('\n  A second urgent job does not queue the paused one twice');
    const wedged = await submitJob(base, token, createFakeScene(sandbox, 'stubborn.blend'), {
      frameStart: 1, frameEnd: 2
    });
    const wedgedId = wedged.body.jobId;

    await stubbornIsUnkillable(sandbox, wedgedId);

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

    // A job paused for something more important is 'pending', so nothing about
    // it looks in flight - but its worker still owns the slot and its Blender
    // may still be alive. This walks the path end to end; it does not prove the
    // ordering, which converges either way once the worker settles.
    console.log('\n  Cancelling a job that is paused but still winding down');
    const pausing = await submitJob(base, token, createFakeScene(sandbox, 'stubborn.blend'), {
      frameStart: 1, frameEnd: 2
    });
    const pausingId = pausing.body.jobId;

    await stubbornIsUnkillable(sandbox, pausingId);

    const jumper = await submitJob(base, token, createFakeScene(sandbox, 'jumper.blend'), {
      frameStart: 1, frameEnd: 1, priority: 1
    });

    await waitForCondition(
      async () => (await getJob(base, token, pausingId)).status === 'pending',
      { label: 'the stubborn job to be paused' }
    );

    const cancelPaused = await fetch(`${base}/jobs/${pausingId}/cancel`, {
      method: 'POST', headers: auth(token)
    });
    results.check('a paused job can be cancelled', cancelPaused.status === 200,
      `got ${cancelPaused.status}`);

    const jumperDone = await waitForJob(base, token, jumper.body.jobId, 30000);
    results.check('the urgent job that displaced it still finishes',
      jumperDone.status === 'completed', jumperDone.status);

    const cancelledWhilePaused = await getJob(base, token, pausingId);
    const leftBehind = [
      inSandbox(cancelledWhilePaused.outputFolder),
      path.join(sandbox, 'worker-tmp', `job_${pausingId}`)
    ].filter(fs.existsSync);

    results.check('cancelling a paused job clears up once its worker stops',
      leftBehind.length === 0, leftBehind.join(','));

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
        env: { BLENDER_PATH: fakeBlenderPath(sandbox) }
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

    // Abandoning a job must not abandon the frames it already delivered: those
    // are the only thing standing between the user and re-rendering the range.
    console.log('\n  Frames delivered before a job is given up on stay downloadable');
    const stalled = await submitJob(base, session, createFakeScene(sandbox, 'stalls.blend'), {
      frameStart: 1, frameEnd: 4
    });
    const stalledId = stalled.body.jobId;

    await waitForCondition(
      async () => (await getJob(server.base, session, stalledId)).completedFrames === 1,
      { label: 'the first frame to be delivered', timeoutMs: 30000 }
    );

    // One more shutdown than the doomed job above: the first restart sees a
    // frame delivered since submission, so it does not count as a lost evening.
    for (let attempt = 1; attempt <= 4; attempt++) {
      await waitForCondition(
        async () => (await getJob(server.base, session, stalledId)).status === 'rendering',
        { label: 'the stalled job to pick back up' }
      );
      session = await restart();
    }

    const givenUp = await getJob(server.base, session, stalledId);
    results.check('a job given up on part-way is marked failed', givenUp.status === 'failed',
      givenUp.status);
    results.check('and keeps the frame it did deliver', givenUp.completedFrames === 1,
      `got ${givenUp.completedFrames}`);

    const listing = await fetch(`${server.base}/download/${stalledId}/files`, {
      headers: auth(session)
    });
    const listed = await listing.json();

    results.check('its finished frames are still listed',
      listing.status === 200 && listed.totalFiles === 1,
      `${listing.status} ${JSON.stringify(listed)}`);
    results.check('and the listing marks the set as partial', listed.partial === true,
      JSON.stringify(listed.partial));

    const partialZip = await fetch(`${server.base}/download/${stalledId}/zip`, {
      headers: auth(session)
    });
    const zipBytes = Buffer.from(await partialZip.arrayBuffer());

    results.check('a partial ZIP downloads', partialZip.status === 200, `got ${partialZip.status}`);
    results.check('it is named so the user knows it is incomplete',
      /render_\d+_partial\.zip/.test(partialZip.headers.get('content-disposition') || ''),
      partialZip.headers.get('content-disposition'));
    results.check('and it really is an archive with something in it',
      zipBytes.length > 100 && zipBytes.subarray(0, 2).toString() === 'PK',
      `${zipBytes.length} bytes`);

    const nothingToGet = await fetch(`${server.base}/download/${doomed.body.jobId}/zip`, {
      headers: auth(session)
    });
    results.check('a job that delivered nothing still refuses to download',
      nothingToGet.status === 400, `got ${nothingToGet.status}`);

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

  // Pruning is by job age, deleting is by file age, and the two disagree: a
  // render's mtime is its last frame, long after the job was created. Its own
  // instance because it needs a retention window nothing else can tolerate.
  const pruneBox = makeSandbox('prune');
  let pruneServer;

  try {
    console.log('\n  Space still on disk keeps counting against its owner');
    pruneServer = await startServer({
      port: PORT + 2,
      cwd: pruneBox,
      // Negative: the cutoff lands in the future, so every job record is old
      // enough to prune and only the files' mtimes decide anything.
      env: { BLENDER_PATH: createFakeBlender(pruneBox), RETENTION_DAYS: '-1' }
    });

    const pruneToken = await adminSession(pruneServer.base);
    const kept = await submitJob(
      pruneServer.base, pruneToken, createFakeScene(pruneBox, 'keeper.blend'),
      { frameStart: 1, frameEnd: 2 }
    );
    const keptJob = await waitForJob(pruneServer.base, pruneToken, kept.body.jobId, 30000);

    const usage = async () => (await (await fetch(`${pruneServer.base}/jobs`, {
      headers: auth(pruneToken)
    })).json()).usage;

    const beforeSweep = await usage();
    results.check('a finished job uses space', beforeSweep.bytes > 0,
      JSON.stringify(beforeSweep));

    const upload = path.join(pruneBox, keptJob.filePath);
    const renders = path.join(pruneBox, keptJob.outputFolder);
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    fs.utimesSync(upload, future, future);
    fs.utimesSync(renders, future, future);

    const sweep = () => fetch(`http://127.0.0.1:${PORT + 2}/api/cleanup`, {
      method: 'POST', headers: auth(pruneToken)
    });

    await sweep();

    results.check('files too new to delete are still there',
      fs.existsSync(upload) && fs.existsSync(renders));
    results.check('the job that owns them survives the sweep',
      await status(`${pruneServer.base}/jobs/${keptJob.id}`, { headers: auth(pruneToken) }) === 200);

    const afterSweep = await usage();
    results.check('and its bytes still count against the owner',
      afterSweep.bytes === beforeSweep.bytes,
      `${beforeSweep.bytes} -> ${afterSweep.bytes}`);

    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(upload, past, past);
    fs.utimesSync(renders, past, past);

    await sweep();

    results.check('once the files age out they are deleted',
      !fs.existsSync(upload) && !fs.existsSync(renders),
      `upload=${fs.existsSync(upload)} renders=${fs.existsSync(renders)}`);
    results.check('and only then is the job record pruned',
      await status(`${pruneServer.base}/jobs/${keptJob.id}`, { headers: auth(pruneToken) }) === 404);
    results.check('the space is released with it', (await usage()).bytes === 0,
      JSON.stringify(await usage()));

  } finally {
    await stopServer(pruneServer);
    removeSandbox(pruneBox);
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

  // Blender has no flag for either, so they are only visible in the command
  // line the worker builds.
  const settingsBox = makeSandbox('settings');
  let settingsServer;

  try {
    console.log('\n  Render settings reach Blender');

    settingsServer = await startServer({
      port: PORT + 8,
      cwd: settingsBox,
      env: { BLENDER_PATH: createFakeBlender(settingsBox) }
    });

    const settingsToken = await adminSession(settingsServer.base);
    const lastArgs = () => fs.readFileSync(path.join(settingsBox, 'uploads', 'last-args.txt'), 'utf8');

    const plain = await submitJob(
      settingsServer.base, settingsToken, createFakeScene(settingsBox, 'plain.blend'),
      { frameStart: 1, frameEnd: 1 }
    );
    await waitForJob(settingsServer.base, settingsToken, plain.body.jobId, 30000);

    results.check('a job with no overrides keeps the plain command line',
      !lastArgs().includes('--python-expr'), lastArgs());

    const tuned = await submitJob(
      settingsServer.base, settingsToken, createFakeScene(settingsBox, 'tuned.blend'),
      { frameStart: 1, frameEnd: 1, resolutionPercent: 25, samples: 8 }
    );
    const tunedJob = await waitForJob(settingsServer.base, settingsToken, tuned.body.jobId, 30000);

    results.check('the render finishes with the overrides applied',
      tunedJob.status === 'completed', tunedJob.status);
    results.check('resolution is set on the scene',
      lastArgs().includes('s.render.resolution_percentage=25'), lastArgs());
    results.check('samples are set on the scene',
      lastArgs().includes('s.cycles.samples=8'), lastArgs());
    results.check('and the expression carries no newline, which cmd.exe could not',
      !lastArgs().split('--python-expr')[1]?.startsWith('\n'), lastArgs());
    results.check('the settings are remembered on the job',
      tunedJob.resolutionPercent === 25 && tunedJob.samples === 8,
      `${tunedJob.resolutionPercent}% / ${tunedJob.samples}`);

    // EEVEE has no sample count of the kind Cycles means, so asking for one
    // must not put an attribute on the scene that does not exist.
    const eevee = await submitJob(
      settingsServer.base, settingsToken, createFakeScene(settingsBox, 'eevee.blend'),
      { frameStart: 1, frameEnd: 1, engine: 'BLENDER_EEVEE', resolutionPercent: 50, samples: 8 }
    );
    await waitForJob(settingsServer.base, settingsToken, eevee.body.jobId, 30000);

    results.check('samples are left alone for engines that have no cycles settings',
      lastArgs().includes('resolution_percentage=50') && !lastArgs().includes('cycles.samples'),
      lastArgs());

  } finally {
    await stopServer(settingsServer);
    removeSandbox(settingsBox);
  }

  // Retrying a frame that failed for a reason since put right, without paying
  // again for the frames that were fine.
  const rerunBox = makeSandbox('rerun');
  let rerunServer;

  try {
    console.log('\n  Rerunning only the frames that failed');

    rerunServer = await startServer({
      port: PORT + 7,
      cwd: rerunBox,
      env: { BLENDER_PATH: createFakeBlender(rerunBox) }
    });

    const rerunToken = await adminSession(rerunServer.base);
    const flaky = await submitJob(
      rerunServer.base, rerunToken, createFakeScene(rerunBox, 'flaky.blend'),
      { frameStart: 1, frameEnd: 2 }
    );
    const flakyId = flaky.body.jobId;

    const settled = await waitForJob(rerunServer.base, rerunToken, flakyId, 60000);
    results.check('the job stops with one frame delivered and one failed',
      settled.completedFrames === 1 && settled.failedFrames === 1,
      `${settled.completedFrames} done, ${settled.failedFrames} failed`);

    const folder = path.join(rerunBox, settled.outputFolder);
    const firstStamp = fs.statSync(path.join(folder, 'frame_0001.png')).mtimeMs;

    const tooSoon = await fetch(`${rerunServer.base}/jobs/${flakyId}/rerun`, {
      method: 'POST', headers: auth(rerunToken)
    });
    const tooSoonBody = await tooSoon.json();
    results.check('rerunning before the cause is fixed is allowed but fails again',
      tooSoon.status === 200 && tooSoonBody.frames === 1, JSON.stringify(tooSoonBody));

    await waitForJob(rerunServer.base, rerunToken, flakyId, 60000);

    // What the user would have gone away and put right.
    fs.writeFileSync(path.join(rerunBox, 'uploads', 'fixed'), '');

    const again = await fetch(`${rerunServer.base}/jobs/${flakyId}/rerun`, {
      method: 'POST', headers: auth(rerunToken)
    });
    results.check('the fixed job can be rerun', again.status === 200, `got ${again.status}`);

    const repaired = await waitForJob(rerunServer.base, rerunToken, flakyId, 60000);
    results.check('and finishes with every frame',
      repaired.completedFrames === 2 && repaired.failedFrames === 0,
      `${repaired.completedFrames} done, ${repaired.failedFrames} failed`);
    results.check('the frame that already worked was never re-rendered',
      fs.statSync(path.join(folder, 'frame_0001.png')).mtimeMs === firstStamp);
    results.check('and its earlier error is cleared',
      (repaired.frameErrors ?? []).length === 0, JSON.stringify(repaired.frameErrors));

    const nothingLeft = await fetch(`${rerunServer.base}/jobs/${flakyId}/rerun`, {
      method: 'POST', headers: auth(rerunToken)
    });
    results.check('a job with nothing left to retry is refused',
      nothingLeft.status === 400, `got ${nothingLeft.status}`);

    await signUp(rerunServer.base, 'notmine', 'notminepass123');
    const strangerToken = await login(rerunServer.base, 'notmine', 'notminepass123');
    results.check('somebody else cannot rerun it',
      await status(`${rerunServer.base}/jobs/${flakyId}/rerun`,
        { method: 'POST', headers: auth(strangerToken) }) === 403);

  } finally {
    await stopServer(rerunServer);
    removeSandbox(rerunBox);
  }

  // The database is the only record of who owns which frames. Its own instance
  // so the backup count can be pushed low enough to see rotation.
  const backupBox = makeSandbox('backup');
  let backupServer;

  try {
    console.log('\n  The database is backed up when the machine starts');

    const backupsDir = path.join(backupBox, 'backups');
    const backups = () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []).sort();
    const bootBackupServer = () => startServer({
      port: PORT + 6,
      cwd: backupBox,
      env: { BLENDER_PATH: createFakeBlender(backupBox), DB_BACKUPS_KEPT: '2' }
    });

    backupServer = await bootBackupServer();

    const backupToken = await adminSession(backupServer.base);
    const recorded = await submitJob(
      backupServer.base, backupToken, createFakeScene(backupBox, 'backed-up.blend'),
      { frameStart: 1, frameEnd: 1 }
    );
    await waitForJob(backupServer.base, backupToken, recorded.body.jobId, 30000);

    results.check('a backup is written at boot', backups().length === 1, JSON.stringify(backups()));

    // Opened on its own, the snapshot has to be a working database rather than
    // a half-written file - which is what copying one in WAL mode can produce.
    const snapshot = new Database(path.join(backupsDir, backups()[0]), { readonly: true });
    const users = snapshot.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    snapshot.close();

    results.check('and it opens as a database with the accounts in it', users > 0, `${users} users`);

    for (let restart = 0; restart < 3; restart++) {
      await stopServer(backupServer);
      backupServer = await bootBackupServer();
    }

    results.check('older ones are pruned to the number kept',
      backups().length === 2, JSON.stringify(backups()));

    const survivor = new Database(path.join(backupsDir, backups().at(-1)), { readonly: true });
    const jobRows = survivor.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    survivor.close();

    results.check('and the job records are in the snapshot too', jobRows > 0, `${jobRows} jobs`);

  } finally {
    await stopServer(backupServer);
    removeSandbox(backupBox);
  }

  // A disk with no room fails every frame of every job rather than one, and
  // burns three retries on each. Its own instance because the threshold has to
  // be higher than the free space on whatever machine this runs on.
  const fullBox = makeSandbox('full-disk');
  let fullServer;

  try {
    console.log('\n  A disk with no room left refuses work rather than failing it');

    fullServer = await startServer({
      port: PORT + 5,
      cwd: fullBox,
      // Larger than any real disk, so the check always reads as full.
      env: { BLENDER_PATH: createFakeBlender(fullBox), MIN_FREE_BYTES: String(2 ** 60) }
    });

    const fullToken = await adminSession(fullServer.base);
    const rejected = await submitJob(
      fullServer.base, fullToken, createFakeScene(fullBox, 'nospace.blend'),
      { frameStart: 1, frameEnd: 1 }
    );

    results.check('the upload is refused with 507', rejected.status === 507, `got ${rejected.status}`);
    results.check('and the message says what to do',
      /delete/i.test(rejected.body?.error || ''), rejected.body?.error);

  } finally {
    await stopServer(fullServer);
  }

  // Work already queued when the disk fills is the case the upload gate cannot
  // cover: it is held and rechecked, not failed, because deleting one finished
  // job is all it takes to let it run.
  let heldServer;

  try {
    console.log('\n  Work already queued is held rather than failed');

    heldServer = await startServer({
      port: PORT + 5,
      cwd: fullBox,
      env: { BLENDER_PATH: createFakeBlender(fullBox) }
    });

    let heldToken = await adminSession(heldServer.base);
    const queued = await submitJob(
      heldServer.base, heldToken, createFakeScene(fullBox, 'hang.blend'),
      { frameStart: 1, frameEnd: 2 }
    );

    await waitForCondition(
      async () => (await getJob(heldServer.base, heldToken, queued.body.jobId)).status === 'rendering',
      { label: 'the job to start' }
    );

    // Switched off with work outstanding, and the disk full by morning.
    heldServer.proc.kill('SIGKILL');
    await waitForCondition(
      () => heldServer.proc.exitCode !== null || heldServer.proc.signalCode !== null,
      { label: 'the server to die' }
    );

    heldServer = await startServer({
      port: PORT + 5,
      cwd: fullBox,
      env: { BLENDER_PATH: createFakeBlender(fullBox), MIN_FREE_BYTES: String(2 ** 60) }
    });

    heldToken = await adminSession(heldServer.base);

    const held = await (await fetch(`${heldServer.base}/jobs/queue/status`, {
      headers: auth(heldToken)
    })).json();

    results.check('the queue says why it is holding back',
      /disk/i.test(held.heldForDisk || ''), JSON.stringify(held.heldForDisk));
    results.check('and starts nothing', held.isRendering === false, JSON.stringify(held.isRendering));

    const waiting = await getJob(heldServer.base, heldToken, queued.body.jobId);
    results.check('the job is still queued rather than failed',
      waiting.status === 'pending', waiting.status);

  } finally {
    await stopServer(heldServer);
    removeSandbox(fullBox);
  }

  // The workstation is started by Task Scheduler, where stdout goes nowhere.
  // Its own instance because rotation and pruning need limits nothing else can
  // work under.
  const logBox = makeSandbox('logs');
  let logServer;

  try {
    console.log('\n  Logging to disk, rotating and pruning');

    const logsDir = path.join(logBox, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    // Named as a log from long ago, then given an mtime to match: only the
    // sweep at boot should be able to remove it.
    const stale = path.join(logsDir, 'rendernet-2020-01-01.log');
    fs.writeFileSync(stale, 'from a previous decade\n');
    fs.utimesSync(stale, new Date(0), new Date(0));

    logServer = await startServer({
      port: PORT + 4,
      cwd: logBox,
      // Small enough that the server's own startup output overflows it, so
      // rotation happens without having to manufacture megabytes.
      env: { BLENDER_PATH: createFakeBlender(logBox), MAX_LOG_BYTES: '400' }
    });

    const logToken = await adminSession(logServer.base);
    const named = name => /^rendernet-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(name);
    const onDisk = () => fs.readdirSync(logsDir).filter(named).sort();

    results.check('a log file is written', onDisk().length > 0, JSON.stringify(onDisk()));
    results.check('the stale log was pruned at boot', !fs.existsSync(stale));

    const combined = onDisk().map(name => fs.readFileSync(path.join(logsDir, name), 'utf8')).join('');
    results.check('it captures what the server printed',
      combined.includes('Render Farm started'), combined.slice(0, 200));
    results.check('and stamps each line with a level',
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (INFO|WARN|ERROR) /m.test(combined), combined.slice(0, 200));

    results.check('output past the size limit rotates into a new file',
      onDisk().length > 1, JSON.stringify(onDisk()));

    // A subset rather than an equal count: the server is still logging, and at
    // this size limit it can rotate a new file into existence between the two
    // reads. Files are only ever added, so everything listed is still there.
    const listed = await (await fetch(`${logServer.base}/logs`, { headers: auth(logToken) })).json();
    results.check('an admin can list the logs',
      listed.files?.length > 0 && listed.files.every(file => onDisk().includes(file.name)),
      JSON.stringify(listed.files));

    const tail = await fetch(`${logServer.base}/logs/${onDisk()[0]}?lines=2`, {
      headers: auth(logToken)
    });
    results.check('and tail one of them',
      tail.status === 200 && (await tail.text()).split('\n').length <= 2, `got ${tail.status}`);

    results.check('anonymous log access rejected',
      await status(`${logServer.base}/logs`) === 401);

    await signUp(logServer.base, 'logpeeker', 'logpeeker123');
    const peeker = await login(logServer.base, 'logpeeker', 'logpeeker123');
    results.check('non-admin log access rejected',
      await status(`${logServer.base}/logs`, { headers: auth(peeker) }) === 403);

    results.check('a name outside the listing is refused',
      await status(`${logServer.base}/logs/..%2ftest.db`, { headers: auth(logToken) }) === 404);

    console.log('\n  Recording who asked for what');

    const logged = () => onDisk().map(name => fs.readFileSync(path.join(logsDir, name), 'utf8')).join('');

    // The server is another process and writes its line when the response
    // finishes, which is not ordered against the client's fetch resolving here.
    const appears = (pattern, label) =>
      waitForCondition(() => pattern.test(logged()), { timeoutMs: 10000, label });

    const scene = createFakeScene(logBox, 'audited.blend');
    const audited = await submitJob(logServer.base, logToken, scene, { frameStart: 1, frameEnd: 1 });
    await waitForJob(logServer.base, logToken, audited.body.jobId, 30000);

    results.check('an upload is recorded against the person who made it',
      await appears(/POST \/api\/upload 200 \d+ms user=admin/, 'the upload line'));

    await fetch(`${logServer.base}/jobs/${audited.body.jobId}`, {
      method: 'DELETE', headers: auth(logToken)
    });
    results.check('and so is a deletion',
      await appears(new RegExp(`DELETE /api/jobs/${audited.body.jobId} 200 \\d+ms user=admin`),
        'the delete line'));

    const missing = await status(`${logServer.base}/jobs/999999`, { headers: auth(peeker) });
    results.check('a failed request is recorded even though it is a GET',
      await appears(/GET \/api\/jobs\/999999 404 \d+ms user=logpeeker/, 'the 404 line'),
      `the request itself returned ${missing}`);

    // Counted rather than measured by file size: the queue logs on a timer of
    // its own, and a byte comparison would catch that instead.
    const polls = () => (logged().match(/(GET \/api\/jobs|GET \/api\/jobs\/queue\/status) 200/g) ?? []).length;

    for (let poll = 0; poll < 5; poll++) {
      await fetch(`${logServer.base}/jobs`, { headers: auth(logToken) });
      await fetch(`${logServer.base}/jobs/queue/status`, { headers: auth(logToken) });
    }

    // Issued after the polls and recorded, so seeing it means the server has
    // dealt with them too - otherwise this asserts an absence that has simply
    // not been written yet.
    await fetch(`${logServer.base}/logs`, { headers: auth(logToken) });
    await appears(/GET \/api\/logs 200/, 'the barrier line');

    results.check('the dashboard polling the job list writes nothing',
      polls() === 0, `${polls()} polling lines recorded`);

    // A download authenticates by query string, so the URL carries a live
    // session token. Writing that down would put credentials in a file an
    // admin can fetch over HTTP.
    await status(`${logServer.base}/download/files/render_1/frame_0001.png?token=${logToken}`);
    results.check('a download token never reaches the log',
      !logged().includes(logToken), 'the session token was written to the log');

  } finally {
    await stopServer(logServer);
    removeSandbox(logBox);
  }

  return results;
}
