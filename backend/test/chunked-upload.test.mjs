// A large .blend sent in pieces: what the server acknowledges, what it refuses,
// and what an interrupted transfer can pick up from. Runs without Blender.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, signUp, login, auth,
  getJob, snapshotEnv
} from './helpers.mjs';

const PORT = 5599;
const SIZE = 200 * 1024;
const PIECE = 64 * 1024;

async function open(base, token, body) {
  const res = await fetch(`${base}/upload/session`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return { status: res.status, body: await res.json() };
}

async function put(base, token, uploadId, offset, bytes) {
  const res = await fetch(`${base}/upload/session/${uploadId}?offset=${offset}`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
    body: bytes
  });

  return { status: res.status, body: await res.json() };
}

async function ask(base, token, uploadId) {
  const res = await fetch(`${base}/upload/session/${uploadId}`, { headers: auth(token) });
  return { status: res.status, body: await res.json() };
}

async function finish(base, token, uploadId, settings) {
  const res = await fetch(`${base}/upload/session/${uploadId}/finish`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });

  return { status: res.status, body: await res.json() };
}

const RANGE = { frameStart: '1', frameEnd: '4', renderEngine: 'CYCLES' };

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function run() {
  const results = createResults('chunked upload');
  const sandbox = makeSandbox('chunked');

  let server;

  try {
    server = await startServer({ port: PORT, cwd: sandbox });
    const { base } = server;

    await signUp(base, 'modeller', 'modeller-password');
    const token = await login(base, 'modeller', 'modeller-password');

    const scene = crypto.randomBytes(SIZE);

    console.log('\n  Starting an upload');

    const started = await open(base, token, { filename: 'packed.blend', size: SIZE });

    results.check('a session is opened', started.status === 201, JSON.stringify(started.body));
    results.check('with nothing received yet',
      started.body.received === 0 && started.body.size === SIZE,
      JSON.stringify(started.body));
    results.check('and a chunk size to send',
      started.body.chunkSize > 0, String(started.body.chunkSize));

    const refused = await Promise.all([
      open(base, token, { filename: 'notes.txt', size: SIZE }),
      open(base, token, { filename: 'empty.blend', size: 0 }),
      open(base, token, { filename: 'huge.blend', size: 8 * 1024 * 1024 * 1024 })
    ]);

    results.check('only .blend files, and only plausible sizes',
      refused.map(answer => answer.status).join(',') === '400,413,413',
      JSON.stringify(refused.map(answer => answer.status)));

    const { uploadId } = started.body;

    console.log('\n  Sending it in pieces');

    const first = await put(base, token, uploadId, 0, scene.subarray(0, PIECE));

    results.check('the first piece is acknowledged by how much is held',
      first.body.received === PIECE, JSON.stringify(first.body));

    // Long enough to arrive in several pieces, so the server has written some
    // of it by the time it sees the chunk runs past the size declared. What it
    // wrote has to go, or everything sent afterwards lands behind it.
    const overrun = await put(base, token, uploadId, PIECE,
      crypto.randomBytes(SIZE - PIECE + 100 * 1024));

    results.check('a chunk running past the declared size is refused',
      overrun.status === 413, JSON.stringify(overrun.body));
    results.check('and leaves the count where it was',
      (await ask(base, token, uploadId)).body.received === PIECE);

    // A connection that dies mid-chunk is the ordinary case this exists for.
    // Sent slowly on purpose: pieces that reach the disk before the line drops
    // are exactly the ones that have to be taken back off it.
    const cut = new AbortController();

    await fetch(`${base}/upload/session/${uploadId}?offset=${PIECE}`, {
      method: 'PUT',
      headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
      duplex: 'half',
      signal: cut.signal,
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(crypto.randomBytes(PIECE));
          await pause(400);
          controller.enqueue(crypto.randomBytes(PIECE));
          await pause(400);
          cut.abort();
        }
      })
    }).catch(() => {});

    await pause(300);

    const survived = await ask(base, token, uploadId);

    results.check('an abandoned chunk leaves the count alone',
      survived.status === 200 && survived.body.received === PIECE,
      JSON.stringify(survived.body));

    const misplaced = await put(base, token, uploadId, 0, scene.subarray(0, PIECE));

    results.check('a chunk sent to the wrong place is refused',
      misplaced.status === 409, String(misplaced.status));
    results.check('and answered with where it should have gone',
      misplaced.body.received === PIECE, JSON.stringify(misplaced.body));

    const early = await finish(base, token, uploadId, RANGE);

    results.check('an upload missing bytes will not finish',
      early.status === 409, JSON.stringify(early.body));

    let offset = PIECE;
    let last = null;

    while (offset < SIZE) {
      last = await put(base, token, uploadId, offset,
        scene.subarray(offset, Math.min(offset + PIECE, SIZE)));

      offset = last.body.received;
    }

    // What a client asks after a dropped connection: not which pieces landed,
    // just how far it got.
    results.check('the rest of it completes the upload',
      last.body.received === SIZE, JSON.stringify(last.body));
    results.check('and the session agrees',
      (await ask(base, token, uploadId)).body.received === SIZE);

    console.log('\n  Finishing');

    const queued = await finish(base, token, uploadId, RANGE);

    results.check('the assembled file is queued as a job',
      queued.status === 200 && queued.body.jobId > 0, JSON.stringify(queued.body));

    const job = await getJob(base, token, queued.body.jobId);

    results.check('with the settings sent at the end',
      job.frameStart === 1 && job.frameEnd === 4 && job.totalFrames === 4,
      JSON.stringify({ start: job.frameStart, end: job.frameEnd }));

    const stored = job.filePath
      ? fs.readFileSync(path.join(sandbox, job.filePath))
      : Buffer.alloc(0);

    results.check('and the bytes that were sent, in the order they were sent',
      stored.length === SIZE && stored.equals(scene), `${stored.length} of ${SIZE}`);

    results.check('the part file is not left behind',
      fs.readdirSync(path.join(sandbox, 'partials')).length === 0,
      JSON.stringify(fs.readdirSync(path.join(sandbox, 'partials'))));

    results.check('and the finished session is gone',
      (await ask(base, token, uploadId)).status === 404);

    console.log('\n  Whose upload it is');

    const another = await open(base, token, { filename: 'private.blend', size: SIZE });

    await signUp(base, 'rigger', 'rigger-password');
    const other = await login(base, 'rigger', 'rigger-password');

    const peeked = await ask(base, other, another.body.uploadId);
    const pushed = await put(base, other, another.body.uploadId, 0, scene.subarray(0, PIECE));

    results.check('somebody else cannot look at it',
      peeked.status === 404, String(peeked.status));
    results.check('nor write to it',
      pushed.status === 404, String(pushed.status));

    const anonymous = await fetch(`${base}/upload/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'anon.blend', size: SIZE })
    });

    results.check('and nobody starts one without signing in',
      anonymous.status === 401, String(anonymous.status));

    const dropped = await fetch(`${base}/upload/session/${another.body.uploadId}`, {
      method: 'DELETE', headers: auth(token)
    });

    results.check('an abandoned upload can be given up',
      dropped.status === 200 && (await ask(base, token, another.body.uploadId)).status === 404);
    results.check('taking its part file with it',
      fs.readdirSync(path.join(sandbox, 'partials')).length === 0);

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  await rewinds(results);

  return results;
}

// Whether the bytes of a dying chunk reach the disk before the connection goes
// is a race no request can be made to lose reliably, so the append is driven
// directly: write some, fail, and see what the file is left holding.
async function rewinds(results) {
  console.log('\n  Taking back a chunk that died halfway');

  const box = makeSandbox('rewind');
  const restore = snapshotEnv(['DATA_DIR', 'DB_PATH']);

  process.env.DATA_DIR = box;
  process.env.DB_PATH = path.join(box, 'rewind.db');

  try {
    const { appendChunk } = await import('../src/upload-sessions.js');

    const part = path.join(box, 'half.part');
    fs.writeFileSync(part, Buffer.alloc(100, 1));

    const session = {
      id: 'rewind', owner: 'someone', filename: 'half.blend',
      size: 5000, received: 100, busy: false, path: part, updatedAt: Date.now()
    };

    const stream = new Readable({ read() {} });
    stream.push(Buffer.alloc(2000, 2));

    const appending = appendChunk(session, 100, stream);

    await waitFor(() => fs.statSync(part).size > 100);

    results.check('what arrives before the failure does reach the file',
      fs.statSync(part).size > 100, String(fs.statSync(part).size));

    stream.destroy(new Error('connection lost'));

    const failed = await appending;

    results.check('a chunk cut off is reported, not counted',
      failed.status === 400 && failed.received === 100, JSON.stringify(failed));
    results.check('and the file is cut back to the last byte both sides agreed on',
      fs.statSync(part).size === 100, String(fs.statSync(part).size));
    results.check('leaving the upload free to carry on',
      session.busy === false && session.received === 100);

  } finally {
    restore();
    removeSandbox(box);
  }
}

async function waitFor(check, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return true;
    await pause(20);
  }

  return false;
}
