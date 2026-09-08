// What happens to a database that already has jobs in it when a release that
// changes the schema is installed over the top. Every other suite starts from
// an empty database, so this is the only place the migrations run against rows
// somebody already had. The database is made by the app itself and then taken
// back to the previous release's shape, rather than written out by hand here,
// which would only ever test a schema this file remembered. Runs without
// Blender.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  adminSession, submitJob, waitForJob, createFakeBlender, createFakeScene, getJob
} from './helpers.mjs';

const PORT = 5616;
const FRAMES = 12;

function framesOf(sandbox, jobId) {
  const db = new Database(path.join(sandbox, 'test.db'));

  try {
    return db.prepare('SELECT frame, ordinal, status FROM frames WHERE jobId = ? ORDER BY frame')
      .all(jobId);
  } finally {
    db.close();
  }
}

// A table as the last release left it. SQLite drops a column without disturbing
// the primary key, so what is left is the real previous shape.
function undoTheMigration(sandbox, table, columns) {
  const db = new Database(path.join(sandbox, 'test.db'));

  try {
    for (const column of columns) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);

    return db.prepare(`PRAGMA table_info(${table})`).all().map(info => info.name);
  } finally {
    db.close();
  }
}

// The order the stand-in was asked for frames in, across every claim.
function claimOrder(sandbox, scene) {
  const log = path.join(sandbox, 'uploads', 'spans.txt');

  if (!fs.existsSync(log)) return [];

  return fs.readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.includes(scene))
    .flatMap(line => line.slice(line.indexOf(' ') + 1).split(',').map(Number));
}

export default async function run() {
  const results = createResults('upgrading');
  const sandbox = makeSandbox('upgrading');
  let server;

  const settings = {
    port: PORT,
    cwd: sandbox,
    env: { BLENDER_PATH: createFakeBlender(sandbox), MAX_FRAME_SPAN: '1' }
  };

  try {
    console.log('\n  A job left queued by the release before this one');

    // Nothing renders yet: the job has to still be there to render after the
    // upgrade, which is the point.
    server = await startServer({ ...settings, env: { ...settings.env, WORKER_SLOTS: '0' } });

    const token = await adminSession(server.base);
    const waiting = await submitJob(server.base, token,
      createFakeScene(sandbox, 'carried-over.blend'), { frameStart: 1, frameEnd: FRAMES });
    const jobId = waiting.body.jobId;

    await stopServer(server);
    server = null;

    const columns = undoTheMigration(sandbox, 'frames', ['ordinal']);
    const jobColumns = undoTheMigration(sandbox, 'jobs', ['bake', 'bakedPath', 'unbakedSims']);

    results.check('the database is back to the shape the last release left',
      !columns.includes('ordinal'), columns.join(','));
    results.check('knowing nothing about baking a scene before it renders',
      ['bake', 'bakedPath', 'unbakedSims'].every(name => !jobColumns.includes(name)),
      jobColumns.join(','));

    console.log('\n  Starting the new release on it');

    server = await startServer({ ...settings, env: { ...settings.env, WORKER_SLOTS: '1' } });

    const upgradedToken = await adminSession(server.base);
    const rows = framesOf(sandbox, jobId);

    const carriedJob = await getJob(server.base, upgradedToken, jobId);

    results.check('the server starts on a database it has to migrate',
      carriedJob.id === jobId);
    // Null rather than 'waiting': a job that was queued before the farm baked
    // anything is not suddenly a job with a bake outstanding.
    results.check('and a job from before has nothing to bake',
      !carriedJob.bake, String(carriedJob.bake));
    results.check('every frame that was already there has an ordinal',
      rows.length === FRAMES && rows.every(row => Number.isInteger(row.ordinal)),
      `${rows.length} rows, ${rows.filter(row => row.ordinal === null).length} without one`);

    // Its frame number, so a job somebody is already waiting on is rendered in
    // the order it was going to be rendered in rather than resequenced under
    // them by an upgrade.
    results.check('and it is the frame number, not a new order',
      rows.every(row => row.ordinal === row.frame),
      rows.map(row => `${row.frame}:${row.ordinal}`).join(' '));

    const finished = await waitForJob(server.base, upgradedToken, jobId, 120000);
    const carried = claimOrder(sandbox, 'carried-over.blend');

    results.check('the job renders to the end', finished.status === 'completed'
      && finished.completedFrames === FRAMES, `${finished.status}, ${finished.completedFrames}`);
    results.check('claimed in the order it always would have been',
      carried.join(',') === rows.map(row => row.frame).join(','), carried.join(','));

    console.log('\n  And a job submitted after the upgrade');

    const fresh = await submitJob(server.base, upgradedToken,
      createFakeScene(sandbox, 'brand-new.blend'), { frameStart: 1, frameEnd: FRAMES });
    const rendered = await waitForJob(server.base, upgradedToken, fresh.body.jobId, 120000);
    const order = claimOrder(sandbox, 'brand-new.blend');

    results.check('renders too', rendered.status === 'completed'
      && rendered.completedFrames === FRAMES, `${rendered.status}, ${rendered.completedFrames}`);
    results.check('and gets the spread order the new release renders in',
      order[0] === 1 && order[1] > FRAMES / 2, order.join(','));
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
