// join.sh, run the way somebody adding a machine to the farm would run it:
// against a real server, from a copy of the project standing in for the other
// machine. It is a bash script, so it has nothing to say on Windows.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession, auth,
  createFakeBlender, createFakeScene, submitJob, waitForCondition, getJob, ADMIN_PASSWORD
} from './helpers.mjs';

const PORT = 5625;
const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(BACKEND, '..');

const NAMES = [
  'an old Node is named once, not twice',
  'the first-run admin is told to choose a password',
  'a machine joins and renders a job on its own',
  'its credential is kept rather than asked for again',
  'a revoked credential is noticed rather than reused',
  'and a working one takes its place'
];

// The other machine, sharing only the installed modules with this one so the
// test is about join.sh rather than about npm.
function standIn(box) {
  const at = path.join(box, 'joiner');

  fs.mkdirSync(path.join(at, 'backend'), { recursive: true });
  fs.cpSync(path.join(BACKEND, 'src'), path.join(at, 'backend', 'src'), { recursive: true });
  fs.cpSync(path.join(BACKEND, 'package.json'), path.join(at, 'backend', 'package.json'));
  fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(at, 'backend', 'node_modules'));
  fs.cpSync(path.join(REPO, 'join.sh'), path.join(at, 'join.sh'));
  fs.cpSync(path.join(REPO, '.node-version'), path.join(at, '.node-version'));
  fs.chmodSync(path.join(at, 'join.sh'), 0o755);

  return at;
}

function join(cwd, args, { env = {}, input = '' } = {}) {
  const child = spawn('./join.sh', args, { cwd, env: { ...process.env, ...env } });
  let out = '';

  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });

  const exited = new Promise(resolve => child.on('exit', resolve));

  child.stdin.end(input);

  return { child, exited, output: () => out };
}

async function exitOf(run, timeoutMs = 60000) {
  const timer = setTimeout(() => run.child.kill('SIGKILL'), timeoutMs);
  const code = await run.exited;

  clearTimeout(timer);

  return code;
}

// Ctrl+C, the way a person stops it, which join.sh passes on to its workers.
async function stop(run) {
  run.child.kill('SIGINT');

  const timer = setTimeout(() => run.child.kill('SIGKILL'), 10000);

  await run.exited;
  clearTimeout(timer);
}

function rendering(run) {
  return waitForCondition(
    () => /Rendering for/.test(run.output()) || run.child.exitCode !== null,
    { label: 'join.sh to start or give up', timeoutMs: 60000 });
}

export default async function run() {
  const results = createResults('joining');

  if (process.platform === 'win32') {
    for (const name of NAMES) results.skipped(name, 'join.sh is a bash script');
    return results;
  }

  const box = makeSandbox('joining');
  let server;
  let joined;

  try {
    const joiner = standIn(box);
    const blender = createFakeBlender(box);
    const saved = path.join(joiner, '.worker-env');
    const credential = () => (fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : '');

    console.log('\n  Before it gets as far as the farm');

    // A node that answers -v with a version too old and does nothing else.
    const shim = path.join(box, 'old-node');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'node'), '#!/bin/sh\necho v18.20.0\n');
    fs.chmodSync(path.join(shim, 'node'), 0o755);

    const old = join(joiner, ['http://127.0.0.1:1'], { env: { PATH: `${shim}:/usr/bin:/bin` } });
    const oldExit = await exitOf(old);

    results.check('an old Node is named once, not twice',
      oldExit !== 0 && /node on PATH is v18\./.test(old.output()) && !/v1818/.test(old.output()),
      old.output());

    // No workers of its own: a frame can only land if the joined machine renders it.
    server = await startServer({
      port: PORT,
      cwd: box,
      env: { BLENDER_PATH: blender, WORKER_SLOTS: '0' }
    });

    const farm = server.base.replace(/\/api$/, '');

    console.log('\n  Joining a farm');

    const firstRun = join(joiner, [farm], {
      env: { BLENDER_PATH: blender },
      input: 'admin\nadmin123\n'
    });

    await exitOf(firstRun);

    results.check('the first-run admin is told to choose a password',
      /still has the password the farm started with/.test(firstRun.output()), firstRun.output());

    const token = await adminSession(server.base);

    joined = join(joiner, [farm], {
      env: { BLENDER_PATH: blender },
      input: `admin\n${ADMIN_PASSWORD}\n`
    });

    await rendering(joined);

    const job = await submitJob(server.base, token, createFakeScene(box, 'joined.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true });

    const rendered = await waitForCondition(
      async () => (await getJob(server.base, token, job.body.jobId)).status === 'completed',
      { label: 'the joined machine to render it', timeoutMs: 90000 })
      .then(() => true, () => false);

    results.check('a machine joins and renders a job on its own',
      rendered, joined.output().slice(-400));

    await stop(joined);
    joined = null;

    const issued = credential();

    // Nothing typed this time: one saved and still accepted is used as it is.
    const again = join(joiner, [farm], { env: { BLENDER_PATH: blender } });

    await rendering(again);

    const reused = /Rendering for/.test(again.output()) && credential() === issued;

    await stop(again);

    results.check('its credential is kept rather than asked for again',
      issued.startsWith('WORKER_TOKEN=') && reused, again.output());

    console.log('\n  After an admin revokes it');

    const listed = await (await fetch(`${server.base}/machines`, { headers: auth(token) })).json();

    for (const machine of listed.machines.filter(entry => !entry.isLocal)) {
      await fetch(`${server.base}/machines/${machine.id}`, { method: 'DELETE', headers: auth(token) });
    }

    const revoked = join(joiner, [farm], {
      env: { BLENDER_PATH: blender },
      input: `admin\n${ADMIN_PASSWORD}\n`
    });

    await rendering(revoked);

    const replaced = credential();

    await stop(revoked);

    results.check('a revoked credential is noticed rather than reused',
      /has been revoked/.test(revoked.output()), revoked.output());
    results.check('and a working one takes its place',
      /Rendering for/.test(revoked.output())
        && replaced.startsWith('WORKER_TOKEN=') && replaced !== issued,
      revoked.output());
  } finally {
    if (joined) await stop(joined);
    if (server) await stopServer(server);
    removeSandbox(box);
  }

  return results;
}
