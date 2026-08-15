// End-to-end HTTP tests against a real server instance in a sandbox directory.
// Render-dependent checks are skipped when Blender is unavailable.
import fs from 'fs';
import path from 'path';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  login, auth, status, submitJob, waitForJob, blenderAvailable, createFixtureBlend
} from './helpers.mjs';

const PORT = 5592;

export default async function run() {
  const results = createResults('api');
  const sandbox = makeSandbox('api');
  let server;

  try {
    server = await startServer({ port: PORT, cwd: sandbox });
    const { base } = server;

    const adminToken = await login(base, 'admin', 'admin123');

    await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'testpass123' })
    });
    const userToken = await login(base, 'tester', 'testpass123');

    // Only the extension is checked at upload time, so validation and access
    // control can be exercised without invoking Blender.
    const stubBlend = path.join(sandbox, 'stub.blend');
    fs.writeFileSync(stubBlend, Buffer.alloc(1024, 7));

    console.log('\n  Upload validation');
    const bad = async opts => (await submitJob(base, adminToken, stubBlend, opts)).status;
    results.check('end before start rejected', await bad({ frameStart: 5, frameEnd: 1 }) === 400);
    results.check('non-integer range rejected', await bad({ frameStart: 'abc', frameEnd: 3 }) === 400);
    results.check('negative start rejected', await bad({ frameStart: -2, frameEnd: 3 }) === 400);
    results.check('oversized range rejected', await bad({ frameStart: 1, frameEnd: 99999 }) === 400);
    results.check('unknown engine rejected', await bad({ frameStart: 1, frameEnd: 2, engine: 'EVIL' }) === 400);

    const notBlend = path.join(sandbox, 'notablend.txt');
    fs.writeFileSync(notBlend, 'nope');
    results.check('non-blend file rejected with 400',
      (await submitJob(base, adminToken, notBlend, { frameStart: 1, frameEnd: 1 })).status === 400);

    console.log('\n  Ownership and access control');
    const stub = await submitJob(base, adminToken, stubBlend, { frameStart: 1, frameEnd: 1 });
    const stubId = stub.body.jobId;

    const adminJob = await (await fetch(`${base}/jobs/${stubId}`, { headers: auth(adminToken) })).json();
    results.check('owner comes from session, not request body', adminJob.owner === 'admin', adminJob.owner);
    results.check('output folder id matches job id',
      adminJob.outputFolder.endsWith(String(adminJob.id)), adminJob.outputFolder);

    results.check('other user cannot read the job',
      await status(`${base}/jobs/${stubId}`, { headers: auth(userToken) }) === 403);
    results.check('other user cannot cancel the job',
      await status(`${base}/jobs/${stubId}/cancel`, { method: 'POST', headers: auth(userToken) }) === 403);

    const userList = await (await fetch(`${base}/jobs`, { headers: auth(userToken) })).json();
    results.check('job list excludes other users jobs', userList.total === 0, `got ${userList.total}`);

    const adminList = await (await fetch(`${base}/jobs`, { headers: auth(adminToken) })).json();
    results.check('admin sees all jobs', adminList.total > 0, `got ${adminList.total}`);

    console.log('\n  Admin endpoints');
    results.check('admin can list users',
      await status(`${base}/auth/users`, { headers: auth(adminToken) }) === 200);
    results.check('non-admin cannot list users',
      await status(`${base}/auth/users`, { headers: auth(userToken) }) === 403);

    const users = await (await fetch(`${base}/auth/users`, { headers: auth(adminToken) })).text();
    results.check('password hashes are not exposed', !users.includes('passwordHash'));

    console.log('\n  Worker callback authentication');
    results.check('worker route rejects a request with no secret',
      await status(`${base}/worker/jobs/1/progress`, { method: 'POST' }) === 401);

    if (!blenderAvailable()) {
      console.log('\n  Rendering, downloads and persistence');
      for (const name of ['render completes', 'frames written', 'download by header',
        'download by query token', 'cross-user download denied', 'traversal blocked',
        'session survives restart', 'job survives restart', 'download survives restart']) {
        results.skipped(name, 'Blender not installed');
      }
      return results;
    }

    console.log('\n  Rendering');
    const blend = createFixtureBlend(sandbox);
    const submitted = await submitJob(base, adminToken, blend, { frameStart: 1, frameEnd: 2 });
    const jobId = submitted.body.jobId;
    const finished = await waitForJob(base, adminToken, jobId);

    results.check('render completes', finished.status === 'completed',
      `${finished.status}: ${finished.error || ''}`);
    results.check('frames written to disk',
      fs.readdirSync(path.join(sandbox, finished.outputFolder)).length === 2);

    console.log('\n  Downloads');
    results.check('download by header',
      await status(`${base}/download/${jobId}/zip`, { headers: auth(adminToken) }) === 200);
    results.check('download by query token',
      await status(`${base}/download/files/render_${jobId}/frame_0001.png?token=${adminToken}`) === 200);
    results.check('unauthenticated download rejected',
      await status(`${base}/download/${jobId}/zip`) === 401);
    results.check('cross-user download denied',
      await status(`${base}/download/files/render_${jobId}/frame_0001.png?token=${userToken}`) === 403);
    results.check('path traversal blocked',
      await status(`${base}/download/files/render_${jobId}/..%2f..%2fusers.json?token=${adminToken}`) === 404);

    console.log('\n  Persistence across restart');
    await stopServer(server);
    server = await startServer({ port: PORT, cwd: sandbox });

    results.check('session survives restart',
      await status(`${server.base}/jobs`, { headers: auth(adminToken) }) === 200);

    const recovered = await (await fetch(`${server.base}/jobs/${jobId}`, { headers: auth(adminToken) })).json();
    results.check('job record survives restart', recovered.status === 'completed', recovered.status);
    results.check('progress survives restart', recovered.progress === 100, `got ${recovered.progress}`);
    results.check('download still works after restart',
      await status(`${server.base}/download/${jobId}/zip`, { headers: auth(adminToken) }) === 200);

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
