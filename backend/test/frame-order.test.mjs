import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForJob, createFakeBlender, createFakeScene
} from './helpers.mjs';

const PORT = 5615;
const FRAMES = 16;

function claimOrder(sandbox, scene) {
  const log = path.join(sandbox, 'uploads', 'spans.txt');

  if (!fs.existsSync(log)) return [];

  return fs.readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.includes(scene))
    .flatMap(line => line.slice(line.indexOf(' ') + 1).split(',').map(Number));
}

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

    results.check('the first frame claimed is the first frame of the range',
      claimed[0] === 1, claimed.join(','));

    const quarter = claimed.slice(0, FRAMES / 4);

    results.check('a quarter of the way in, the frames rendered reach across the shot',
      reachOf(quarter) > 0.5, `${quarter.join(',')} reaches ${reachOf(quarter).toFixed(2)}`);

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
