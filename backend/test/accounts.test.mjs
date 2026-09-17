// Accounts at their edges: a revoked shared credential across a restart, an
// account still on a password somebody else set, two signups for one name, and
// lockouts that a password reset or a stolen session should not get around.
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession,
  auth, createFakeBlender, SIGNUP_CODE
} from './helpers.mjs';

const PORT = 5630;
const RESTART_PORT = 5631;

function post(base, route, body, token) {
  return fetch(`${base}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? auth(token) : {}) },
    body: JSON.stringify(body)
  });
}

async function signIn(base, username, password) {
  const res = await post(base, 'auth/login', { username, password });
  return { status: res.status, body: await res.json() };
}

export default async function run() {
  const results = createResults('accounts');
  const box = makeSandbox('accounts');
  const restartBox = makeSandbox('accounts-restart');
  let server;
  let restarted;

  try {
    const blender = createFakeBlender(box);

    server = await startServer({ port: PORT, cwd: box, env: { BLENDER_PATH: blender } });
    const { base } = server;

    console.log('\n  An account nobody has taken over yet');

    // Signed in with the password everybody knows, and not yet changed.
    const fresh = await signIn(base, 'admin', 'admin123');
    const health = await (await fetch(`${base}/health`, { headers: auth(fresh.body.token) })).json();

    results.check('health tells it no more than it tells a stranger',
      fresh.body.mustChangePassword === true && health.workers === undefined
        && health.active === undefined,
      JSON.stringify(Object.keys(health)));

    const admin = await adminSession(base);

    console.log('\n  Two people asking for one name at once');

    const answers = await Promise.all(['first-password', 'second-password'].map(password =>
      post(base, 'auth/signup', { username: 'twin', password, code: SIGNUP_CODE })
        .then(res => res.status)));
    const firstWorks = (await signIn(base, 'twin', 'first-password')).status === 200;
    const secondWorks = (await signIn(base, 'twin', 'second-password')).status === 200;

    results.check('only one of them gets the account',
      answers.filter(status => status === 200).length === 1 && firstWorks !== secondWorks,
      `signups answered ${answers}; first password works: ${firstWorks}, second: ${secondWorks}`);

    console.log('\n  Locked out, then given a new password');

    await post(base, 'auth/signup', { username: 'forgetful', password: 'right-password', code: SIGNUP_CODE });

    for (let attempt = 0; attempt < 5; attempt++) {
      await signIn(base, 'forgetful', 'wrong-password');
    }

    const locked = await signIn(base, 'forgetful', 'right-password');
    const reset = await post(base, 'auth/admin/reset-password',
      { targetUsername: 'forgetful', newPassword: 'fresh-password' }, admin);
    const after = await signIn(base, 'forgetful', 'fresh-password');

    results.check('the reset password lets them straight in',
      locked.status === 429 && reset.status === 200 && after.status === 200,
      `locked ${locked.status}, reset ${reset.status}, then ${after.status}`);

    console.log('\n  Guessing the password from inside a session');

    await post(base, 'auth/signup', { username: 'guarded', password: 'real-password', code: SIGNUP_CODE });
    const stolen = (await signIn(base, 'guarded', 'real-password')).body.token;
    const tries = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      tries.push((await post(base, 'auth/change-password',
        { oldPassword: `guess-${attempt}`, newPassword: 'taken-over' }, stolen)).status);
    }

    const rightGuess = await post(base, 'auth/change-password',
      { oldPassword: 'real-password', newPassword: 'taken-over' }, stolen);

    results.check('wrong current passwords lock the change like a sign-in',
      tries.slice(0, 5).every(status => status === 400) && tries[5] === 429
        && rightGuess.status === 429,
      `answers ${tries.join(',')}, then the right one ${rightGuess.status}`);

    console.log('\n  The shared credential, revoked, across a restart');

    const env = { BLENDER_PATH: blender, WORKER_SECRET: 'shared-for-now' };

    restarted = await startServer({ port: RESTART_PORT, cwd: restartBox, env });

    const restartAdmin = await adminSession(restarted.base);
    const machines = await (await fetch(`${restarted.base}/machines`, { headers: auth(restartAdmin) })).json();
    const sharedMachine = machines.machines.find(machine => machine.name === 'Shared WORKER_SECRET');

    await fetch(`${restarted.base}/machines/${sharedMachine.id}`,
      { method: 'DELETE', headers: auth(restartAdmin) });
    await stopServer(restarted);
    restarted = null;

    let cameBack = true;

    try {
      restarted = await startServer({ port: RESTART_PORT, cwd: restartBox, env });
    } catch {
      cameBack = false;
    }

    const stillRevoked = cameBack
      && (await fetch(`${restarted.base}/worker/jobs/0/blend`,
        { headers: { 'x-worker-token': 'shared-for-now' } })).status === 401;

    results.check('the farm still starts, and the credential stays revoked',
      cameBack && stillRevoked, `started: ${cameBack}; still refused: ${stillRevoked}`);
  } finally {
    if (restarted) await stopServer(restarted);
    if (server) await stopServer(server);
    removeSandbox(box);
    removeSandbox(restartBox);
  }

  return results;
}
