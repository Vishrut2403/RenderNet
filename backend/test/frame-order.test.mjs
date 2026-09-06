// The order frames are claimed in. Rendering a range from its start means the
// artist sees the first seconds of a shot and nothing else until it is nearly
// done; claiming in bit-reversed order means a job half rendered is an even
// sample of the whole thing. Runs without Blender.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForJob, createFakeBlender, createFakeScene
} from './helpers.mjs';

const PORT = 5615;
const FRAMES = 16;

// The frames the stand-in was handed, in the order the claims came.
function claimOrder(sandbox, scene) {
  const log = path.join(sandbox, 'uploads', 'spans.txt');

  if (!fs.existsSync(log)) return [];

  return fs.readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.includes(scene))
    .flatMap(line => line.slice(line.indexOf(' ') + 1).split(',').map(Number));
}

// How much of the range the frames rendered so far reach across, as a fraction
// of the range itself. One is the whole shot; a quarter is its opening.
function reachOf(frames) {
  return (Math.max(...frames) - Math.min(...frames)) / (FRAMES - 1);
}

async function render(server, token, sandbox, name) {
  const job = await submitJob(server.base, token, createFakeScene(sandbox, name), {
    frameStart: 1, frameEnd: FRAMES
  });

  return waitForJob(server.base, token, job.body.jobId, 120000);
}

export default async function run() {
  const results = createResults('frame-order');
  const sandbox = makeSandbox('frame-order');
  let server;

  const settings = {
    port: PORT,
    cwd: sandbox,
    // A frame to a claim, so what comes out is the claim order itself rather
    // than the claim order with each span sorted inside it.
    env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SLOTS: '1', MAX_FRAME_SPAN: '1' }
  };

  try {
    server = await startServer(settings);

    const token = await adminSession(server.base);

    console.log('\n  A range is claimed spread out, not in order');

    const job = await render(server, token, sandbox, 'spread.blend');
    const claimed = claimOrder(sandbox, 'spread.blend');

    results.check('the job completed', job.status === 'completed', job.status);
    results.check('every frame was rendered exactly once',
      new Set(claimed).size === FRAMES && claimed.length === FRAMES, claimed.join(','));

    // Still the first one: rendering it is what measures every span after it,
    // and a job holding its range back for approval renders it alone.
    results.check('the first frame claimed is the first frame of the range',
      claimed[0] === 1, claimed.join(','));

    const quarter = claimed.slice(0, FRAMES / 4);

    results.check('a quarter of the way in, the frames rendered reach across the shot',
      reachOf(quarter) > 0.5, `${quarter.join(',')} reaches ${reachOf(quarter).toFixed(2)}`);

    // Evenly, not merely widely: eight frames of sixteen that happened to
    // include the last one would pass the check above while still being the
    // opening of the shot.
    const half = claimed.slice(0, FRAMES / 2).sort((a, b) => a - b);
    const gaps = half.slice(1).map((frame, index) => frame - half[index]);

    results.check('and half way in they sample the whole shot rather than half of it',
      reachOf(half) > 0.9 && Math.max(...gaps) <= 3,
      `${half.join(',')} reaches ${reachOf(half).toFixed(2)} with gaps of ${gaps.join(',')}`);

    console.log('\n  Asking for the old order back');

    await stopServer(server);
    server = await startServer({ ...settings, env: { ...settings.env, FRAME_ORDER: 'sequential' } });

    const inOrderToken = await adminSession(server.base);
    const plain = await render(server, inOrderToken, sandbox, 'sequential.blend');
    const inOrder = claimOrder(sandbox, 'sequential.blend');

    results.check('the job completed', plain.status === 'completed', plain.status);
    results.check('FRAME_ORDER=sequential renders the range from its start',
      inOrder.join(',') === [...Array(FRAMES).keys()].map(n => n + 1).join(','),
      inOrder.join(','));
    results.check('which reaches nowhere near across the shot to begin with',
      reachOf(inOrder.slice(0, FRAMES / 4)) < 0.25,
      inOrder.slice(0, FRAMES / 4).join(','));
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
