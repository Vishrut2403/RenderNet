import fs from 'fs';
import { announceChanged } from './bus.js';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { DB_FILE, BACKUPS_DIR, DB_BACKUPS_KEPT } from './paths.js';

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    filePath TEXT,
    outputPath TEXT,
    outputFolder TEXT,
    frameStart INTEGER,
    frameEnd INTEGER,
    renderEngine TEXT,
    originalFilename TEXT,
    owner TEXT,
    createdAt TEXT,
    startedAt TEXT,
    completedAt TEXT,
    cancelledAt TEXT,
    error TEXT,
    totalFrames INTEGER,
    currentFrame INTEGER,
    progress INTEGER,
    completedFrames INTEGER,
    failedFrames INTEGER,
    interruptions INTEGER DEFAULT 0,
    uploadedFrames TEXT,
    frameErrors TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    passwordHash TEXT NOT NULL,
    hashAlgo TEXT NOT NULL DEFAULT 'bcrypt',
    role TEXT NOT NULL DEFAULT 'user',
    createdAt TEXT,
    passwordChangedAt TEXT,
    passwordResetAt TEXT
  );

  CREATE TABLE IF NOT EXISTS worker_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    createdAt TEXT,
    createdBy TEXT,
    lastSeen TEXT,
    revokedAt TEXT,
    isLocal INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS frames (
    jobId INTEGER NOT NULL,
    frame INTEGER NOT NULL,
    status TEXT NOT NULL,
    filename TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT,
    PRIMARY KEY (jobId, frame)
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner);
  CREATE INDEX IF NOT EXISTS idx_frames_job_status ON frames(jobId, status);
`);

function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();

  if (existing.some(info => info.name === column)) return false;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);

  return true;
}

addColumnIfMissing('jobs', 'framesAtResume', 'INTEGER DEFAULT 0');
addColumnIfMissing('jobs', 'frameStep', 'INTEGER DEFAULT 1');

addColumnIfMissing('users', 'mustChangePassword', 'INTEGER DEFAULT 0');

addColumnIfMissing('jobs', 'priority', 'INTEGER DEFAULT 0');
addColumnIfMissing('jobs', 'pausedBy', 'TEXT');

addColumnIfMissing('jobs', 'pinnedAt', 'TEXT');
addColumnIfMissing('jobs', 'heldBy', 'TEXT');

addColumnIfMissing('jobs', 'resolutionPercent', 'INTEGER DEFAULT 100');
addColumnIfMissing('jobs', 'samples', 'INTEGER');

addColumnIfMissing('jobs', 'formats', "TEXT DEFAULT 'PNG'");

addColumnIfMissing('jobs', 'exrCodec', "TEXT DEFAULT 'ZIP'");
addColumnIfMissing('jobs', 'exrDepth', "TEXT DEFAULT '16'");
addColumnIfMissing('jobs', 'jpegQuality', 'INTEGER DEFAULT 90');

addColumnIfMissing('jobs', 'video', 'TEXT');

addColumnIfMissing('jobs', 'testFrame', 'INTEGER');
addColumnIfMissing('jobs', 'allowScripts', 'INTEGER');
addColumnIfMissing('jobs', 'approval', 'TEXT');

addColumnIfMissing('jobs', 'tiles', 'INTEGER');
addColumnIfMissing('jobs', 'composite', 'TEXT');

addColumnIfMissing('jobs', 'bake', 'TEXT');
addColumnIfMissing('jobs', 'bakedPath', 'TEXT');
addColumnIfMissing('jobs', 'unbakedSims', 'TEXT');

addColumnIfMissing('jobs', 'assetCheck', 'TEXT');
addColumnIfMissing('jobs', 'missingAssets', 'TEXT');
addColumnIfMissing('jobs', 'needsThisMachine', 'INTEGER DEFAULT 0');

addColumnIfMissing('frames', 'startedAt', 'TEXT');
addColumnIfMissing('frames', 'durationMs', 'INTEGER');
addColumnIfMissing('frames', 'leaseId', 'TEXT');
addColumnIfMissing('frames', 'leasedBy', 'TEXT');
addColumnIfMissing('frames', 'leaseExpiresAt', 'TEXT');
addColumnIfMissing('frames', 'renderedBy', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_frames_lease ON frames(leaseId)');

if (addColumnIfMissing('frames', 'ordinal', 'INTEGER')) {
  db.exec('UPDATE frames SET ordinal = frame');
}

db.exec(
  `CREATE INDEX IF NOT EXISTS idx_frames_duration ON frames(jobId, durationMs)
   WHERE durationMs IS NOT NULL`
);

const COLUMNS = [
  'id', 'status', 'filePath', 'outputPath', 'outputFolder', 'frameStart', 'frameEnd', 'frameStep',
  'renderEngine', 'originalFilename', 'owner', 'createdAt', 'startedAt', 'completedAt',
  'cancelledAt', 'error', 'totalFrames', 'currentFrame', 'progress', 'completedFrames',
  'failedFrames', 'interruptions', 'framesAtResume', 'priority', 'pausedBy',
  'pinnedAt', 'heldBy',
  'resolutionPercent', 'samples', 'formats', 'exrCodec', 'exrDepth', 'jpegQuality',
  'assetCheck', 'missingAssets', 'needsThisMachine',
  'video', 'testFrame', 'allowScripts', 'approval', 'tiles', 'composite',
  'bake', 'bakedPath', 'unbakedSims'
];

const upsertJob = db.prepare(`
  INSERT OR REPLACE INTO jobs (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(c => '@' + c).join(', ')})
