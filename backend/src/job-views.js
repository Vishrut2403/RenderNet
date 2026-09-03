import { getFailedFrames, getFailedFramesIn } from './db.js';
import { jobs } from './job-store.js';
import { frameTimings } from './estimates.js';
import { queueWaits } from './queue.js';

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;

const RECENT_SHOWN = 3;

// What a job looks like to the API: the record, plus the things that are only
// known by asking somewhere else.
function parseMissing(stored) {
  if (!stored) return null;

  try {
    return JSON.parse(stored).map(file => file.split(/[\\/]/).pop());
  } catch {
    return null;
  }
}

function asFrameError(row) {
  return { frame: row.frame, error: row.error, at: row.updatedAt };
}

function groupErrors(rows) {
  const byJob = new Map();

  for (const row of rows) {
    if (!byJob.has(row.jobId)) byJob.set(row.jobId, []);
    byJob.get(row.jobId).push(asFrameError(row));
  }

  return byJob;
}

function enrich(page, errorsByJob) {
  const waits = queueWaits();
  const timings = frameTimings(page.map(job => job.id));

  return page.map(job => ({
    ...job,
    missingAssets: parseMissing(job.missingAssets),
    timing: timings.get(job.id) ?? null,
    frameErrors: errorsByJob.get(job.id) ?? [],
    startsIn: waits.get(job.id) ?? null
  }));
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  return {
    ...job,
    missingAssets: parseMissing(job.missingAssets),
    frameErrors: getFailedFrames(jobId).map(asFrameError),
    timing: frameTimings([jobId]).get(jobId) ?? null,
    startsIn: queueWaits().get(jobId) ?? null
  };
}

function newestFirst(viewer) {
  const visible = [];

  for (const job of jobs.values()) {
    if (!viewer || viewer.role === 'admin' || job.owner === viewer.username) visible.push(job);
  }

  return visible.sort((a, b) => b.id - a.id);
}

function tally(visible) {
  const counts = { all: visible.length };

  for (const job of visible) counts[job.status] = (counts[job.status] || 0) + 1;

  return counts;
}

export function listJobs({ viewer, status = null, before = null, limit = DEFAULT_PAGE }) {
  const visible = newestFirst(viewer);

  const matching = visible.filter(job =>
    (status === null || job.status === status) && (before === null || job.id < before));

  const page = matching.slice(0, limit);
  const last = page[page.length - 1];

  return {
    counts: tally(visible),
    jobs: enrich(page, groupErrors(getFailedFramesIn(page.map(job => job.id)))),
    nextBefore: last && matching.length > page.length ? last.id : null
  };
}

// Every render in flight, the newest few, and totals over the lot: what no
// single page can answer.
export function jobsSummary(viewer) {
  const visible = newestFirst(viewer);

  const rendering = visible.filter(job => job.status === 'rendering');
  const recent = visible.slice(0, RECENT_SHOWN);

  const shown = [...new Map([...rendering, ...recent].map(job => [job.id, job])).values()];
  const errors = groupErrors(getFailedFramesIn(shown.map(job => job.id)));
  const byId = new Map(enrich(shown, errors).map(job => [job.id, job]));

  let framesRendered = 0;
  let renderMs = 0;

  for (const job of visible) {
    framesRendered += job.completedFrames || 0;

    if (job.status === 'completed' && job.startedAt && job.completedAt) {
      renderMs += new Date(job.completedAt) - new Date(job.startedAt);
    }
  }

  return {
    counts: tally(visible),
    framesRendered,
    renderMs,
    rendering: rendering.map(job => byId.get(job.id)),
    recent: recent.map(job => byId.get(job.id))
  };
}
