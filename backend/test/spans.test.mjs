// One claim covering several frames. Starting Blender costs the same whatever it
// then renders, so the farm hands out spans - and the whole risk of doing that
// is what happens when a span is cut short. Runs without Blender.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForJob, createFakeBlender, createFakeScene, getJob,
  waitForCondition, auth, blenderAvailable, createFixtureBlend
} from './helpers.mjs';

const PORT = 5613;

// How many Blenders the stand-in was asked to be, against how many spans they
// were between them given.
function startsFor(sandbox, scene) {
  const log = path.join(sandbox, 'uploads', 'launches.txt');

  if (!fs.existsSync(log)) return 0;

  return fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes(scene)).length;
}

// The stand-in cannot say anything about a real Blender, and the worker only
// prints this line when it starts one, so counting them is what says whether a
// real Blender was kept open across claims.
function blendersStarted(sandbox, scene) {
  const logs = path.join(sandbox, 'logs');

  if (!fs.existsSync(logs)) return 0;

  return fs.readdirSync(logs)
    .flatMap(name => fs.readFileSync(path.join(logs, name), 'utf8').split('\n'))
    .filter(line => line.includes('Running:') && line.includes(scene))
    .length;
}

// Every span the stand-in was given, as the frames each covered.
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
    // Nothing is known about a frame until one has been rendered, so the first
    // claim of all is a single frame - and rendering it is what makes every
    // span after it possible.
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

    // Spreading the cost of starting Blender over a span is worth less than not
    // paying it: the process is kept open and fed the next span, so a worker
    // that keeps claiming from one job parses the scene once.
    const starts = startsFor(sandbox, 'spanned.blend');

    results.check('a job of several spans started fewer Blenders than it had spans',
      starts < launches.length, `${starts} started for ${launches.length} spans`);
    results.check('one Blender covered all of them', starts === 1, `${starts} started`);

    console.log('\n  A span cut short keeps what it rendered');

    // 'flaky' writes its frames until frame 2, then exits non-zero: a span that
    // dies partway with work already on disk, which is the case worth proving.
    const flaky = await submitJob(server.base, token, createFakeScene(sandbox, 'flaky.blend'), {
      frameStart: 1, frameEnd: 6
    });
    const stopped = await waitForJob(server.base, token, flaky.body.jobId, 120000);

    // Frame 1 was rendered before Blender gave up on frame 2, and a span that
    // only delivered when it exited cleanly would have thrown that away.
    // Frames 3 and up were in the same span and never reached, so charging them
    // an attempt each time frame 2 failed would have spent all three of their
    // retries on work nobody ever tried - leaving far more than one failure.
    results.check('only the frame Blender stopped on is recorded as failed',
      stopped.failedFrames === 1, `${stopped.failedFrames} failed`);
    results.check('every other frame in the span was still delivered',
      stopped.completedFrames === 5, `${stopped.completedFrames} of 5 done`);

    console.log('\n  Frames go back as they are rendered, not when the span ends');

    // Frame 1 goes out alone and measures the job; the claim after it covers
    // several frames, and 'halfway' writes the first of them and then never
    // finishes another. Only a worker that hands frames over as Blender writes
    // them gets that frame back at all - waiting for the launch to end would
    // lose it, which is the whole reason an interrupted render resumes.
    const stalling = await submitJob(server.base, token, createFakeScene(sandbox, 'halfway.blend'), {
      frameStart: 1, frameEnd: 6
    });

    const midSpan = await waitForCondition(
      async () => (await getJob(server.base, token, stalling.body.jobId)).completedFrames >= 2,
      { label: 'a frame delivered from inside a span still running', timeoutMs: 25000 });

    results.check('a frame is delivered while the span that made it is still going', midSpan);

    // It never finishes another frame, so it would hold the farm for a minute.
    await fetch(`${server.base}/jobs/${stalling.body.jobId}/cancel`,
      { method: 'POST', headers: auth(token) });

    console.log('\n  Rendering every nth frame of a range');

    // A preview pass. The frames are not next to each other, which a claim
    // covering a span already handles: Blender takes the list it is given.
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

    // 'slow' takes 2s a frame against a span budget of 3s, so only one fits.
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

    // A Blender held open holds the scene in memory with it, which a machine
    // short of memory would rather have back.
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

    // Everything above answers a stand-in that this repository wrote. Whether
    // Blender itself will sit on a pipe waiting for the next span, and render
    // what arrives, is not something a stand-in can be asked.
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
