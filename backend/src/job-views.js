import {
  getFailedFrames, getFailedFramesIn, pageOfJobIds, renderingJobIds,
  countJobsByStatus, jobTotals
} from './db.js';
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

// An admin sees the lot; everybody else sees their own. Null means no filter.
function ownerFor(viewer) {
  return !viewer || viewer.role === 'admin' ? null : viewer.username;
}

// The order and the page come from the database; the records themselves come
// from memory, which is where the live state is kept.
function pageOf(owner, { status = null, before = null, limit }) {
  const ids = pageOfJobIds({ owner, status, before, limit });
  const page = ids.slice(0, limit).map(id => jobs.get(id)).filter(Boolean);

  return { page, more: ids.length > limit };
}

export function listJobs({ viewer, status = null, before = null, limit = DEFAULT_PAGE }) {
  const owner = ownerFor(viewer);
  const { page, more } = pageOf(owner, { status, before, limit });

  return {
    counts: countJobsByStatus(owner),
    jobs: enrich(page, groupErrors(getFailedFramesIn(page.map(job => job.id)))),
    nextBefore: more ? page[page.length - 1]?.id ?? null : null
  };
}

// Every render in flight, the newest few, and totals over the lot: what no
// single page can answer.
export function jobsSummary(viewer) {
  const owner = ownerFor(viewer);
  const rendering = renderingJobIds(owner).map(id => jobs.get(id)).filter(Boolean);
  const recent = pageOf(owner, { limit: RECENT_SHOWN }).page;

  const shown = [...new Map([...rendering, ...recent].map(job => [job.id, job])).values()];
  const errors = groupErrors(getFailedFramesIn(shown.map(job => job.id)));
  const byId = new Map(enrich(shown, errors).map(job => [job.id, job]));

  return {
    counts: countJobsByStatus(owner),
    ...jobTotals(owner),
    rendering: rendering.map(job => byId.get(job.id)),
    recent: recent.map(job => byId.get(job.id))
  };
}
