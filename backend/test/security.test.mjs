// What the browser is told to enforce, who may call the API from another
// origin, and how many guesses the signup code is worth. Runs without Blender.
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, signUp, SIGNUP_CODE
} from './helpers.mjs';

const PORT = 5596;
const CORS_PORT = 5597;
const ALLOWED = 'http://studio.local:8080';

async function headersOf(url, options = {}) {
  const res = await fetch(url, options);
  await res.arrayBuffer();
  return { status: res.status, headers: res.headers };
}

export default async function run() {
  const results = createResults('security');

  const sandbox = makeSandbox('security');
  const corsSandbox = makeSandbox('security-cors');

  let server;
  let corsServer;

  try {
    server = await startServer({ port: PORT, cwd: sandbox });
    const { base } = server;

    console.log('\n  What the browser is told to enforce');

    const api = await headersOf(`${base}/health`);
    const policy = api.headers.get('content-security-policy') ?? '';

    results.check('a policy is sent', policy.length > 0, policy);
    results.check('scripts may only come from this origin',
      policy.includes("script-src 'self'"), policy);
    results.check('and the page may not be framed',
      policy.includes("frame-ancestors 'none'"), policy);
    results.check('content types are not sniffed',
      api.headers.get('x-content-type-options') === 'nosniff',
      api.headers.get('x-content-type-options'));
    results.check('referrers do not leave the origin',
      api.headers.get('referrer-policy') === 'same-origin',
      api.headers.get('referrer-policy'));

    console.log('\n  Who may call the API from another origin');

    // The UI this server ships is same-origin, so by default a page on another
    // site gets no permission to read anything it asks for.
    const uninvited = await headersOf(`${base}/health`, {
      headers: { Origin: 'http://somewhere-else.example' }
    });

    results.check('nobody, unless a deployment says so',
      uninvited.headers.get('access-control-allow-origin') === null,
      uninvited.headers.get('access-control-allow-origin'));

    corsServer = await startServer({
      port: CORS_PORT, cwd: corsSandbox, env: { ALLOWED_ORIGINS: ALLOWED }
    });

    const invited = await headersOf(`${corsServer.base}/health`, { headers: { Origin: ALLOWED } });
    results.check('a named origin is allowed',
      invited.headers.get('access-control-allow-origin') === ALLOWED,
      invited.headers.get('access-control-allow-origin'));

    const stranger = await headersOf(`${corsServer.base}/health`, {
      headers: { Origin: 'http://not-this-one.example' }
    });
    results.check('and only that one',
      stranger.headers.get('access-control-allow-origin') === null,
      stranger.headers.get('access-control-allow-origin'));

    console.log('\n  Guessing the signup code');

    for (let attempt = 1; attempt <= 5; attempt++) {
      await signUp(base, `guess${attempt}`, 'guessing-password', 'not-the-code');
    }

    const locked = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'guess6', password: 'guessing-password', code: 'wrong' })
    });

    results.check('a run of wrong codes is locked out', locked.status === 429, String(locked.status));
    results.check('and told when to come back',
      Number(locked.headers.get('retry-after')) > 0, locked.headers.get('retry-after'));

    // The lock is on the caller, not the code: knowing it does not undo a
    // spree of guesses from the same place.
    results.check('the right code is refused too while the lock holds',
      await signUp(base, 'latecomer', 'a-real-password', SIGNUP_CODE) === 429);

  } finally {
    await stopServer(server);
    await stopServer(corsServer);
    removeSandbox(sandbox);
    removeSandbox(corsSandbox);
  }

  return results;
}
