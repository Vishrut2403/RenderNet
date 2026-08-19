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
  try {
    // A stand-in left running holds its files open, and Windows refuses to
    // unlink those. The sandbox is under the temp dir either way.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.log(`    (could not remove sandbox ${dir}: ${error.code})`);
  }
}

export function blenderAvailable() {
  const probe = spawnSync('blender', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// Blender renamed EEVEE's identifier twice across 4.x and 5.x, and an engine the
// installed Blender does not recognise fails every frame of the job. Asking it
// rather than hardcoding a list is the whole point.
export function blenderEngines() {
  const probe = spawnSync('blender', ['-b', '--factory-startup', '-E', 'help'], { encoding: 'utf8' });

  if (probe.status !== 0) return [];

  return probe.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[A-Z][A-Z_]+$/.test(line));
}

// EEVEE and Workbench rasterise, so they want a GL context that a headless
// machine with no GPU may not be able to give them. Cycles does not, which is
// why it is the one the rest of the suite renders with.
export function engineRenders(engine, blendPath, dir) {
  const pattern = path.join(dir, `probe_${engine}_####`);
  const produced = path.join(dir, `probe_${engine}_0001.png`);

  spawnSync('blender', ['-b', blendPath, '-E', engine, '-F', 'PNG', '-o', pattern, '-f', '1'],
    { encoding: 'utf8', timeout: 120000 });

  const rendered = fs.existsSync(produced);
  if (rendered) fs.rmSync(produced, { force: true });

  return rendered;
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

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// A stand-in for Blender that writes the frame the worker expects. Behaviour is
// keyed off the .blend filename so one server can drive every scenario:
// 'noisy' floods stdout, 'slow' takes its time per frame, 'hang' stays on one
// frame long enough to test against a job that is genuinely mid-render,
// 'stubborn' ignores a polite stop and stays alive so cancelling it has to force
// (wait for stubbornIsUnkillable before cancelling; see below),
// 'stalls' delivers its first frame and then never finishes another,
// 'broken' exits non-zero with its complaint on stdout, 'flaky' does so for
// one frame until a marker file says otherwise.
// The behaviour lives in a Node script, reached through a wrapper the platform
// can actually execute: a shell script on POSIX, a .cmd on Windows. The .cmd
// also puts the worker's own cmd.exe launch and process-tree kill under test,
// which is where Windows differs from everything else.
export function fakeBlenderPath(dir) {
  return path.join(dir, process.platform === 'win32' ? 'fake-blender.cmd' : 'fake-blender');
}

export function createFakeBlender(dir) {
  const scriptPath = path.join(dir, 'fake-blender.js');

  fs.writeFileSync(scriptPath, `const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const valueOf = flag => args[args.indexOf(flag) + 1];

const scene = path.basename(valueOf('-b') || '');
const frame = Number(valueOf('-f'));
const target = valueOf('-o').replace('####', String(frame).padStart(4, '0')) + '.png';

// Recorded so a test can assert on the command line the worker built, which is
// the only place render settings become visible.
fs.writeFileSync(path.join(path.dirname(valueOf('-b')), 'last-args.txt'), args.join(' '));

if (scene.includes('stubborn')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  // Until this exists the process is still bootable and a SIGTERM kills it
  // outright, so the caller has to wait for it before cancelling.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(target), 'refusing-to-exit'), '');
}

if (scene.includes('noisy')) {
  // Written synchronously, the way Blender writes its progress log.
  const line = 'x'.repeat(99) + '\\n';
  for (let i = 0; i < 4096; i++) fs.writeSync(1, line);
}

// 'flaky' fails its second frame until a 'fixed' marker appears beside the
// scene, so a job can fail for a reason somebody then puts right.
if (scene.includes('flaky') && frame === 2
    && !fs.existsSync(path.join(path.dirname(valueOf('-b')), 'fixed'))) {
  fs.writeSync(1, 'Error: frame 2 cannot be rendered yet\\n');
  process.exit(1);
}

if (scene.includes('broken')) {
  fs.writeSync(1, 'Error: cannot read scene\\n');
  process.exit(1);
}

const delay = scene.includes('hang') || scene.includes('stubborn') ? 60000
  : scene.includes('stalls') ? (frame === 1 ? 0 : 60000)
  : scene.includes('slow') ? 2000
  : 0;

setTimeout(() => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from('${PNG_1X1.toString('base64')}', 'base64'));
  process.exit(0);
}, delay);
`);

  const blenderPath = fakeBlenderPath(dir);

  if (process.platform === 'win32') {
    fs.writeFileSync(blenderPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    fs.writeFileSync(blenderPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    fs.chmodSync(blenderPath, 0o755);
  }

  return blenderPath;
}

// Node needs a few milliseconds to boot and install the handler, and a job is
// already 'rendering' the moment it is submitted - so a cancel sent as soon as
// the status flips lands before the stand-in can ignore anything, killing it on
// the default disposition and leaving the escalation path untested.
export function stubbornIsUnkillable(sandbox, jobId) {
  const marker = path.join(sandbox, 'worker-tmp', `job_${jobId}`, 'refusing-to-exit');

  return waitForCondition(() => fs.existsSync(marker), {
    label: 'the stubborn Blender to start refusing to exit'
  });
}

export function createFakeScene(dir, name) {
  const scenePath = path.join(dir, name);
  fs.writeFileSync(scenePath, Buffer.alloc(256, 3));
  return scenePath;
}

export async function waitForCondition(check, { timeoutMs = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(200);
  }

  console.log(`    (timed out waiting for ${label})`);
  return false;
}

export async function getJob(base, token, jobId) {
  return (await fetch(`${base}/jobs/${jobId}`, { headers: auth(token) })).json();
}

// Windows can refuse to rebind a port whose previous connections are still
// winding down, and the restart tests reuse one port on purpose.
const START_ATTEMPTS = 3;

export async function startServer(options) {
  let lastLog = '';

  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const { server, log } = await tryStartServer(options);
    if (server) return server;

    lastLog = log;
    await sleep(1000);
  }

  throw new Error(`Server did not start on port ${options.port}:\n${lastLog}`);
}

async function tryStartServer({ port, cwd, dataDir = cwd, env = {} }) {
  const proc = spawn(process.execPath, [path.join(BACKEND_ROOT, 'src', 'index.js')], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'test.db'),
      WORKER_SECRET: 'test-worker-secret',
      SIGNUP_CODE: SIGNUP_CODE,
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
      if (res.ok) return { server: { proc, base, getLog: () => log } };
    } catch {
      // not listening yet
    }

    if (proc.exitCode !== null || proc.signalCode !== null) break;

    await sleep(250);
  }

  proc.kill('SIGKILL');

  return { log };
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

export const SIGNUP_CODE = 'test-signup-code';
export const ADMIN_PASSWORD = 'workshop-admin-pw';

// The seeded admin can do nothing until its password is replaced, so suites
// start by doing that. Servers restarted mid-suite log straight back in.
export async function adminSession(base) {
  try {
    const token = await login(base, 'admin', 'admin123');

    const res = await fetch(`${base}/auth/change-password`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'admin123', newPassword: ADMIN_PASSWORD })
    });

    if (!res.ok) throw new Error(`Could not clear the forced change: ${await res.text()}`);

    return token;
  } catch {
    return login(base, 'admin', ADMIN_PASSWORD);
  }
}

export async function signUp(base, username, password, code = SIGNUP_CODE) {
  const res = await fetch(`${base}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, code })
  });

  return res.status;
}

export async function status(url, options) {
  const res = await fetch(url, options);
  return res.status;
}

export async function submitJob(base, token, blendPath, {
  frameStart, frameEnd, engine = 'CYCLES', priority = 0, resolutionPercent, samples
}) {
  const form = new FormData();
  form.set('blend', new Blob([fs.readFileSync(blendPath)]), path.basename(blendPath));
  form.set('frameStart', String(frameStart));
  form.set('frameEnd', String(frameEnd));
  form.set('renderEngine', engine);
  form.set('priority', String(priority));
  if (resolutionPercent !== undefined) form.set('resolutionPercent', String(resolutionPercent));
  if (samples !== undefined) form.set('samples', String(samples));

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
