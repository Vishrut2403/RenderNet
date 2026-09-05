// What the browser is told to enforce, who may call the API from another
// origin, and how many guesses the signup code is worth. Runs without Blender.
import fs from 'fs';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, signUp, SIGNUP_CODE,
  createCertificate, httpsGet, status
} from './helpers.mjs';

const PORT = 5596;
const CORS_PORT = 5597;
const TLS_PORT = 5611;
const PROXY_PORT = 5615;
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

    results.check('no promise of HTTPS is made over plain HTTP',
      api.headers.get('strict-transport-security') === null,
      api.headers.get('strict-transport-security'));

    await behindAProxy(results);

  } finally {
    await stopServer(server);
    await stopServer(corsServer);
    removeSandbox(sandbox);
    removeSandbox(corsSandbox);
  }

  await overTls(results);

  return results;
}

// Every request through a reverse proxy arrives from the proxy, so without
// being told to read the forwarded address the lock is on the proxy and one
// spree of guesses shuts signups for everybody.
async function behindAProxy(results) {
  const box = makeSandbox('security-proxy');
  let server;

  try {
    console.log('\n  Guessing it from behind a proxy');

    server = await startServer({ port: PROXY_PORT, cwd: box, env: { TRUST_PROXY: '1' } });

    const guess = (from, name, code) => status(`${server.base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
      body: JSON.stringify({ username: name, password: 'guessing-password', code })
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await guess('203.0.113.5', `proxied${attempt}`, 'not-the-code');
    }

    results.check('the machine doing the guessing is locked out',
      await guess('203.0.113.5', 'proxied6', 'not-the-code') === 429);
    results.check('and everybody else behind the same proxy is not',
      await guess('203.0.113.9', 'innocent', SIGNUP_CODE) === 200);
  } finally {
    await stopServer(server);
    removeSandbox(box);
  }
}

// Everything the farm carries - passwords, session tokens, whole scenes -
// crosses the network, so the server can hold the certificate itself rather
// than needing something in front of it.
async function overTls(results) {
  const box = makeSandbox('tls');
  const certificate = createCertificate(box);

  if (!certificate) {
    for (const name of ['the server answers over HTTPS', 'and says so for a year',
      'a half-configured pair refuses to start']) {
      results.skipped(name, 'openssl not available');
    }
    removeSandbox(box);
    return;
  }

  let server;

  try {
    console.log('\n  Serving over TLS');

    const ca = fs.readFileSync(certificate.cert);

    server = await startServer({
      port: TLS_PORT,
      cwd: box,
      ca,
      env: { TLS_KEY: certificate.key, TLS_CERT: certificate.cert }
    });

    const answered = await httpsGet(`${server.base}/health`, ca);

    // Whether the farm itself is healthy is another test's business: a runner
    // without Blender answers 'degraded' over a perfectly good connection.
    results.check('the server answers over HTTPS',
      answered.status === 200 && typeof JSON.parse(answered.body).status === 'string',
      answered.body);
    results.check('and says so for a year',
      answered.headers['strict-transport-security'] === 'max-age=31536000',
      answered.headers['strict-transport-security']);

    // Serving plain HTTP after being told to use TLS would be a downgrade
    // nobody would notice.
    const halfConfigured = makeSandbox('tls-half');
    let refused = false;

    try {
      const started = await startServer({
        port: TLS_PORT + 1,
        cwd: halfConfigured,
        env: { TLS_KEY: certificate.key }
      });
      await stopServer(started);
    } catch {
      refused = true;
    }

    results.check('a half-configured pair refuses to start', refused);
    removeSandbox(halfConfigured);

  } finally {
    await stopServer(server);
    removeSandbox(box);
  }
}
