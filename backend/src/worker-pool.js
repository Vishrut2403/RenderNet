import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const WORKER_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'worker-main.js');
const RESTART_DELAY_MS = 2000;

function slots() {
  const configured = Number(process.env.WORKER_SLOTS);
  return Number.isInteger(configured) && configured >= 0 ? configured : 1;
}

const children = new Map();
let stopping = false;

// Through console rather than inherited stdio: the file logger patches console,
// and an inherited pipe would be held open after the server has gone.
function forward(stream, index, write) {
  let buffered = '';

  stream.setEncoding('utf8');

  stream.on('data', chunk => {
    buffered += chunk;

    const lines = buffered.split('\n');
    buffered = lines.pop();

    // A child writing without newlines must not grow this without limit.
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
    env: { ...process.env, WORKER_ID: `worker-${index}` },
    // Carries no messages. It closes when the server goes, which a server killed
    // outright cannot announce, and an orphan would claim frames from whatever
    // starts on that port next.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  children.set(index, child);

  forward(child.stdout, index, console.log);
  forward(child.stderr, index, console.error);

  child.on('exit', (code, signal) => {
    children.delete(index);

    if (stopping) return;

    console.warn(`Worker ${index} exited (${signal || code}), starting another`);
    setTimeout(() => launchWorker(index), RESTART_DELAY_MS).unref?.();
  });

  child.on('error', error => console.error(`Worker ${index} could not start: ${error.message}`));
}

// Called when there is work rather than at import, so a process that only reads
// the queue never starts a renderer.
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
