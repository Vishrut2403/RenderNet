import fs from 'fs';
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

  if (!existing.some(info => info.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Frames already done when the job was last resumed, so a restart that made
// progress can be told from one that made none.
addColumnIfMissing('jobs', 'framesAtResume', 'INTEGER DEFAULT 0');

// Set where somebody else has seen the password: the seeded admin, or a reset.
addColumnIfMissing('users', 'mustChangePassword', 'INTEGER DEFAULT 0');

// Higher numbers go first; pausedBy records who displaced a job.
addColumnIfMissing('jobs', 'priority', 'INTEGER DEFAULT 0');
addColumnIfMissing('jobs', 'pausedBy', 'TEXT');

// An admin's two overrides: pinnedAt puts a job in front of the whole farm,
// heldBy keeps one out of the running until the same admin lets it go.
addColumnIfMissing('jobs', 'pinnedAt', 'TEXT');
addColumnIfMissing('jobs', 'heldBy', 'TEXT');

// Applied to the scene at render time rather than by editing the .blend.
addColumnIfMissing('jobs', 'resolutionPercent', 'INTEGER DEFAULT 100');
addColumnIfMissing('jobs', 'samples', 'INTEGER');

// Comma-separated Blender format ids; the first is what the frame record and
// the preview point at.
addColumnIfMissing('jobs', 'formats', "TEXT DEFAULT 'PNG'");

// How each format is written: kept as text because Blender's depth is an enum
// of digits rather than a number.
addColumnIfMissing('jobs', 'exrCodec', "TEXT DEFAULT 'ZIP'");
addColumnIfMissing('jobs', 'exrDepth', "TEXT DEFAULT '16'");
addColumnIfMissing('jobs', 'jpegQuality', 'INTEGER DEFAULT 90');

// Whether a video has been made of the finished frames.
addColumnIfMissing('jobs', 'video', 'TEXT');

// The frame rendered on its own first, and where its owner's answer has got to:
// 'testing', 'waiting' for them, or 'approved'.
addColumnIfMissing('jobs', 'testFrame', 'INTEGER');
addColumnIfMissing('jobs', 'approval', 'TEXT');

// A still cut into regions rendered separately, and how putting them back
// together went.
addColumnIfMissing('jobs', 'tiles', 'INTEGER');
addColumnIfMissing('jobs', 'composite', 'TEXT');

// What the scene reaches for outside itself, checked before it is queued.
addColumnIfMissing('jobs', 'assetCheck', 'TEXT');
addColumnIfMissing('jobs', 'missingAssets', 'TEXT');

// One frame claimed by one worker, with an expiry: a worker that stops answering
// loses the frame rather than stranding it.
addColumnIfMissing('frames', 'startedAt', 'TEXT');
addColumnIfMissing('frames', 'durationMs', 'INTEGER');
addColumnIfMissing('frames', 'leaseId', 'TEXT');
addColumnIfMissing('frames', 'leasedBy', 'TEXT');
addColumnIfMissing('frames', 'leaseExpiresAt', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_frames_lease ON frames(leaseId)');

// Only the measured frames, which is what the timings read and a fraction of
// the table while a job is still running.
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_frames_duration ON frames(jobId, durationMs)
   WHERE durationMs IS NOT NULL`
);

const COLUMNS = [
  'id', 'status', 'filePath', 'outputPath', 'outputFolder', 'frameStart', 'frameEnd',
  'renderEngine', 'originalFilename', 'owner', 'createdAt', 'startedAt', 'completedAt',
  'cancelledAt', 'error', 'totalFrames', 'currentFrame', 'progress', 'completedFrames',
  'failedFrames', 'interruptions', 'framesAtResume', 'priority', 'pausedBy',
  'pinnedAt', 'heldBy',
  'resolutionPercent', 'samples', 'formats', 'exrCodec', 'exrDepth', 'jpegQuality',
  'assetCheck', 'missingAssets', 'video', 'testFrame', 'approval', 'tiles', 'composite'
];

const upsertJob = db.prepare(`
  INSERT OR REPLACE INTO jobs (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(c => '@' + c).join(', ')})
`);

export function saveJob(job) {
  const row = {};

  for (const column of COLUMNS) {
    // SQLite rejects undefined and booleans.
    row[column] = job[column] === undefined ? null : job[column];
  }

  upsertJob.run(row);
}

export function loadJobs() {
  return db.prepare(`SELECT ${COLUMNS.join(', ')} FROM jobs`).all();
}

export function deleteJob(id) {
  db.prepare('DELETE FROM frames WHERE jobId = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

const insertFrame = db.prepare(
  `INSERT OR IGNORE INTO frames (jobId, frame, status, filename, error, attempts, updatedAt)
   VALUES (@jobId, @frame, @status, @filename, @error, @attempts, @updatedAt)`
);

export const createFrames = db.transaction((jobId, frameStart, frameEnd) => {
  const updatedAt = new Date().toISOString();

  for (let frame = frameStart; frame <= frameEnd; frame++) {
    insertFrame.run({
      jobId, frame, status: 'pending', filename: null, error: null, attempts: 0, updatedAt
    });
  }
});

// Held rather than deleted, so the job keeps its full range and its progress
// denominator while only the test frame can be claimed.
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

// Attempts go back to zero as well: a frame that exhausted its three tries is
// being asked to try again, not being given a fourth.
export function resetFailedFrames(jobId) {
  return db.prepare(
    `UPDATE frames SET status = 'pending', error = NULL, attempts = 0, updatedAt = ?
     WHERE jobId = ? AND status = 'failed'`
  ).run(new Date().toISOString(), jobId).changes;
}

// Recent frames only: the estimate is for the machine as it is now.
export function recentFrameDurations(limit = 200) {
  return db.prepare(
    `SELECT durationMs FROM frames WHERE durationMs IS NOT NULL
     ORDER BY updatedAt DESC LIMIT ?`
  ).all(limit).map(row => row.durationMs);
}

// One job's measured frames, which is all that job's timings depend on. The
// farm-wide version of this - every duration in the database, read on every
// poll of the job list - is what this replaced.
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

// When this frame's render actually began. A claim stamps every frame of a span
// at once, but Blender works through them in order, so all but the first began
// when the one before them in the same claim finished.
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
    .prepare('SELECT startedAt, leaseId FROM frames WHERE jobId = ? AND frame = ?')
    .get(jobId, frame);

  const startedAt = claimed?.startedAt
    ? renderingBegan(claimed.leaseId, claimed.startedAt)
    : null;

  const durationMs = startedAt ? finished - new Date(startedAt) : null;

  return db.prepare(
    `UPDATE frames SET status = 'done', filename = ?, error = NULL, updatedAt = ?,
       durationMs = ?
     WHERE jobId = ? AND frame = ?`
  ).run(filename, finished.toISOString(), durationMs, jobId, frame).changes;
}

// A frame only counts as failed once it has used up its attempts; until then it
// goes back to pending so the worker can have another go.
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

const claimable = db.prepare(
  `SELECT frame FROM frames
    WHERE jobId = ? AND status = 'pending'
      AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
    ORDER BY frame LIMIT ?`
);

const claim = db.prepare(
  `UPDATE frames SET leaseId = @leaseId, leasedBy = @leasedBy, leaseExpiresAt = @expiresAt,
      startedAt = @now, durationMs = NULL
    WHERE jobId = @jobId AND frame = @frame AND status = 'pending'
      AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= @now)`
);

// Compared as text, which is only sound because every one is a UTC ISO string of
// the same length.
function stamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// One transaction, so two workers asking at once cannot get the same frame. The
// UPDATE repeats the conditions rather than trusting the SELECT, so a claim that
// lost the race changes nothing and says so - and the frames it lost simply do
// not join the span.
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

  return frames.length > 0 ? { leaseId, leasedBy: workerId, expiresAt, jobId, frames } : null;
});

// Refused rather than extended: the frame may already belong to another worker.
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

export function clearJobLeases(jobId) {
  return db.prepare(
    `UPDATE frames SET leaseId = NULL, leasedBy = NULL, leaseExpiresAt = NULL
     WHERE jobId = ? AND leaseId IS NOT NULL`
  ).run(jobId).changes;
}

// Every frame the one claim covers. They share an owner and an expiry, so the
// span answers as one thing.
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

// Built per call because the number of placeholders varies; the caller pages
// first, so the list is bounded by the page size.
export function getFailedFramesIn(jobIds) {
  if (jobIds.length === 0) return [];

  return db.prepare(
    `SELECT jobId, frame, error, updatedAt FROM frames
     WHERE status = 'failed' AND jobId IN (${jobIds.map(() => '?').join(',')})
     ORDER BY jobId, frame`
  ).all(...jobIds);
}

// Jobs written before frames were tracked individually have no rows at all.
// Their frame numbers are recoverable from the filenames they recorded.
const backfillFrames = db.transaction(() => {
  const stale = db.prepare(`
    SELECT id, frameStart, frameEnd, uploadedFrames, frameErrors FROM jobs
    WHERE NOT EXISTS (SELECT 1 FROM frames WHERE frames.jobId = jobs.id)
  `).all();

  for (const job of stale) {
    if (!Number.isInteger(job.frameStart) || !Number.isInteger(job.frameEnd)) continue;

    createFrames(job.id, job.frameStart, job.frameEnd);

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

// VACUUM INTO rather than copying the file: it takes a consistent snapshot of a
// live database, where copying one in WAL mode can catch it mid-write and
// silently leave the newest jobs out.
export function backupDatabase(now = new Date()) {
  if (DB_BACKUPS_KEPT < 1) return null;

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  // Milliseconds kept: two starts in the same second are ordinary when a
  // service restarts, and the name has to stay unique and still sort by time.
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUPS_DIR, `rendernet-${stamp}.db`);

  try {
    if (fs.existsSync(target)) fs.rmSync(target);

    db.prepare('VACUUM INTO ?').run(target);
    pruneBackups();

    return target;
  } catch (error) {
    // A backup that fails must not stop the farm starting.
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
      // Next boot gets it.
    }
  }
}
