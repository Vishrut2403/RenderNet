// A worker as its own process: it knows the API and nothing else. Started by the
// server for this machine, or run by hand on another one.
import './env.js';
import RenderWorker from './render-worker.js';

const IDLE_MS = Number(process.env.WORKER_IDLE_MS) || 2000;
const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
const worker = new RenderWorker(workerId);

let running = true;

function shutDown(signal) {
  if (!running) return;

  console.log(`Worker ${workerId}: ${signal}, letting go of the frame in hand`);
  running = false;
  worker.stop();
}

process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

// Closes the moment the server goes, however it went.
if (process.send) {
  process.on('disconnect', () => shutDown('the server that started it has gone'));
}

console.log(`Worker ${workerId} started against ${process.env.API_URL || 'http://localhost:5500'}`);

while (running) {
  const busy = await worker.claimAndRender();

  if (!busy && running) {
    await new Promise(resolve => setTimeout(resolve, IDLE_MS));
  }
}

console.log(`Worker ${workerId} stopped`);
