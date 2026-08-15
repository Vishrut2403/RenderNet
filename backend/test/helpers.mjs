import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createResults(suiteName) {
  const results = { suite: suiteName, pass: 0, fail: 0, skip: 0, failures: [] };

  results.check = (name, condition, detail = '') => {
    if (condition) {
      results.pass++;
      console.log(`  ok    ${name}`);
    } else {
      results.fail++;
      results.failures.push(`${suiteName}: ${name} ${detail}`.trim());
      console.log(`  FAIL  ${name} ${detail}`);
    }
  };

  results.skipped = (name, why) => {
    results.skip++;
    console.log(`  skip  ${name} (${why})`);
  };

  return results;
}

// The suites set env vars that modules read at import time, so each must put
// process.env back as it found it or it leaks into whatever runs next.
export function snapshotEnv(keys) {
  const saved = new Map(keys.map(key => [key, process.env[key]]));

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// Each run gets its own directory so the server's uploads/, renders/,
// worker-tmp/, users.json and database never touch real data.
export function makeSandbox(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rendernet-${prefix}-`));
}

export function removeSandbox(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function blenderAvailable() {
  const probe = spawnSync('blender', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// Renders fast: 64x64, one Cycles sample, no denoising.
export function createFixtureBlend(dir) {
  const blendPath = path.join(dir, 'fixture.blend');
  const script = `
import bpy
s = bpy.context.scene
s.render.resolution_x = 64
s.render.resolution_y = 64
s.render.engine = 'CYCLES'
s.cycles.samples = 1
s.cycles.use_denoising = False
bpy.ops.wm.save_as_mainfile(filepath=r'${blendPath}')
`;

  const result = spawnSync(
    'blender',
    ['-b', '--factory-startup', '--python-expr', script],
    { encoding: 'utf8', timeout: 180000 }
  );

  if (result.status !== 0 || !fs.existsSync(blendPath)) {
    throw new Error(`Failed to build fixture blend: ${result.stderr || result.stdout}`);
  }

  return blendPath;
}

export async function startServer({ port, cwd, env = {} }) {
  const proc = spawn('node', [path.join(BACKEND_ROOT, 'src', 'index.js')], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(cwd, 'test.db'),
      WORKER_SECRET: 'test-worker-secret',
      API_URL: `http://127.0.0.1:${port}`,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  proc.on('exit', code => {
    if (code !== 0 && code !== null) console.error(`Server exited ${code}:\n${log}`);
  });

  const base = `http://127.0.0.1:${port}/api`;

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { proc, base, getLog: () => log };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }

  proc.kill('SIGKILL');
  throw new Error(`Server did not start on port ${port}:\n${log}`);
}

export async function stopServer(server) {
  if (!server?.proc || server.proc.exitCode !== null) return;

  server.proc.kill('SIGTERM');

  for (let attempt = 0; attempt < 20; attempt++) {
    if (server.proc.exitCode !== null) return;
    await sleep(100);
  }

  server.proc.kill('SIGKILL');
}

export async function login(base, username, password) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const body = await res.json();

  if (!body.token) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);

  return body.token;
}

export function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

export async function status(url, options) {
  const res = await fetch(url, options);
  return res.status;
}

export async function submitJob(base, token, blendPath, { frameStart, frameEnd, engine = 'CYCLES' }) {
  const form = new FormData();
  form.set('blend', new Blob([fs.readFileSync(blendPath)]), path.basename(blendPath));
  form.set('frameStart', String(frameStart));
  form.set('frameEnd', String(frameEnd));
  form.set('renderEngine', engine);

  const res = await fetch(`${base}/upload`, { method: 'POST', headers: auth(token), body: form });
  return { status: res.status, body: await res.json() };
}

export async function waitForJob(base, token, jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${base}/jobs/${jobId}`, { headers: auth(token) });
    const job = await res.json();

    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;

    await sleep(1000);
  }

  throw new Error(`Job ${jobId} did not settle within ${timeoutMs}ms`);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
