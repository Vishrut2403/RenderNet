import './env.js';
import RenderWorker from './render-worker.js';

const IDLE_MS = Number(process.env.WORKER_IDLE_MS) || 2000;
const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
const worker = new RenderWorker(workerId);

let running = true;

const alone = !process.send;

function shutDown(signal) {
  if (!running) return;

  if (alone) console.log(`Worker ${workerId}: ${signal}, letting go of the frame in hand`);
  running = false;
  worker.stop();
}

process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

if (!alone) {
  process.on('disconnect', () => shutDown('the server that started it has gone'));
}

if (alone) {
  console.log(`Worker ${workerId} started against ${process.env.API_URL || 'http://localhost:5500'}`);
}

while (running) {
  const busy = await worker.claimAndRender();

  if (!busy && running) {
    await new Promise(resolve => setTimeout(resolve, IDLE_MS));
  }
}

if (alone) console.log(`Worker ${workerId} stopped`);
