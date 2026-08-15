import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH || 'rendernet.db');
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

  CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner);
`);

const COLUMNS = [
  'id', 'status', 'filePath', 'outputPath', 'outputFolder', 'frameStart', 'frameEnd',
  'renderEngine', 'originalFilename', 'owner', 'createdAt', 'startedAt', 'completedAt',
  'cancelledAt', 'error', 'totalFrames', 'currentFrame', 'progress', 'completedFrames',
  'failedFrames', 'interruptions', 'uploadedFrames', 'frameErrors'
];

const JSON_COLUMNS = ['uploadedFrames', 'frameErrors'];

const upsertJob = db.prepare(`
  INSERT OR REPLACE INTO jobs (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(c => '@' + c).join(', ')})
`);

export function saveJob(job) {
  const row = {};

  for (const column of COLUMNS) {
    const value = JSON_COLUMNS.includes(column)
      ? JSON.stringify(job[column] ?? [])
      : job[column];

    // SQLite rejects undefined and booleans.
    row[column] = value === undefined ? null : value;
  }

  upsertJob.run(row);
}

export function loadJobs() {
  return db.prepare('SELECT * FROM jobs').all().map(row => {
    const job = { ...row };
    for (const column of JSON_COLUMNS) {
      job[column] = JSON.parse(row[column] || '[]');
    }
    return job;
  });
}

export function deleteJob(id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
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

export default db;