`);

export function saveJob(job) {
  const row = {};

  for (const column of COLUMNS) {
    row[column] = job[column] === undefined ? null : job[column];
  }

  upsertJob.run(row);
  announceChanged();
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

export function readSetting(name) {
  return db.prepare('SELECT value FROM settings WHERE name = ?').get(name)?.value ?? null;
}

export function writeSetting(name, value) {
  db.prepare(
    `INSERT INTO settings (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`
  ).run(name, value);
}

db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id DESC)');

const pages = new Map();

function pageQuery(byOwner, byStatus, byBefore) {
  const key = `${byOwner}${byStatus}${byBefore}`;

  if (!pages.has(key)) {
    const where = ['1 = 1'];

    if (byOwner) where.push('owner = @owner');
    if (byStatus) where.push('status = @status');
    if (byBefore) where.push('id < @before');

    pages.set(key, db.prepare(
      `SELECT id FROM jobs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT @limit`
    ));
  }

  return pages.get(key);
}

export function pageOfJobIds({ owner = null, status = null, before = null, limit }) {
  return pageQuery(owner !== null, status !== null, before !== null)
    .all({ owner, status, before, limit: limit + 1 })
    .map(row => row.id);
}

export function renderingJobIds(owner = null) {
  const rows = owner === null
    ? db.prepare("SELECT id FROM jobs WHERE status = 'rendering' ORDER BY id DESC").all()
    : db.prepare("SELECT id FROM jobs WHERE status = 'rendering' AND owner = ? ORDER BY id DESC")
      .all(owner);

  return rows.map(row => row.id);
}

export function countJobsByStatus(owner = null) {
  const rows = owner === null
    ? db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
    : db.prepare('SELECT status, COUNT(*) AS n FROM jobs WHERE owner = ? GROUP BY status')
      .all(owner);

  const counts = { all: 0 };

  for (const row of rows) {
    counts[row.status] = row.n;
    counts.all += row.n;
  }

  return counts;
}

const TOTALS = `SELECT
    COALESCE(SUM(completedFrames), 0) AS framesRendered,
    COALESCE(SUM(CASE
      WHEN status = 'completed' AND startedAt IS NOT NULL AND completedAt IS NOT NULL
      THEN (julianday(completedAt) - julianday(startedAt)) * 86400000
      ELSE 0 END), 0) AS renderMs
  FROM jobs`;

export function jobTotals(owner = null) {
  const row = owner === null
    ? db.prepare(TOTALS).get()
    : db.prepare(`${TOTALS} WHERE owner = ?`).get(owner);

  return { framesRendered: row.framesRendered, renderMs: Math.round(row.renderMs) };
}

export function loadJobs() {
  return db.prepare(`SELECT ${COLUMNS.join(', ')} FROM jobs`).all();
}

export function deleteJob(id) {
  db.prepare('DELETE FROM composites WHERE jobId = ?').run(id);
  db.prepare('DELETE FROM bakes WHERE jobId = ?').run(id);
  db.prepare('DELETE FROM frames WHERE jobId = ?').run(id);
  deleteJobAssets(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

const insertFrame = db.prepare(
  `INSERT OR IGNORE INTO frames (jobId, frame, status, filename, error, attempts, ordinal, updatedAt)
   VALUES (@jobId, @frame, @status, @filename, @error, @attempts, @ordinal, @updatedAt)`
);

function spreadOrder(count) {
  if (process.env.FRAME_ORDER === 'sequential' || count < 2) return index => index;

  const bits = 32 - Math.clz32(count - 1);

  return (index) => {
    let key = 0;

    for (let bit = 0; bit < bits; bit++) key = (key << 1) | ((index >> bit) & 1);

    return key;
  };
}

export const createFrames = db.transaction((jobId, frameStart, frameEnd, step = 1) => {
  const updatedAt = new Date().toISOString();
  const stride = Math.max(1, step);
  const keyOf = spreadOrder(Math.floor((frameEnd - frameStart) / stride) + 1);
  let index = 0;

  for (let frame = frameStart; frame <= frameEnd; frame += stride) {
    insertFrame.run({
      jobId, frame, status: 'pending', filename: null, error: null, attempts: 0,
      ordinal: keyOf(index++), updatedAt
    });
  }
});

export function holdFramesExcept(jobId, frame) {
  return db.prepare(
    `UPDATE frames SET status = 'held' WHERE jobId = ? AND frame != ? AND status = 'pending'`
  ).run(jobId, frame).changes;
}

export function releaseHeldFrames(jobId) {
  return db.prepare(
    `UPDATE frames SET status = 'pending' WHERE jobId = ? AND status = 'held'`
  ).run(jobId).changes;
}

export function getFrames(jobId) {
  return db.prepare('SELECT * FROM frames WHERE jobId = ? ORDER BY frame').all(jobId);
}

export function getLatestDoneFrame(jobId) {
  return db.prepare(
    `SELECT frame, filename FROM frames
     WHERE jobId = ? AND status = 'done' AND filename IS NOT NULL
     ORDER BY updatedAt DESC, frame DESC LIMIT 1`
  ).get(jobId);
}

export function resetFailedFrames(jobId) {
  return db.prepare(
    `UPDATE frames SET status = 'pending', error = NULL, attempts = 0, updatedAt = ?
     WHERE jobId = ? AND status = 'failed'`
  ).run(new Date().toISOString(), jobId).changes;
}

export function recentFrameDurations(limit = 200) {
  return db.prepare(
    `SELECT durationMs FROM frames WHERE durationMs IS NOT NULL
     ORDER BY updatedAt DESC LIMIT ?`
  ).all(limit).map(row => row.durationMs);
}

export function jobDurationsBy(jobId, workerId, limit = 50) {
  return db.prepare(
    `SELECT durationMs FROM frames
      WHERE jobId = ? AND renderedBy = ? AND durationMs IS NOT NULL
      ORDER BY updatedAt DESC LIMIT ?`
  ).all(jobId, workerId, limit).map(row => row.durationMs);
}

export function frameDurationsFor(jobId) {
  return db.prepare(
    `SELECT frame, durationMs FROM frames
      WHERE jobId = ? AND durationMs IS NOT NULL
      ORDER BY durationMs, frame`
  ).all(jobId);
}

export function countFramesByStatus(jobId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM frames WHERE jobId = ? GROUP BY status')
    .all(jobId);

  const counts = { pending: 0, done: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.n;

  return counts;
}

function renderingBegan(leaseId, claimedAt) {
  if (!leaseId) return claimedAt;

  const previous = db.prepare(
    `SELECT MAX(updatedAt) AS at FROM frames
      WHERE leaseId = ? AND status = 'done' AND durationMs IS NOT NULL`
  ).get(leaseId)?.at;

  return previous && previous > claimedAt ? previous : claimedAt;
}

export function markFrameDone(jobId, frame, filename) {
  const finished = new Date();
  const claimed = db
    .prepare('SELECT startedAt, leaseId, leasedBy FROM frames WHERE jobId = ? AND frame = ?')
    .get(jobId, frame);

  const startedAt = claimed?.startedAt
    ? renderingBegan(claimed.leaseId, claimed.startedAt)
    : null;

  const durationMs = startedAt ? finished - new Date(startedAt) : null;

  return db.prepare(
    `UPDATE frames SET status = 'done', filename = ?, error = NULL, updatedAt = ?,
       durationMs = ?, renderedBy = ?
     WHERE jobId = ? AND frame = ?`
  ).run(filename, finished.toISOString(), durationMs, claimed?.leasedBy ?? null, jobId, frame)
    .changes;
}

export function markFrameAttemptFailed(jobId, frame, error, maxAttempts) {
  db.prepare(
    `UPDATE frames
     SET attempts = attempts + 1,
         error = @error,
         status = CASE WHEN attempts + 1 >= @maxAttempts THEN 'failed' ELSE 'pending' END,
         updatedAt = @updatedAt,
         leaseId = NULL, leasedBy = NULL, leaseExpiresAt = NULL
     WHERE jobId = @jobId AND frame = @frame`
  ).run({ jobId, frame, error, maxAttempts, updatedAt: new Date().toISOString() });

  return db.prepare('SELECT * FROM frames WHERE jobId = ? AND frame = ?').get(jobId, frame);
}

export function markFramePending(jobId, frame) {
  db.prepare(
    `UPDATE frames SET status = 'pending', filename = NULL, updatedAt = ?,
       leaseId = NULL, leasedBy = NULL, leaseExpiresAt = NULL
     WHERE jobId = ? AND frame = ?`
  ).run(new Date().toISOString(), jobId, frame);
}

// Compared as text: every value is a same-length UTC ISO string.
const claimable = db.prepare(
  `SELECT frame FROM frames
    WHERE jobId = ? AND status = 'pending'
      AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
    ORDER BY ordinal, frame LIMIT ?`
);

const claim = db.prepare(
  `UPDATE frames SET leaseId = @leaseId, leasedBy = @leasedBy, leaseExpiresAt = @expiresAt,
      startedAt = @now, durationMs = NULL
    WHERE jobId = @jobId AND frame = @frame AND status = 'pending'
      AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= @now)`
);

function stamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// The UPDATE repeats the SELECT's conditions, so two workers can never share a frame.
export const leaseFrames = db.transaction((jobId, workerId, ttlMs, wanted) => {
  const now = stamp();
  const rows = claimable.all(jobId, now, Math.max(1, wanted));

  if (rows.length === 0) return null;

  const leaseId = crypto.randomUUID();
  const expiresAt = stamp(ttlMs);
  const frames = [];

  for (const row of rows) {
    const taken = claim.run({
      leaseId, leasedBy: workerId, expiresAt, jobId, frame: row.frame, now
    }).changes === 1;

    if (taken) frames.push(row.frame);
  }

  frames.sort((a, b) => a - b);

  return frames.length > 0 ? { leaseId, leasedBy: workerId, expiresAt, jobId, frames } : null;
});

export function renewLease(leaseId, ttlMs) {
  const expiresAt = stamp(ttlMs);

  const renewed = db.prepare(
    'UPDATE frames SET leaseExpiresAt = ? WHERE leaseId = ? AND leaseExpiresAt > ?'
  ).run(expiresAt, leaseId, stamp()).changes > 0;

  return renewed ? expiresAt : null;
}

export function releaseLease(leaseId) {
  return db.prepare(
    `UPDATE frames SET leaseId = NULL, leasedBy = NULL, leaseExpiresAt = NULL
     WHERE leaseId = ?`
  ).run(leaseId).changes > 0;
}

export function releaseLeasesOf(workerId) {
  const held = db.prepare(
    'SELECT DISTINCT jobId FROM frames WHERE leasedBy = ? AND leaseId IS NOT NULL'
  ).all(workerId).map(row => row.jobId);

  db.prepare(
    `UPDATE frames SET leaseId = NULL, leasedBy = NULL, leaseExpiresAt = NULL
     WHERE leasedBy = ?`
  ).run(workerId);

  return held;
}

export function clearJobLeases(jobId) {
  return db.prepare(
    `UPDATE frames SET leaseId = NULL, leasedBy = NULL, leaseExpiresAt = NULL
     WHERE jobId = ? AND leaseId IS NOT NULL`
  ).run(jobId).changes;
}

export function getLease(leaseId) {
  const rows = db.prepare(
    `SELECT jobId, frame, leasedBy, leaseExpiresAt AS expiresAt
     FROM frames WHERE leaseId = ? ORDER BY frame`
  ).all(leaseId);

  if (rows.length === 0) return null;

  return {
    jobId: rows[0].jobId,
    leasedBy: rows[0].leasedBy,
    expiresAt: rows[0].expiresAt,
    frames: rows.map(row => row.frame)
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS job_assets (
    jobId INTEGER NOT NULL,
    storedPath TEXT NOT NULL,
    filename TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT,
    PRIMARY KEY (jobId, storedPath)
  )
`);

