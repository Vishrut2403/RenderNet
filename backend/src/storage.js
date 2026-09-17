import fs from 'fs';
import path from 'path';
import { freeBytes } from './utils/file-utils.js';
import { dataPath, DATA_DIR, USER_QUOTA_BYTES, MIN_FREE_BYTES } from './paths.js';
import { jobs, workerScratchDir } from './job-store.js';
import { removeBlend, blendDirectory } from './blend-store.js';

const DISK_RECHECK_MS = 60 * 1000;
const USAGE_TTL_MS = 10000;

const FREE_TTL_MS = 5000;

let held = null;
let recheckTimer = null;
let freeSpace = { at: 0, bytes: null };

export function heldForDisk() {
  return held;
}

function freeNow(fresh = false) {
  if (!fresh && Date.now() - freeSpace.at < FREE_TTL_MS) return freeSpace.bytes;

  freeSpace = { at: Date.now(), bytes: freeBytes(DATA_DIR) };

  return freeSpace.bytes;
}

export function tooFullToCarryOn() {
  const free = freeNow();

  return free !== null && free < MIN_FREE_BYTES;
}

export function diskIsTooFull(onRecheck) {
  const free = freeNow(true);

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

function stillWanted(filePath, exceptJobId = null) {
  for (const job of jobs.values()) {
    if (job.id === exceptJobId || job.status === 'cancelled') continue;
    if (job.filePath === filePath) return true;
  }

  return false;
}

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
  }

  return total;
}

const usageCache = new Map();

export function usageFor(username, { fresh = false } = {}) {
  const cached = usageCache.get(username);

  if (!fresh && cached && Date.now() - cached.at < USAGE_TTL_MS) {
    return cached.value;
  }

  let bytes = 0;
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

export function forgetUsage(username) {
  usageCache.delete(username);
}

export function usageByOwner() {
  const owners = new Set(Array.from(jobs.values(), job => job.owner));
  return Object.fromEntries(Array.from(owners, owner => [owner, usageFor(owner)]));
}

export function getActiveJobPaths() {
  const inUse = new Set();

  for (const job of jobs.values()) {
    if (job.status !== 'pending' && job.status !== 'rendering') continue;

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
