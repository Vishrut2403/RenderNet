// A credential per machine rather than one secret for all of them: what a
// machine may do with it, and what revoking it takes away.
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession, signUp,
  login, auth, submitJob, createFakeBlender, createFakeScene, waitForCondition, getJob
} from './helpers.mjs';

const PORT = 5599;
const LOCAL_PORT = 5600;
const SHARED = 'test-worker-secret';

function asMachine(token, extra = {}) {
  return { 'x-worker-token': token, ...extra };
}

async function lease(base, token, slot) {
  const res = await fetch(`${base}/worker/lease`, {
    method: 'POST',
    headers: asMachine(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ workerId: slot })
  });

  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

async function machines(base, token) {
  const res = await fetch(`${base}/machines`, { headers: auth(token) });
  return { status: res.status, body: await res.json() };
}

async function mint(base, token, name) {
  const res = await fetch(`${base}/machines`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });

  return { status: res.status, body: await res.json() };
}

async function revoke(base, token, id) {
  const res = await fetch(`${base}/machines/${id}`, { method: 'DELETE', headers: auth(token) });
  return { status: res.status, body: await res.json() };
}

export default async function run() {
  const results = createResults('worker-credentials');
  const sandbox = makeSandbox('credentials');

  let server;

  try {
    // No local workers, so the only machines asking for frames are this test's.
    server = await startServer({
      port: PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox), WORKER_SLOTS: '0' }
    });

    const { base } = server;
    const admin = await adminSession(base);
    await signUp(base, 'painter', 'painter-password');
    const painter = await login(base, 'painter', 'painter-password');

    console.log('\n  Who may hand out credentials');

    const listed = await machines(base, admin);

    results.check('an admin sees the machines that may render', listed.status === 200,
      String(listed.status));
    results.check('the shared secret from the environment is one of them',
      listed.body.machines.some(machine => machine.name === 'Shared WORKER_SECRET'),
      JSON.stringify(listed.body.machines.map(machine => machine.name)));
    results.check('and no credential is ever handed back',
      listed.body.machines.every(machine =>
        !('token' in machine) && !('tokenHash' in machine)),
      JSON.stringify(listed.body.machines[0]));

    results.check('somebody who is not an admin cannot see them',
      (await machines(base, painter)).status === 403);
    results.check('nor issue one',
      (await mint(base, painter, 'Sneaky PC')).status === 403);
    results.check('nor take one away',
      (await revoke(base, painter, 'anything')).status === 403);

    const unnamed = await mint(base, admin, '   ');
    results.check('a machine cannot be issued a credential without a name',
      unnamed.status === 400, JSON.stringify(unnamed.body));

    console.log('\n  A machine of its own');

    const first = await mint(base, admin, 'Studio PC');
    const second = await mint(base, admin, 'Spare laptop');

    results.check('issuing one returns the token exactly once',
      first.status === 201 && typeof first.body.token === 'string'
      && first.body.token.length >= 32,
      JSON.stringify({ status: first.status, id: first.body.id }));
    results.check('and the token is not in the listing afterwards',
      (await machines(base, admin)).body.machines
        .every(machine => !('token' in machine)));

    results.check('an unknown token renders nothing',
      (await lease(base, 'not-a-real-token', 'slot-0')).status === 401);

    const scene = createFakeScene(sandbox, 'shared.blend');
    const job = await submitJob(base, admin, scene,
      { frameStart: 1, frameEnd: 4, skipAssetCheck: true });
    const jobId = job.body.jobId;

    await waitForCondition(async () => (await getJob(base, admin, jobId)).status === 'rendering',
      { label: 'the job to start' });

    const claimed = await lease(base, first.body.token, 'slot-0');

    results.check('a machine with a credential is given a frame',
      claimed.status === 200 && claimed.body.lease?.frame === 1,
      JSON.stringify({ status: claimed.status, frame: claimed.body?.lease?.frame }));

    const leaseId = claimed.body.lease.leaseId;

    results.check('using it is recorded against the machine',
      !!(await machines(base, admin)).body.machines
        .find(machine => machine.id === first.body.id)?.lastSeen);

    console.log('\n  One machine cannot reach into another\'s work');

    const stolenRenew = await fetch(`${base}/worker/leases/${leaseId}/renew`, {
      method: 'POST', headers: asMachine(second.body.token)
    });

    results.check('a claim cannot be renewed by the machine that does not hold it',
      stolenRenew.status === 409, String(stolenRenew.status));

    const stolenRelease = await fetch(`${base}/worker/leases/${leaseId}/release`, {
      method: 'POST', headers: asMachine(second.body.token)
    });

    results.check('nor released by it',
      (await stolenRelease.json()).released === false);

    const ownRenew = await fetch(`${base}/worker/leases/${leaseId}/renew`, {
      method: 'POST', headers: asMachine(first.body.token)
    });

    results.check('while the machine holding it renews it as usual',
      ownRenew.status === 200, String(ownRenew.status));

    const takenScene = await fetch(`${base}/worker/jobs/${jobId}/blend`, {
      headers: asMachine(second.body.token)
    });

    results.check('a scene is not handed to a machine with no claim on it',
      takenScene.status === 403, String(takenScene.status));

    const ownScene = await fetch(`${base}/worker/jobs/${jobId}/blend`, {
      headers: asMachine(first.body.token)
    });

    results.check('but the machine rendering it may fetch it',
      ownScene.status === 200, String(ownScene.status));

    console.log('\n  Taking a machine away');

    const gone = await revoke(base, admin, first.body.id);

    results.check('a credential can be revoked', gone.status === 200, JSON.stringify(gone.body));
    results.check('after which that machine is asked to authenticate again',
      (await lease(base, first.body.token, 'slot-0')).status === 401);
    results.check('and it can no longer fetch the scene it was rendering',
      (await fetch(`${base}/worker/jobs/${jobId}/blend`,
        { headers: asMachine(first.body.token) })).status === 401);
    results.check('the listing says when it was revoked',
      !!(await machines(base, admin)).body.machines
        .find(machine => machine.id === first.body.id)?.revokedAt);
    results.check('revoking it twice changes nothing',
      (await revoke(base, admin, first.body.id)).status === 409);
    results.check('and a machine that never existed is not found',
      (await revoke(base, admin, 'nonexistent')).status === 404);
    results.check('the shared secret can be revoked once nobody needs it',
      (await revoke(base, admin,
        (await machines(base, admin)).body.machines
          .find(machine => machine.name === 'Shared WORKER_SECRET').id)).status === 200);
    results.check('and it stops working like any other',
      (await lease(base, SHARED, 'slot-0')).status === 401);
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  await theWorkstationItself(results);

  return results;
}