export function recordJobAsset({ jobId, storedPath, filename, bytes }) {
  db.prepare(
    `INSERT INTO job_assets (jobId, storedPath, filename, bytes, updatedAt)
     VALUES (@jobId, @storedPath, @filename, @bytes, @updatedAt)
     ON CONFLICT(jobId, storedPath) DO UPDATE SET
       filename = excluded.filename, bytes = excluded.bytes, updatedAt = excluded.updatedAt`
  ).run({ jobId, storedPath, filename, bytes, updatedAt: new Date().toISOString() });
}

export function jobAssets(jobId) {
  return db.prepare(
    'SELECT storedPath, filename, bytes FROM job_assets WHERE jobId = ? ORDER BY storedPath'
  ).all(jobId);
}

export function deleteJobAssets(jobId) {
  return db.prepare('DELETE FROM job_assets WHERE jobId = ?').run(jobId).changes;
}

function jobClaims(table) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      jobId INTEGER PRIMARY KEY,
      leaseId TEXT,
      leasedBy TEXT,
      leaseExpiresAt TEXT
    )
  `);

  const get = leaseId => {
    const row = db.prepare(
      `SELECT jobId, leasedBy, leaseExpiresAt AS expiresAt FROM ${table} WHERE leaseId = ?`
    ).get(leaseId);

    return row ? { ...row, leaseId } : null;
  };

  return {
    get,

    take: db.transaction((jobId, workerId, ttlMs) => {
      const now = stamp();
      const expiresAt = stamp(ttlMs);

      const taken = db.prepare(
        `INSERT INTO ${table} (jobId, leaseId, leasedBy, leaseExpiresAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(jobId) DO UPDATE SET leaseId = excluded.leaseId,
           leasedBy = excluded.leasedBy, leaseExpiresAt = excluded.leaseExpiresAt
         WHERE ${table}.leaseExpiresAt IS NULL OR ${table}.leaseExpiresAt <= ?`
      ).run(jobId, crypto.randomUUID(), workerId, expiresAt, now).changes === 1;

      return taken ? get(db.prepare(
        `SELECT leaseId FROM ${table} WHERE jobId = ?`).get(jobId).leaseId) : null;
    }),

    renew(leaseId, ttlMs) {
      const expiresAt = stamp(ttlMs);

      const renewed = db.prepare(
        `UPDATE ${table} SET leaseExpiresAt = ? WHERE leaseId = ? AND leaseExpiresAt > ?`
      ).run(expiresAt, leaseId, stamp()).changes > 0;

      return renewed ? expiresAt : null;
    },

    release(leaseId) {
      return db.prepare(`DELETE FROM ${table} WHERE leaseId = ?`).run(leaseId).changes > 0;
    },

    clear(jobId) {
      return db.prepare(`DELETE FROM ${table} WHERE jobId = ?`).run(jobId).changes;
    },

    live() {
      return db.prepare(
        `SELECT jobId, leasedBy, leaseExpiresAt AS expiresAt FROM ${table} WHERE leaseExpiresAt > ?`
      ).all(stamp());
    },

    releaseOf(workerId) {
      const held = db.prepare(`SELECT jobId FROM ${table} WHERE leasedBy = ?`)
        .all(workerId).map(row => row.jobId);

      db.prepare(`DELETE FROM ${table} WHERE leasedBy = ?`).run(workerId);

      return held;
    }
  };
}

const composites = jobClaims('composites');
const bakes = jobClaims('bakes');

export const leaseComposite = composites.take;
export const getCompositeLease = composites.get;
export const renewComposite = composites.renew;
export const releaseComposite = composites.release;
export const clearJobComposite = composites.clear;
export const liveComposites = composites.live;
export const releaseCompositesOf = composites.releaseOf;

export const leaseBake = bakes.take;
export const getBakeLease = bakes.get;
export const renewBake = bakes.renew;
export const releaseBake = bakes.release;
export const clearJobBake = bakes.clear;
export const liveBakes = bakes.live;
export const releaseBakesOf = bakes.releaseOf;

export function liveLeases() {
  return db.prepare(
    `SELECT jobId, frame, leasedBy, leaseExpiresAt AS expiresAt
     FROM frames WHERE leaseExpiresAt > ? ORDER BY jobId, frame`
  ).all(stamp());
}

export function insertWorkerToken(row) {
  db.prepare(
    `INSERT INTO worker_tokens (id, name, tokenHash, createdAt, createdBy, isLocal)
     VALUES (@id, @name, @tokenHash, @createdAt, @createdBy, @isLocal)`
  ).run(row);
}

export function workerTokenHashTaken(tokenHash) {
  return !!db.prepare('SELECT 1 FROM worker_tokens WHERE tokenHash = ?').get(tokenHash);
}

export function workerTokenByHash(tokenHash) {
  return db.prepare(
    'SELECT * FROM worker_tokens WHERE tokenHash = ? AND revokedAt IS NULL'
  ).get(tokenHash) ?? null;
}

export function listWorkerTokens() {
  return db.prepare(
    `SELECT id, name, createdAt, createdBy, lastSeen, revokedAt, isLocal
     FROM worker_tokens ORDER BY createdAt DESC`
  ).all();
}

export function getWorkerToken(id) {
  return db.prepare('SELECT * FROM worker_tokens WHERE id = ?').get(id) ?? null;
}

export function revokeWorkerToken(id) {
  return db.prepare(
    'UPDATE worker_tokens SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL'
  ).run(new Date().toISOString(), id).changes === 1;
}

export function touchWorkerToken(id) {
  db.prepare('UPDATE worker_tokens SET lastSeen = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function deleteLocalWorkerTokens() {
  return db.prepare('DELETE FROM worker_tokens WHERE isLocal = 1').run().changes;
}

export function getFailedFrames(jobId) {
  return db.prepare(
    `SELECT frame, error, updatedAt FROM frames
     WHERE jobId = ? AND status = 'failed' ORDER BY frame`
  ).all(jobId);
}

export function getFailedFramesIn(jobIds) {
  if (jobIds.length === 0) return [];

  return db.prepare(
    `SELECT jobId, frame, error, updatedAt FROM frames
     WHERE status = 'failed' AND jobId IN (${jobIds.map(() => '?').join(',')})
     ORDER BY jobId, frame`
  ).all(...jobIds);
}

const backfillFrames = db.transaction(() => {
  const stale = db.prepare(`
    SELECT id, frameStart, frameEnd, uploadedFrames, frameErrors FROM jobs
    WHERE NOT EXISTS (SELECT 1 FROM frames WHERE frames.jobId = jobs.id)
  `).all();

  for (const job of stale) {
    if (!Number.isInteger(job.frameStart) || !Number.isInteger(job.frameEnd)) continue;

    createFrames(job.id, job.frameStart, job.frameEnd, job.frameStep ?? 1);

    for (const filename of JSON.parse(job.uploadedFrames || '[]')) {
      const frame = Number(String(filename).match(/(\d+)/)?.[1]);
      if (Number.isInteger(frame)) markFrameDone(job.id, frame, filename);
    }

    for (const entry of JSON.parse(job.frameErrors || '[]')) {
      db.prepare(
        `UPDATE frames SET status = 'failed', error = ?, attempts = 1, updatedAt = ?
         WHERE jobId = ? AND frame = ?`
      ).run(entry.error ?? 'Unknown error', entry.at ?? null, job.id, entry.frame);
    }
  }

  return stale.length;
});

if (db.prepare(`PRAGMA table_info(jobs)`).all().some(c => c.name === 'uploadedFrames')) {
  const migrated = backfillFrames();
  if (migrated) console.log(`Backfilled per-frame records for ${migrated} existing job(s).`);
}

const insertSession = db.prepare(
  'INSERT OR REPLACE INTO sessions (token, username, role, expiresAt) VALUES (?, ?, ?, ?)'
);

export function saveSession(token, session) {
  insertSession.run(token, session.username, session.role, session.expiresAt);
}

export function loadSessions() {
  return db.prepare('SELECT * FROM sessions WHERE expiresAt > ?').all(Date.now());
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteSessionsFor(username, except = null) {
  return db.prepare('DELETE FROM sessions WHERE username = ? AND token IS NOT ?')
    .run(username, except).changes;
}

export function purgeExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now()).changes;
}

const upsertUser = db.prepare(`
  INSERT OR REPLACE INTO users
    (username, passwordHash, hashAlgo, role, createdAt, passwordChangedAt,
     passwordResetAt, mustChangePassword)
  VALUES
    (@username, @passwordHash, @hashAlgo, @role, @createdAt, @passwordChangedAt,
     @passwordResetAt, @mustChangePassword)
`);

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users
    (username, passwordHash, hashAlgo, role, createdAt, mustChangePassword)
  VALUES (@username, @passwordHash, @hashAlgo, @role, @createdAt, 0)
`);

