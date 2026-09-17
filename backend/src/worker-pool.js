import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { localMachineToken, machineFor } from './worker-tokens.js';

const WORKER_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'worker-main.js');
const RESTART_DELAY_MS = 2000;

function slots() {
  const configured = Number(process.env.WORKER_SLOTS);
  return Number.isInteger(configured) && configured >= 0 ? configured : 1;
}

const children = new Map();
let stopping = false;
let lost = () => {};

export function whenWorkerLost(handler) {
  lost = handler;
}

function claimedAs(index) {
  return `${machineFor(localMachineToken()).id}:worker-${index}`;
}

function forward(stream, index, write) {
  let buffered = '';

  stream.setEncoding('utf8');

  stream.on('data', chunk => {
    buffered += chunk;

    const lines = buffered.split('\n');
    buffered = lines.pop();

    if (buffered.length > 8192) {
      lines.push(buffered);
      buffered = '';
    }

    for (const line of lines) {
      if (line.trim()) write(`[worker-${index}] ${line}`);
    }
  });
}

function launchWorker(index) {
  if (stopping) return;

  const child = spawn(process.execPath, [WORKER_MAIN], {
    env: { ...process.env, WORKER_ID: `worker-${index}`, WORKER_TOKEN: localMachineToken() },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  children.set(index, child);

  forward(child.stdout, index, console.log);
  forward(child.stderr, index, console.error);

  child.on('exit', (code, signal) => {
    children.delete(index);
    lost(claimedAs(index));

    if (stopping) return;

    console.warn(`Worker ${index} exited (${signal || code}), starting another`);
    setTimeout(() => launchWorker(index), RESTART_DELAY_MS).unref?.();
  });

  child.on('error', error => console.error(`Worker ${index} could not start: ${error.message}`));
}

export function ensureWorkers() {
  stopping = false;

  for (let index = 0; index < slots(); index++) {
    if (!children.has(index)) launchWorker(index);
  }
}

export function stopWorkers() {
  stopping = true;

  for (const child of children.values()) child.kill('SIGTERM');
}
