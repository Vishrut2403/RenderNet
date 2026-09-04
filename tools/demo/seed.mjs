// Fills a running RenderNet with jobs in the states worth photographing: work
// finished, work in flight, work queued behind it, one still waiting on its
// owner and one that was stopped before it wasted the machine's night.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.DEMO_API || 'http://localhost:5500/api';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TURNTABLE = path.join(HERE, 'turntable.blend');
const BROKEN = path.join(HERE, 'missing-texture.blend');
const PASSWORD = 'demo1234';
const SIGNUP_CODE = process.env.SIGNUP_CODE || 'rendernet-demo';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function adminSession() {
  const first = await api('/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' }
  });

  if (first.status === 200 && first.body.mustChangePassword) {
    await api('/auth/change-password', {
      method: 'POST',
      token: first.body.token,
      body: { oldPassword: 'admin123', newPassword: PASSWORD }
    });
  }

  const signedIn = await api('/auth/login', {
    method: 'POST', body: { username: 'admin', password: PASSWORD }
  });

  if (signedIn.status !== 200) {
    throw new Error(`Could not sign in as admin: ${JSON.stringify(signedIn.body)}`);
  }

  return signedIn.body.token;
}

async function join(username) {
  await api('/auth/signup', {
    method: 'POST', body: { username, password: PASSWORD, code: SIGNUP_CODE }
  });

  const signedIn = await api('/auth/login', {
    method: 'POST', body: { username, password: PASSWORD }
  });

  return signedIn.body.token;
}

async function submit(token, blend, name, settings) {
  const form = new FormData();
  form.set('blend', new Blob([fs.readFileSync(blend)]), name);

  for (const [key, value] of Object.entries(settings)) form.set(key, String(value));

  const response = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

  const body = await response.json();

  if (!response.ok) throw new Error(`${name}: ${JSON.stringify(body)}`);

  console.log(`  submitted ${name} as job ${body.jobId}`);

  return body.jobId;
}

async function settled(token, jobId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { body } = await api(`/jobs/${jobId}`, { token });

    if (['completed', 'failed', 'cancelled'].includes(body.status)) return body;
    if (body.approval === 'waiting') return body;

    await sleep(2000);
  }

  throw new Error(`Job ${jobId} never settled`);
}

const admin = await adminSession();
const maya = await join('maya');

console.log('\nA finished animation, with a video of it');
const animation = await submit(admin, TURNTABLE, 'turntable.blend',
  { frameStart: 1, frameEnd: 6, renderEngine: 'CYCLES', formats: 'PNG', priority: 0 });
await settled(admin, animation);
await api(`/jobs/${animation}/video`, { method: 'POST', token: admin });

console.log('\nA still split across the farm');
const still = await submit(maya, TURNTABLE, 'hero-shot.blend',
  { frameStart: 12, frameEnd: 12, renderEngine: 'CYCLES', formats: 'PNG', tiles: 4 });
await settled(maya, still);

console.log('\nA job waiting on its owner to approve the first frame');
const waiting = await submit(admin, TURNTABLE, 'lighting-test.blend',
  { frameStart: 1, frameEnd: 48, renderEngine: 'CYCLES', formats: 'PNG', testFrame: 1 });
await settled(admin, waiting);

console.log('\nA scene stopped before it wasted the night');
const broken = await submit(maya, BROKEN, 'kitchen-set.blend',
  { frameStart: 1, frameEnd: 120, renderEngine: 'CYCLES', formats: 'PNG' });
await settled(maya, broken);

console.log('\nWork in flight, and a queue behind it');
await submit(admin, TURNTABLE, 'sequence-a.blend',
  { frameStart: 1, frameEnd: 24, renderEngine: 'CYCLES', formats: 'PNG,JPEG' });
await sleep(6000);
await submit(maya, TURNTABLE, 'sequence-b.blend',
  { frameStart: 1, frameEnd: 36, renderEngine: 'CYCLES', formats: 'PNG' });
await submit(admin, TURNTABLE, 'promo-render.blend',
  { frameStart: 1, frameEnd: 60, renderEngine: 'CYCLES', formats: 'PNG', priority: 1 });

console.log(`\nReady. Sign in at ${BASE.replace('/api', '')} as admin / ${PASSWORD}`);
console.log('(maya has the same password, to see the farm as somebody who is not an admin)');
