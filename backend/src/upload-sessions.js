import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureDir, freeBytes } from './utils/file-utils.js';
import { usageFor } from './storage.js';
import {
  PARTIALS_DIR, UPLOADS_DIR, DATA_DIR, PARTIAL_TTL_MS, MAX_UPLOAD_BYTES, MAX_CHUNK_BYTES,
  UPLOAD_CHUNK_BYTES, USER_QUOTA_BYTES, MIN_FREE_BYTES
} from './paths.js';

const MAX_OPEN_PER_USER = 3;
// Long enough for any name somebody types, short enough that the id, the
// timestamp and this together stay inside Windows' path limit.
const MAX_FILENAME = 100;

const sessions = new Map();

// Named after the file as well as the id, so partials/ can be read at a glance.
function partialPath(id, filename) {
  return path.join(PARTIALS_DIR, `${id}-${filename}.part`);
}

function openFor(owner) {
  return [...sessions.values()].filter(session => session.owner === owner);
}

// Counted against the quota while it is still arriving, so three sessions each
// just under the limit cannot be used to walk past it.
function claimed(owner) {
  return openFor(owner).reduce((sum, session) => sum + session.size, 0);
}

export function openSession({ owner, filename, size }) {
  if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.blend')) {
    return { status: 400, error: 'Only .blend files are allowed' };
  }

  const name = path.basename(filename);

  if (name.length > MAX_FILENAME) {
    return { status: 400, error: `A filename may not exceed ${MAX_FILENAME} characters` };
  }

  if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    return {
      status: 413,
      error: `size must be a whole number of bytes up to ${MAX_UPLOAD_BYTES}`
    };
  }

  if (openFor(owner).length >= MAX_OPEN_PER_USER) {
    return {
      status: 409,
      error: `Only ${MAX_OPEN_PER_USER} uploads may be in progress at once. `
        + 'Finish or cancel one before starting another.'
    };
  }

  const free = freeBytes(DATA_DIR);

  if (free !== null && free - size < MIN_FREE_BYTES) {
    return { status: 507, error: 'Not enough disk left on the workstation for that file' };
  }

  const { bytes } = usageFor(owner, { fresh: true });

  if (bytes + claimed(owner) + size > USER_QUOTA_BYTES) {
    return { status: 413, error: 'That file would put you over your quota' };
  }

  ensureDir(PARTIALS_DIR);

  const id = crypto.randomBytes(16).toString('hex');
  const session = {
    id,
    owner,
    filename: name,
    size,
    received: 0,
    busy: false,
    path: partialPath(id, name),
    updatedAt: Date.now()
  };

  fs.writeFileSync(session.path, '');
  sessions.set(id, session);

  return { session, chunkSize: UPLOAD_CHUNK_BYTES };
}

export function sessionFor(id, owner) {
  const session = sessions.get(id);

  if (!session || session.owner !== owner) return null;

  return session;
}

export function describeSession(session) {
  return {
    uploadId: session.id,
    filename: session.filename,
    size: session.size,
    received: session.received,
    chunkSize: UPLOAD_CHUNK_BYTES
  };
}

class Limiter extends Transform {
  constructor(remaining) {
    super();
    this.remaining = remaining;
    this.count = 0;
  }

  _transform(chunk, _encoding, done) {
    this.count += chunk.length;

    if (this.count > MAX_CHUNK_BYTES) {
      return done(Object.assign(new Error(`A chunk may not exceed ${MAX_CHUNK_BYTES} bytes`),
        { status: 413 }));
    }

    if (this.count > this.remaining) {
      return done(Object.assign(new Error('That chunk runs past the size declared for this upload'),
        { status: 413 }));
    }

    done(null, chunk);
  }
}

// A chunk that dies halfway leaves the file longer than the count says, so it
// is cut back to the last byte both sides agree on.
export async function appendChunk(session, offset, stream) {
  if (session.busy) {
    return { status: 409, error: 'Another chunk of this upload is still arriving' };
  }

  if (offset !== session.received) {
    return {
      status: 409,
      error: `Expected the chunk starting at ${session.received}`,
      received: session.received
    };
  }

  if (session.received >= session.size) {
    return { status: 409, error: 'This upload already has every byte it declared' };
  }

  session.busy = true;

  const limiter = new Limiter(session.size - session.received);

  try {
    await pipeline(stream, limiter, fs.createWriteStream(session.path, { flags: 'a' }));

    session.received += limiter.count;
    session.updatedAt = Date.now();

    return { received: session.received, size: session.size };
  } catch (error) {
    truncate(session);

    return {
      status: error.status ?? 400,
      error: error.status ? error.message : 'The chunk did not arrive in full',
      received: session.received
    };
  } finally {
    session.busy = false;
  }
}

function truncate(session) {
  try {
    fs.truncateSync(session.path, session.received);
  } catch (error) {
    console.warn(`Could not rewind partial upload ${session.id}: ${error.message}`);
  }
}

export function finishSession(session) {
  if (session.received !== session.size) {
    return {
      status: 409,
      error: `Only ${session.received} of ${session.size} bytes have arrived`,
      received: session.received
    };
  }

  ensureDir(UPLOADS_DIR);

  const filename = `${Date.now()}-${session.filename}`;
  const destination = path.join(UPLOADS_DIR, filename);

  fs.renameSync(session.path, destination);
  sessions.delete(session.id);

  return {
    file: { path: destination, filename, size: session.size, originalname: session.filename }
  };
}

export function abortSession(session) {
  sessions.delete(session.id);
  fs.rmSync(session.path, { force: true });
}

// Files with no session behind them are what a restart leaves: the sessions
// live in memory, the bytes do not.
export function sweepPartials(now = Date.now()) {
  let removed = 0;

  for (const session of sessions.values()) {
    if (session.busy || now - session.updatedAt <= PARTIAL_TTL_MS) continue;

    abortSession(session);
    removed++;
  }

  if (!fs.existsSync(PARTIALS_DIR)) return removed;

  const live = new Set([...sessions.values()].map(session => session.path));

  for (const name of fs.readdirSync(PARTIALS_DIR)) {
    const file = path.join(PARTIALS_DIR, name);

    if (live.has(file)) continue;

    try {
      if (now - fs.statSync(file).mtimeMs <= PARTIAL_TTL_MS) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch {
      // Gone already, or being written by a session that started mid-sweep.
    }
  }

  return removed;
}

export function openSessionCount() {
  return sessions.size;
}
