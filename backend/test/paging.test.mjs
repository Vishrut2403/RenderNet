// A job list that does not grow without bound, and the counts and dashboard
// totals that have to keep working once it stops being the whole list.
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession, signUp,
  login, auth, createFakeScene, submitJob
} from './helpers.mjs';

const PORT = 5598;
const SECRET = 'test-worker-secret';
const JOBS = 12;
const MINE = JOBS + 1 + 5;

// The counts here are only stable while every job stays queued, so the farm is
// told its one machine renders something else: the queue then starts nothing,
// whether or not this runner has Blender.
async function offerAnotherEngine(base) {
  await fetch(`${base}/worker/lease`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': SECRET },
    body: JSON.stringify({ workerId: 'workbench-only', engines: ['BLENDER_WORKBENCH'] })
  });
}

async function page(base, token, query = '') {
  const res = await fetch(`${base}/jobs${query}`, { headers: auth(token) });
  return { status: res.status, body: await res.json() };
}

async function queueJobs(base, token, scene, count) {
  const ids = [];

  for (let n = 0; n < count; n++) {
    const { body } = await submitJob(base, token, scene,
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });
    ids.push(body.jobId);
  }

  return ids;
}

export default async function run() {
  const results = createResults('paging');
  const sandbox = makeSandbox('paging');

  let server;

  try {
    server = await startServer({ port: PORT, cwd: sandbox });
    const { base } = server;

    const admin = await adminSession(base);
    await signUp(base, 'painter', 'painter-password');
    const painter = await login(base, 'painter', 'painter-password');

    await offerAnotherEngine(base);

    const scene = createFakeScene(sandbox, 'paged.blend');
    const mine = await queueJobs(base, painter, scene, JOBS);

    console.log('\n  One page at a time');

    const first = await page(base, painter, '?limit=5');

    results.check('a page holds no more than it was asked for',
      first.body.jobs.length === 5, String(first.body.jobs.length));
    results.check('newest first',
      first.body.jobs.every((job, index) =>
        index === 0 || job.id < first.body.jobs[index - 1].id),
      JSON.stringify(first.body.jobs.map(job => job.id)));

    // The tabs count every job the user has, not the handful on screen.
    results.check('the counts cover everything, not the page',
      first.body.counts.all === JOBS, String(first.body.counts.all));
    results.check('and break down by status',
      first.body.counts.pending === JOBS, JSON.stringify(first.body.counts));

    results.check('a cursor is offered while jobs remain',
      first.body.nextBefore === first.body.jobs[4].id, String(first.body.nextBefore));

    console.log('\n  Walking the cursor');

    const walked = [];
    let cursor = null;

    for (let request = 0; request < JOBS; request++) {
      const next = await page(base, painter,
        `?limit=5${cursor === null ? '' : `&before=${cursor}`}`);

      walked.push(...next.body.jobs.map(job => job.id));
      cursor = next.body.nextBefore;

      if (cursor === null) break;
    }

    results.check('the walk ends', cursor === null, String(cursor));
    results.check('it reaches every job once',
      walked.length === JOBS && new Set(walked).size === JOBS, String(walked.length));
    results.check('in the order the list is shown in',
      walked.every((id, index) => index === 0 || id < walked[index - 1]),
      JSON.stringify(walked));

    // What the cursor is for: an offset would push everything down a row and
    // show the reader the same job twice.
    console.log('\n  A job arriving mid-walk');

    const held = await page(base, painter, '?limit=5');
    await submitJob(base, painter, scene,
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });
    const after = await page(base, painter, `?limit=5&before=${held.body.nextBefore}`);

    const shown = new Set(held.body.jobs.map(job => job.id));

    results.check('does not repeat a row already read',
      after.body.jobs.every(job => !shown.has(job.id)),
      JSON.stringify(after.body.jobs.map(job => job.id)));
    results.check('and is counted straight away',
      after.body.counts.all === JOBS + 1, String(after.body.counts.all));

    console.log('\n  What a page may ask for');

    const rejected = await Promise.all([
      page(base, painter, '?limit=0'),
      page(base, painter, '?limit=101'),
      page(base, painter, '?limit=lots'),
      page(base, painter, '?before=yesterday'),
      page(base, painter, '?status=elsewhere')
    ]);

    results.check('a nonsensical page is refused',
      rejected.every(answer => answer.status === 400),
      JSON.stringify(rejected.map(answer => answer.status)));

    const filtered = await page(base, painter, '?status=completed');

    results.check('a status nobody is in pages to nothing',
      filtered.body.jobs.length === 0 && filtered.body.counts.all === JOBS + 1,
      JSON.stringify(filtered.body.counts));

    console.log('\n  Pages hold only what the reader may see');

    await signUp(base, 'sculptor', 'sculptor-password');
    const sculptor = await login(base, 'sculptor', 'sculptor-password');
    const theirs = await queueJobs(base, sculptor, scene, 4);

    // Queued after theirs, so the newest rows in the farm belong to somebody
    // else: a page cut before the owner is considered would come back short.
    await queueJobs(base, painter, scene, 5);

    const others = await page(base, sculptor, '?limit=3');

    // Filtering after the page is cut would hand this reader three rows with
    // somebody else's two taken out of them.
    results.check('a full page of their own, not a filtered one',
      others.body.jobs.length === 3, String(others.body.jobs.length));
    results.check('none of them anyone else\'s',
      others.body.jobs.every(job => theirs.includes(job.id)),
      JSON.stringify(others.body.jobs.map(job => job.id)));
    results.check('counted the same way',
      others.body.counts.all === 4, String(others.body.counts.all));

    const asAdmin = await page(base, admin, '?limit=100');

    results.check('an admin sees the lot',
      asAdmin.body.counts.all === MINE + 4, String(asAdmin.body.counts.all));

    console.log('\n  What the dashboard asks for instead');

    const summary = await (await fetch(`${base}/jobs/summary`, { headers: auth(painter) })).json();

    results.check('the summary counts the same jobs',
      summary.counts?.all === MINE, JSON.stringify(summary));
    results.check('it names only the newest few',
      summary.recent?.length === 3, JSON.stringify(summary.recent?.length));
    results.check('newest first',
      summary.recent?.[0].id > summary.recent?.[2].id,
      JSON.stringify(summary.recent?.map(job => job.id)));
    results.check('nothing is rendering without a worker',
      summary.rendering?.length === 0, JSON.stringify(summary.rendering?.length));
    results.check('and it carries the totals the stats row shows',
      summary.framesRendered === 0 && summary.renderMs === 0 && summary.usage?.quota > 0,
      JSON.stringify({ frames: summary.framesRendered, ms: summary.renderMs }));
    results.check('one reader\'s summary is not another\'s',
      (await (await fetch(`${base}/jobs/summary`, { headers: auth(sculptor) })).json())
        .counts?.all === 4);

    results.check('a job id is still fetched by id, not taken for a summary',
      (await (await fetch(`${base}/jobs/${mine[0]}`, { headers: auth(painter) })).json()).id
        === mine[0]);

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