export function createUser(user) {
  return insertUser.run(user).changes === 1;
}

export function saveUser(user) {
  upsertUser.run({
    username: user.username,
    passwordHash: user.passwordHash,
    hashAlgo: user.hashAlgo || 'bcrypt',
    role: user.role || 'user',
    createdAt: user.createdAt ?? null,
    passwordChangedAt: user.passwordChangedAt ?? null,
    passwordResetAt: user.passwordResetAt ?? null,
    mustChangePassword: user.mustChangePassword ? 1 : 0
  });
}

export function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY createdAt').all();
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export default db;

export function backupDatabase(now = new Date()) {
  if (DB_BACKUPS_KEPT < 1) return null;

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUPS_DIR, `rendernet-${stamp}.db`);

  try {
    if (fs.existsSync(target)) fs.rmSync(target);

    // Not a file copy: a WAL database can be caught mid-write.
    db.prepare('VACUUM INTO ?').run(target);
    pruneBackups();

    return target;
  } catch (error) {
    console.error('Database backup failed:', error.message);
    return null;
  }
}

function pruneBackups() {
  const kept = fs.readdirSync(BACKUPS_DIR)
    .filter(name => /^rendernet-.+\.db$/.test(name))
    .sort()
    .reverse();

  for (const name of kept.slice(DB_BACKUPS_KEPT)) {
    try {
      fs.rmSync(path.join(BACKUPS_DIR, name));
    } catch {
    }
  }
}
