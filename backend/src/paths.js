import path from 'path';
import { fileURLToPath } from 'url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : BACKEND_ROOT;

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

export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 14;
export const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_BYTES) || 10 * 1024 * 1024 * 1024;

export const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES) || 5 * 1024 * 1024 * 1024;

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024;
export const MAX_CHUNK_BYTES = Number(process.env.MAX_CHUNK_BYTES) || 16 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = Math.min(
  Number(process.env.UPLOAD_CHUNK_BYTES) || 8 * 1024 * 1024,
  MAX_CHUNK_BYTES
);

export const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES) || 512 * 1024 * 1024;

export const PARTIAL_TTL_MS = Number(process.env.PARTIAL_TTL_MS) || 6 * 60 * 60 * 1000;

export const BACKUPS_DIR = dataPath('backups');

export const DB_BACKUPS_KEPT = Number(process.env.DB_BACKUPS_KEPT) || 7;

export const LOGS_DIR = dataPath('logs');

export const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 30;
export const MAX_LOG_BYTES = Math.max(Number(process.env.MAX_LOG_BYTES) || 8 * 1024 * 1024, 100);

export const FRONTEND_DIST = path.resolve(BACKEND_ROOT, '..', 'frontend', 'dist');
