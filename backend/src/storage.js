import fs from 'fs';
import path from 'path';
import { freeBytes } from './utils/file-utils.js';
import { dataPath, DATA_DIR, USER_QUOTA_BYTES, MIN_FREE_BYTES } from './paths.js';
import { jobs, workerScratchDir } from './job-store.js';
import { removeBlend, blendDirectory } from './blend-store.js';

const DISK_RECHECK_MS = 60 * 1000;
const USAGE_TTL_MS = 10000;

let held = null;
let recheckTimer = null;

export function heldForDisk() {
  return held;
}

// Held rather than failed: deleting one finished job is all it takes to free
// the space, and a job that failed for want of disk would have to be uploaded
// again to get it back.
export function diskIsTooFull(onRecheck) {
  const free = freeBytes(DATA_DIR);

  if (free === null || free >= MIN_FREE_BYTES) {
    held = null;
    return false;
  }

  held = `Only ${(free / 1024 ** 3).toFixed(1)} GB of disk left; `
    + 'renders are held until finished jobs are deleted';

  console.warn(`Queue held: ${held}`);

  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(onRecheck, DISK_RECHECK_MS);
  recheckTimer.unref?.();

  return true;
}

// One file on disk may be the scene of several jobs, so it only goes when the
// last job that could still render it does. A cancelled job never can.
function stillWanted(filePath, exceptJobId = null) {
  for (const job of jobs.values()) {
    if (job.id === exceptJobId || job.status === 'cancelled') continue;
    if (job.filePath === filePath) return true;
  }

  return false;
}

// For an upload that has arrived but whose job was then refused: nothing names
// it yet, so it goes unless it is a scene somebody else already had.
export function dropUnusedBlend(filePath) {
  if (!filePath || stillWanted(filePath)) return;

  try {
    if (fs.existsSync(dataPath(filePath))) removeBlend(filePath);
  } catch (error) {
    console.error(`Error removing upload:`, error.message);
  }
}

export function deleteJobFiles(job) {
  try {
    if (job.filePath && !stillWanted(job.filePath, job.id)
      && fs.existsSync(dataPath(job.filePath))) {
      removeBlend(job.filePath);
      console.log(`Deleted upload: ${job.filePath}`);
    }

    if (job.outputFolder && fs.existsSync(dataPath(job.outputFolder))) {
      fs.rmSync(dataPath(job.outputFolder), { recursive: true, force: true });
      console.log(`Deleted renders: ${job.outputFolder}`);
    }

    fs.rmSync(workerScratchDir(job.id), { recursive: true, force: true });
  } catch (error) {
    console.error(`Error deleting files:`, error.message);
  }
}

function sizeOf(target) {
  let total = 0;

  try {
    const stats = fs.statSync(target);
    if (!stats.isDirectory()) return stats.size;

    for (const entry of fs.readdirSync(target)) {
      total += sizeOf(path.join(target, entry));
    }
  } catch {
    // Gone between listing and measuring, which is only ever an overcount.
  }

  return total;
}

// Measured from disk rather than tracked in a counter: a counter drifts the
// moment anything is removed outside the app, and there are few enough jobs
// here that walking them costs nothing.
const usageCache = new Map();

export function usageFor(username, { fresh = false } = {}) {
  const cached = usageCache.get(username);

  if (!fresh && cached && Date.now() - cached.at < USAGE_TTL_MS) {
    return cached.value;
  }

  let bytes = 0;
  // Counted once however many of their jobs render it: it is one file on disk.
  const scenes = new Set();

  for (const job of jobs.values()) {
    if (job.owner !== username) continue;

    if (job.filePath && !scenes.has(job.filePath)) {
      scenes.add(job.filePath);
      bytes += sizeOf(dataPath(job.filePath));
    }

    if (job.outputFolder) bytes += sizeOf(dataPath(job.outputFolder));
  }

  const value = {
    bytes,
    quota: USER_QUOTA_BYTES,
    remaining: Math.max(0, USER_QUOTA_BYTES - bytes)
  };

  usageCache.set(username, { at: Date.now(), value });

  return value;
}

// Deleting, cancelling or uploading is exactly when somebody is watching the
// number, so those clear the cache rather than making them wait it out.
export function forgetUsage(username) {
  usageCache.delete(username);
}

export function usageByOwner() {
  const owners = new Set(Array.from(jobs.values(), job => job.owner));
  return Object.fromEntries(Array.from(owners, owner => [owner, usageFor(owner)]));
}

// Cleanup deletes by age alone, which would otherwise take the .blend out from
// under a job that has been sitting in the queue for longer than the cutoff.
export function getActiveJobPaths() {
  const inUse = new Set();

  for (const job of jobs.values()) {
    if (job.status !== 'pending' && job.status !== 'rendering') continue;

    // The directory as well as the file: the sweep walks uploads/ an entry at a
    // time, and a content-addressed scene is a directory there.
    if (job.filePath) {
      inUse.add(dataPath(job.filePath));

      const directory = blendDirectory(job.filePath);
      if (directory) inUse.add(directory);
    }

    if (job.outputFolder) inUse.add(dataPath(job.outputFolder));
    inUse.add(workerScratchDir(job.id));
  }

  return inUse;
}
