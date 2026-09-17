import { typicalFrameMs, frameTimings } from './estimates.js';


const ASSUMED_FRAME_MS = 10 * 1000;

const clocks = new Map();
const stamps = new Map();
const charged = new Set();

let virtualNow = 0;

function framesLeft(job) {
  return Math.max(1, (job.totalFrames ?? 1) - (job.completedFrames ?? 0));
}

function costMs(job) {
  const measured = frameTimings([job.id]).get(job.id);
  const perFrame = measured?.medianMs ?? typicalFrameMs() ?? ASSUMED_FRAME_MS;

  return framesLeft(job) * perFrame;
}

export function stampJob(job) {
  const owner = job.owner ?? '';
  const clock = clocks.get(owner) ?? 0;
  const cost = costMs(job);

  if (charged.has(job.id)) {
    const finish = Math.max(clock, virtualNow + cost);

    clocks.set(owner, finish);
    stamps.set(job.id, { start: finish - cost, finish });
    return;
  }

  const start = Math.max(clock, virtualNow);
  const finish = start + cost;

  charged.add(job.id);
  clocks.set(owner, finish);
  stamps.set(job.id, { start, finish });
}

export function startedJob(jobId) {
  const stamp = stamps.get(jobId);

  if (stamp) virtualNow = Math.max(virtualNow, stamp.start);
}

export function shareOf(jobId) {
  return stamps.get(jobId)?.finish ?? 0;
}

export function forgetJob(jobId) {
  stamps.delete(jobId);
}

export function levelUp() {
  clocks.clear();
  stamps.clear();
  charged.clear();
  virtualNow = 0;
}
