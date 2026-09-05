import path from 'path';
import { fileURLToPath } from 'url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything is resolved from this file's own location rather than the working
// directory. On the workstation the server is started by Task Scheduler, where
// an unset "Start in" would otherwise scatter uploads, renders and the database
// wherever the launcher happened to be - a failure nobody would notice until
// their frames could not be found.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : BACKEND_ROOT;

// Job records store paths relative to the data directory, so the whole
// directory can be moved without rewriting the database. Absolute paths are
// passed through unchanged.
export function dataPath(...segments) {
  return path.resolve(DATA_DIR, ...segments);
}

export const UPLOADS_DIR = dataPath('uploads');
export const PARTIALS_DIR = dataPath('partials');
export const RENDERS_DIR = dataPath('renders');
export const SCRATCH_DIR = dataPath('worker-tmp');
export const USERS_FILE = dataPath('users.json');

export const DB_FILE = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : dataPath('rendernet.db');

// Quota and retention are policy rather than layout, but they belong with the
// other settings the operator tunes.
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 14;
export const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_BYTES) || 10 * 1024 * 1024 * 1024;

// Quotas divide the disk between people; this is what stops the disk itself
// running out. A full disk fails every frame of every job rather than one.
export const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES) || 5 * 1024 * 1024 * 1024;

// A scene above the chunking threshold is sent in pieces and can be picked up
// where it stopped.
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024;
export const MAX_CHUNK_BYTES = Number(process.env.MAX_CHUNK_BYTES) || 16 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = Math.min(
  Number(process.env.UPLOAD_CHUNK_BYTES) || 8 * 1024 * 1024,
  MAX_CHUNK_BYTES
);

// One finished frame on its way back from a worker. A 4K OpenEXR carrying
// several passes runs well past a hundred megabytes.
export const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES) || 512 * 1024 * 1024;

// An upload nobody came back to finish is holding disk the quota does not yet
// count against it.
export const PARTIAL_TTL_MS = Number(process.env.PARTIAL_TTL_MS) || 6 * 60 * 60 * 1000;

export const BACKUPS_DIR = dataPath('backups');

// The database is the only record of who owns which frames, and it is one file
// on a machine that gets switched off by hand every night.
export const DB_BACKUPS_KEPT = Number(process.env.DB_BACKUPS_KEPT) || 7;

export const LOGS_DIR = dataPath('logs');

// Logs are small next to renders and are the only account of an evening nobody
// watched, so they outlive the frames they describe.
export const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 30;
// Floored: the rotation search walks upward until it finds a file under the
// limit, so a nonsensical value here would spin rather than misbehave visibly.
export const MAX_LOG_BYTES = Math.max(Number(process.env.MAX_LOG_BYTES) || 8 * 1024 * 1024, 100);

export const FRONTEND_DIST = path.resolve(BACKEND_ROOT, '..', 'frontend', 'dist');