// The machine the server runs on mints its own at every boot, so nobody has to
// configure it and nothing reusable is left behind when it stops.
async function theWorkstationItself(results) {
  const sandbox = makeSandbox('credentials-local');
  let server;

  try {
    server = await startServer({
      port: LOCAL_PORT,
      cwd: sandbox,
      env: { BLENDER_PATH: createFakeBlender(sandbox) }
    });

    const { base } = server;
    const admin = await adminSession(base);

    console.log('\n  The workstation the server runs on');

    const job = await submitJob(base, admin, createFakeScene(sandbox, 'local.blend'),
      { frameStart: 1, frameEnd: 1, skipAssetCheck: true });

    await waitForCondition(
      async () => ['completed', 'failed'].includes((await getJob(base, admin, job.body.jobId)).status),
      { label: 'the local worker to render the job', timeoutMs: 30000 }
    );

    const listed = await machines(base, admin);
    const workstation = listed.body.machines.find(machine => machine.isLocal);

    results.check('renders on the workstation itself use a credential of its own',
      !!workstation, JSON.stringify(listed.body.machines.map(machine => machine.name)));
    results.check('which nobody has had to configure', !!workstation?.lastSeen);
    results.check('and which cannot be revoked out from under it',
      (await revoke(base, admin, workstation.id)).status === 400);
  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }
}
