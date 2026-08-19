import fs from 'fs';
import path from 'path';
import util from 'util';
import { LOGS_DIR, LOG_RETENTION_DAYS, MAX_LOG_BYTES } from './paths.js';

const LEVELS = { log: 'INFO', warn: 'WARN', error: 'ERROR' };
const NAME_PATTERN = /^rendernet-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/;

let handle = null;
let openDay = null;
let written = 0;
let patched = false;

function day(date) {
  return date.toISOString().slice(0, 10);
}

function fileFor(stamp, index) {
  return path.join(LOGS_DIR, index === 0 ? `rendernet-${stamp}.log` : `rendernet-${stamp}.${index}.log`);
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Resumes the day's file where a previous run left it, so a workstation
// restarted mid-evening does not start a fresh one each time.
function openFor(stamp) {
  for (let index = 0; ; index++) {
    const file = fileFor(stamp, index);
    const size = sizeOf(file);

    if (size < MAX_LOG_BYTES) {
      handle = fs.openSync(file, 'a');
      openDay = stamp;
      written = size;
      return;
    }
  }
}

function ensureOpen() {
  const stamp = day(new Date());

  if (handle !== null && stamp === openDay && written < MAX_LOG_BYTES) return;

  if (handle !== null) fs.closeSync(handle);

  handle = null;
  openFor(stamp);
}

function record(level, text) {
  try {
    ensureOpen();
    written += fs.writeSync(handle, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    // A log that cannot be written must not take the render down with it.
  }
}

export function pruneOldLogs(now = Date.now()) {
  const cutoff = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const name of listLogs()) {
    const file = path.join(LOGS_DIR, name);

    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.rmSync(file);
      removed++;
    } catch {
      // Gone already, or held open on Windows; the next sweep gets it.
    }
  }

  return removed;
}

export function listLogs() {
  try {
    return fs.readdirSync(LOGS_DIR).filter(name => NAME_PATTERN.test(name)).sort().reverse();
  } catch {
    return [];
  }
}

// The dashboard polls these every couple of seconds for every person watching
// it, which at that rate would be the whole file. Anything else is logged, so a
// new route is recorded until someone decides otherwise.
const POLLED = [
  /^\/api\/health$/,
  /^\/api\/jobs$/,
  /^\/api\/jobs\/\d+$/,
  /^\/api\/jobs\/queue\/status$/
];

function worthRecording(method, requestPath, status) {
  if (status >= 400) return true;
  if (method !== 'GET') return true;

  return !POLLED.some(pattern => pattern.test(requestPath));
}

// One machine is shared, and people can cancel and reprioritise each other's
// work. Who did what is the record that makes that workable.
export function requestLogger(req, res, next) {
  const started = Date.now();
  const { method } = req;

  // Read now, not when the response finishes: routers rewrite req.url as they
  // dispatch, so by then req.path has been stripped to whatever was left after
  // the mount point. Taken from req.path rather than req.originalUrl because a
  // download authenticates by query string and that token must not be written
  // down.
  const requestPath = req.path;

  res.on('finish', () => {
    if (!worthRecording(method, requestPath, res.statusCode)) return;

    console.log(`${method} ${requestPath} ${res.statusCode} ${Date.now() - started}ms `
      + `user=${req.user?.username ?? 'anonymous'} ip=${req.ip ?? '?'}`);
  });

  next();
}

// Console rather than a logging call of its own: the server already says what
// it is doing in eighty-odd places, and on the workstation those go to a
// Task Scheduler window nobody sees.
export function startFileLogging() {
  if (patched) return;
  patched = true;

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  pruneOldLogs();

  for (const [method, level] of Object.entries(LEVELS)) {
    const original = console[method].bind(console);

    console[method] = (...args) => {
      original(...args);
      record(level, util.format(...args));
    };
  }
}

// On import rather than from index.js: imports are evaluated before any
// statement in the importing module, so a call there would miss whatever the
// other modules log as they load.
startFileLogging();
