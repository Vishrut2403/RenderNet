import { typicalFrameMs, frameTimings } from './estimates.js';

// Whose turn it is, when several people are waiting for the same machine.
//
// Start-time fair queueing: every owner has a clock measured in farm
// milliseconds, and a job entering the queue is stamped with where its owner's
// clock reaches once that job has rendered. The queue runs in stamp order, so
// somebody who has already asked for an hour of the farm waits behind somebody
// who has asked for a minute — however many jobs each of them submitted. An
// owner who has been away is pulled up to the present rather than starting from
// a clock left behind days ago.
//
// This is about contention only: once nothing is queued or rendering the clocks
// are cleared, so a quiet farm treats everybody as equal again rather than
// billing them for last week.

// What a frame is assumed to cost before this farm has measured one.
const ASSUMED_FRAME_MS = 10 * 1000;

const clocks = new Map();
const stamps = new Map();

let virtualNow = 0;

function framesLeft(job) {
  // Never zero: a job with nothing left to do still has to be ordered against
  // the others, and a free job would sort in front of everything forever.
  return Math.max(1, (job.totalFrames ?? 1) - (job.completedFrames ?? 0));
}

// This job's own measured frames if it has any, the farm's if not: a job that
// has already rendered half its range is charged at the rate it actually runs
// at rather than at everybody else's.
function costMs(job) {
  const measured = frameTimings([job.id]).get(job.id);
  const perFrame = measured?.medianMs ?? typicalFrameMs() ?? ASSUMED_FRAME_MS;

  return framesLeft(job) * perFrame;
}

// Charged when the job joins the queue, and again if it goes back — for what is
// left of it, so a job pushed aside halfway is not paid for twice.
export function stampJob(job) {
  const owner = job.owner ?? '';
  const start = Math.max(clocks.get(owner) ?? 0, virtualNow);
  const finish = start + costMs(job);

  clocks.set(owner, finish);
  stamps.set(job.id, { start, finish });
}

// The farm has reached this job's turn, so everybody idle until now catches up
// to here rather than to where the queue ends.
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

// Called when nothing is queued or rendering.
export function levelUp() {
  clocks.clear();
  stamps.clear();
  virtualNow = 0;
}
