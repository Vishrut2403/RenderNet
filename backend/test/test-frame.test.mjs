// One frame rendered on its own so its owner can look at it before the other
// four hundred are committed to.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession, signUp,
  login, auth, submitJob, getJob, waitForJob, waitForCondition, createFakeBlender,
  createFakeScene, sleep
} from './helpers.mjs';

const PORT = 5601;

async function approve(base, token, jobId) {
  const res = await fetch(`${base}/jobs/${jobId}/approve`, {
    method: 'POST', headers: auth(token)
  });

  return { status: res.status, body: await res.json() };
}

function waitingFor(base, token, jobId) {
  return waitForCondition(async () => (await getJob(base, token, jobId)).approval === 'waiting',
    { label: 'the test frame to be rendered', timeoutMs: 30000 });
}

export default async function run() {
  const results = createResults('test-frame');
  const sandbox = makeSandbox('test-frame');

  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const admin = await adminSession(base);
    await signUp(base, 'painter', 'painter-password');
    const painter = await login(base, 'painter', 'painter-password');

    console.log('\n  Asking for one frame first');

    const asked = await submitJob(base, admin, createFakeScene(sandbox, 'range.blend'),
      { frameStart: 1, frameEnd: 6, testFrame: 1, skipAssetCheck: true });
    const jobId = asked.body.jobId;

    results.check('the job is accepted', asked.status === 200, JSON.stringify(asked.body));
    results.check('it renders its test frame',
      await waitingFor(base, admin, jobId), 'never got there');

    const waiting = await getJob(base, admin, jobId);

    results.check('and stops there rather than carrying on',
      waiting.completedFrames === 1, `${waiting.completedFrames} frames`);
    results.check('the whole range is still what it will render',
      waiting.totalFrames === 6, String(waiting.totalFrames));
    results.check('it is not counted as finished',
      waiting.status === 'pending' && !waiting.completedAt, waiting.status);

    // The rest of the range must stay unclaimable rather than merely unqueued:
    // a worker asking for work would otherwise be handed frame 2.
    await sleep(3000);
    const later = await getJob(base, admin, jobId);

    results.check('and it is still one frame a moment later',
      later.completedFrames === 1, `${later.completedFrames} frames`);

    const preview = await fetch(`${base}/download/${jobId}/preview`, { headers: auth(admin) });

    results.check('the frame can be looked at while it waits',
      preview.status === 200, String(preview.status));
    results.check('and the answer says which frame it is',
      preview.headers.get('x-frame-number') === '1',
      preview.headers.get('x-frame-number'));

    console.log('\n  The farm carries on meanwhile');

    const other = await submitJob(base, admin, createFakeScene(sandbox, 'other.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });
    const ran = await waitForJob(base, admin, other.body.jobId, 30000);

    results.check('a job behind it is not blocked by the one waiting',
      ran.status === 'completed', ran.status);

    console.log('\n  Saying yes');

    const frameOne = path.join(sandbox, waiting.outputFolder, 'frame_0001.png');
    const renderedAt = fs.statSync(frameOne).mtimeMs;

    results.check('somebody else cannot approve it',
      (await approve(base, painter, jobId)).status === 403);

    const approved = await approve(base, admin, jobId);

    results.check('the owner can', approved.status === 200, JSON.stringify(approved.body));

    const finished = await waitForJob(base, admin, jobId, 60000);

    results.check('and the rest of the range renders',
      finished.status === 'completed' && finished.completedFrames === 6,
      `${finished.status}, ${finished.completedFrames} frames`);
    results.check('the frame already rendered was not rendered again',
      fs.statSync(frameOne).mtimeMs === renderedAt);
    results.check('approving it twice is refused',
      (await approve(base, admin, jobId)).status === 400);

    console.log('\n  Saying no');

    const doomed = await submitJob(base, admin, createFakeScene(sandbox, 'unwanted.blend'),
      { frameStart: 1, frameEnd: 4, testFrame: 2, skipAssetCheck: true });

    results.check('a job can be told to render any frame of its range first',
      await waitingFor(base, admin, doomed.body.jobId), 'never got there');

    const chosen = await getJob(base, admin, doomed.body.jobId);

    results.check('and it is the frame that was asked for',
      fs.existsSync(path.join(sandbox, chosen.outputFolder, 'frame_0002.png'))
      && !fs.existsSync(path.join(sandbox, chosen.outputFolder, 'frame_0001.png')),
      fs.readdirSync(path.join(sandbox, chosen.outputFolder)).join(','));

    const cancelled = await fetch(`${base}/jobs/${doomed.body.jobId}/cancel`,
      { method: 'POST', headers: auth(admin) });

    results.check('a job waiting to be approved can be thrown away',
      cancelled.status === 200, String(cancelled.status));
    results.check('and it takes its frames with it',
      !fs.existsSync(path.join(sandbox, chosen.outputFolder)));

    console.log('\n  A test frame that does not render');

    const broken = await submitJob(base, admin, createFakeScene(sandbox, 'broken.blend'),
      { frameStart: 1, frameEnd: 5, testFrame: 1, skipAssetCheck: true });
    const failed = await waitForJob(base, admin, broken.body.jobId, 60000);

    results.check('fails the job rather than asking about it',
      failed.status === 'failed', failed.status);
    results.check('without rendering the rest of the range',
      failed.completedFrames === 0, String(failed.completedFrames));

    console.log('\n  What a test frame may be');

    const outside = await submitJob(base, admin, createFakeScene(sandbox, 'outside.blend'),
      { frameStart: 1, frameEnd: 4, testFrame: 9, skipAssetCheck: true });

    results.check('a frame outside the range is refused',
      outside.status === 400, JSON.stringify(outside.body));

    const single = await submitJob(base, admin, createFakeScene(sandbox, 'single.blend'),
      { frameStart: 7, frameEnd: 7, testFrame: 7, skipAssetCheck: true });

    results.check('and a one-frame job has nothing to hold back',
      single.status === 400, JSON.stringify(single.body));

    console.log('\n  Waiting through a restart');

    const across = await submitJob(base, admin, createFakeScene(sandbox, 'restart.blend'),
      { frameStart: 1, frameEnd: 3, testFrame: 1, skipAssetCheck: true });

    await waitingFor(base, admin, across.body.jobId);
    await stopServer(server);

    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const restarted = await adminSession(server.base);
    await sleep(2000);
    const stillWaiting = await getJob(server.base, restarted, across.body.jobId);

    results.check('a job waiting on its owner is not resumed by a restart',
      stillWaiting.approval === 'waiting' && stillWaiting.completedFrames === 1,
      `${stillWaiting.approval}, ${stillWaiting.completedFrames} frames`);

    await approve(server.base, restarted, across.body.jobId);

    results.check('and it still renders once approved',
      (await waitForJob(server.base, restarted, across.body.jobId, 60000)).completedFrames === 3);
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
