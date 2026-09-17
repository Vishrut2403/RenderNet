import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForJob, createFakeBlender, createFakeScene, getJob,
  waitForCondition, auth, blenderAvailable, createFixtureBlend
} from './helpers.mjs';

const PORT = 5613;

function startsFor(sandbox, scene) {
  const log = path.join(sandbox, 'uploads', 'launches.txt');

  if (!fs.existsSync(log)) return 0;

  return fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes(scene)).length;
}

function blendersStarted(sandbox, scene) {
  const logs = path.join(sandbox, 'logs');

  if (!fs.existsSync(logs)) return 0;

  return fs.readdirSync(logs)
    .flatMap(name => fs.readFileSync(path.join(logs, name), 'utf8').split('\n'))
    .filter(line => line.includes('Running:') && line.includes(scene))
    .length;
}

function spansFor(sandbox, scene) {
  const log = path.join(sandbox, 'uploads', 'spans.txt');

  if (!fs.existsSync(log)) return [];

  return fs.readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.includes(scene))
    .map(line => line.slice(line.indexOf(' ') + 1).split(',').map(Number));
}

export default async function run() {
  const results = createResults('spans');
  const sandbox = makeSandbox('spans');
  let server;

  try {
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: {
        BLENDER_PATH: createFakeBlender(sandbox),
        WORKER_SLOTS: '1',
        FRAME_SPAN_MS: '60000',
        MAX_FRAME_SPAN: '4'
      }
    });

    const token = await adminSession(server.base);

    console.log('\n  The first job measures what a frame costs');

    const first = await submitJob(server.base, token, createFakeScene(sandbox, 'measure.blend'), {
      frameStart: 1, frameEnd: 3
    });
    const measured = await waitForJob(server.base, token, first.body.jobId, 120000);

    results.check('the measuring job completed', measured.status === 'completed', measured.status);
    results.check('with nothing measured yet, the first claim is one frame',
      spansFor(sandbox, 'measure.blend')[0]?.length === 1,
      JSON.stringify(spansFor(sandbox, 'measure.blend')));

    console.log('\n  A measured job is rendered in spans');

    const spanned = await submitJob(server.base, token, createFakeScene(sandbox, 'spanned.blend'), {
      frameStart: 1, frameEnd: 8
    });
    const job = await waitForJob(server.base, token, spanned.body.jobId, 120000);
    const launches = spansFor(sandbox, 'spanned.blend');

    results.check('the job completed', job.status === 'completed', job.status);
    results.check('every frame arrived', job.completedFrames === 8, `${job.completedFrames} of 8`);
    results.check('it took fewer launches than frames', launches.length < 8,
      `${launches.length} launches`);
    results.check('at least one launch covered several frames',
      launches.some(frames => frames.length > 1), JSON.stringify(launches));
    results.check('no launch exceeded MAX_FRAME_SPAN',
      launches.every(frames => frames.length <= 4), JSON.stringify(launches));
    results.check('each span was asked for as one list of frames',
      launches.every(frames => frames.every(Number.isInteger)), JSON.stringify(launches));

    const rendered = launches.flat().sort((a, b) => a - b);

    results.check('no frame was rendered twice',
      new Set(rendered).size === rendered.length, rendered.join(','));
    results.check('and between them the launches covered the range',
      new Set(rendered).size === 8, rendered.join(','));

    console.log('\n  One Blender serves every claim it can');

    const starts = startsFor(sandbox, 'spanned.blend');

    results.check('a job of several spans started fewer Blenders than it had spans',
      starts < launches.length, `${starts} started for ${launches.length} spans`);
    results.check('one Blender covered all of them', starts === 1, `${starts} started`);

    console.log('\n  A span cut short keeps what it rendered');

    const flaky = await submitJob(server.base, token, createFakeScene(sandbox, 'flaky.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const stopped = await waitForJob(server.base, token, flaky.body.jobId, 120000);

    results.check('only the frame Blender stopped on is recorded as failed',
      stopped.failedFrames === 1, `${stopped.failedFrames} failed`);
    results.check('every other frame in the span was still delivered',
      stopped.completedFrames === 5, `${stopped.completedFrames} of 5 done`);

    console.log('\n  Frames go back as they are rendered, not when the span ends');

    const stalling = await submitJob(server.base, token, createFakeScene(sandbox, 'halfway.blend'), {
      frameStart: 1, frameEnd: 6
    });

    const midSpan = await waitForCondition(
      async () => (await getJob(server.base, token, stalling.body.jobId)).completedFrames >= 2,
      { label: 'a frame delivered from inside a span still running', timeoutMs: 25000 });

    results.check('a frame is delivered while the span that made it is still going', midSpan);

    await fetch(`${server.base}/jobs/${stalling.body.jobId}/cancel`,
      { method: 'POST', headers: auth(token) });

    console.log('\n  Rendering every nth frame of a range');

    const stepped = await submitJob(server.base, token,
      createFakeScene(sandbox, 'stepped.blend'),
      { frameStart: 1, frameEnd: 10, frameStep: 3 });
    const preview = await waitForJob(server.base, token, stepped.body.jobId, 120000);
    const asked = spansFor(sandbox, 'stepped.blend').flat().sort((a, b) => a - b);

    results.check('the job counts only the frames it will render',
      preview.totalFrames === 4, `${preview.totalFrames} of an expected 4`);
    results.check('and renders exactly those', preview.completedFrames === 4,
      `${preview.completedFrames} delivered`);
    results.check('Blender was asked for every third frame and no other',
      asked.join(',') === '1,4,7,10', asked.join(','));

    console.log('\n  A slow scene is still claimed a frame at a time');

    await stopServer(server);
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: {
        BLENDER_PATH: createFakeBlender(sandbox),
        WORKER_SLOTS: '1',
        FRAME_SPAN_MS: '3000',
        MAX_FRAME_SPAN: '16'
      }
    });

    const slowToken = await adminSession(server.base);
    const slow = await submitJob(server.base, slowToken, createFakeScene(sandbox, 'slow.blend'), {
      frameStart: 1, frameEnd: 4
    });
    const slowJob = await waitForJob(server.base, slowToken, slow.body.jobId, 180000);

    results.check('the slow job completed', slowJob.status === 'completed', slowJob.status);
    results.check('no span held more than a couple of its frames',
      spansFor(sandbox, 'slow.blend').every(each => each.length <= 2),
      JSON.stringify(spansFor(sandbox, 'slow.blend')));

    console.log('\n  Closing Blender between claims when told to');

    await stopServer(server);
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: {
        BLENDER_PATH: createFakeBlender(sandbox),
        WORKER_SLOTS: '1',
        FRAME_SPAN_MS: '60000',
        MAX_FRAME_SPAN: '2',
        BLENDER_IDLE_MS: '0'
      }
    });

    const closingToken = await adminSession(server.base);
    const closing = await submitJob(server.base, closingToken,
      createFakeScene(sandbox, 'closed.blend'), { frameStart: 1, frameEnd: 6 });
    const closed = await waitForJob(server.base, closingToken, closing.body.jobId, 120000);

    results.check('the job completed', closed.status === 'completed', closed.status);
    results.check('BLENDER_IDLE_MS=0 starts a Blender for every span',
      startsFor(sandbox, 'closed.blend') === spansFor(sandbox, 'closed.blend').length,
      `${startsFor(sandbox, 'closed.blend')} started`
      + ` for ${spansFor(sandbox, 'closed.blend').length} spans`);
    results.check('and it still renders every frame', closed.completedFrames === 6,
      `${closed.completedFrames} of 6`);

    console.log('\n  A real Blender across real claims');

    if (!blenderAvailable()) {
      results.skipped('one Blender covered a range claimed a frame at a time',
        'Blender not installed');
      results.skipped('and rendered every frame of it', 'Blender not installed');
    } else {
      await stopServer(server);
      server = await startServer({
        port: PORT,
        cwd: sandbox,
        env: { WORKER_SLOTS: '1', FRAME_SPAN_MS: '60000', MAX_FRAME_SPAN: '1' }
      });

      const realToken = await adminSession(server.base);
      const fixture = createFixtureBlend(sandbox, { name: 'resident.blend' });
      const real = await submitJob(server.base, realToken, fixture,
        { frameStart: 1, frameEnd: 4 });
      const rendered = await waitForJob(server.base, realToken, real.body.jobId, 300000);

      results.check('one Blender covered a range claimed a frame at a time',
        blendersStarted(sandbox, 'resident.blend') === 1,
        `${blendersStarted(sandbox, 'resident.blend')} started`);
      results.check('and rendered every frame of it',
        rendered.status === 'completed' && rendered.completedFrames === 4,
        `${rendered.status}, ${rendered.completedFrames} of 4`);
    }
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
