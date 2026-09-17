// Uploads and downloads at their edges: a finish asked for twice, uploads a page
// left behind, the disk reserve with other uploads still arriving, supplied files
// against quota, and a video encode cut off by a restart.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer, adminSession, auth,
  createFakeBlender, createFakeFfmpeg, createFakeScene, submitJob, waitForJob
} from './helpers.mjs';
import { freeBytes } from '../src/utils/file-utils.js';

const PORT = 5632;
const RESERVE_PORT = 5633;
const QUOTA_PORT = 5634;
const VIDEO_PORT = 5635;
const MB = 1024 * 1024;

// Limited, so a request the server never answers fails the check instead of
// hanging the suite.
function json(base, token, route, { method = 'POST', body } = {}) {
  return fetch(`${base}/${route}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function open(base, token, size, filename = 'big.blend') {
  const res = await json(base, token, 'upload/session', { body: { filename, size } });
  return { status: res.status, body: await res.json() };
}

export default async function run() {
  const results = createResults('transfers');
  const box = makeSandbox('transfers');
  const servers = [];

  const start = async (port, name, env = {}) => {
    const dir = path.join(box, name);
    fs.mkdirSync(dir, { recursive: true });
    const server = await startServer({
      port, cwd: dir, dataDir: dir, env: { BLENDER_PATH: createFakeBlender(dir), ...env }
    });
    servers.push(server);
    return server;
  };

  try {
    const farm = await start(PORT, 'farm');
    const token = await adminSession(farm.base);

    console.log('\n  Finishing one upload twice');

    const size = 96 * MB;
    const session = (await open(farm.base, token, size)).body;
    const bytes = Buffer.alloc(size, 7);

    for (let offset = 0; offset < size; offset += session.chunkSize) {
      await fetch(`${farm.base}/upload/session/${session.uploadId}?offset=${offset}`, {
        method: 'PUT',
        headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
        body: bytes.subarray(offset, offset + session.chunkSize)
      });
    }

    const settings = { frameStart: '1', frameEnd: '1', renderEngine: 'CYCLES', skipAssetCheck: '1' };
    const statusOf = request => request.then(res => res.status, () => 'no answer');
    const finish = () => statusOf(json(farm.base, token,
      `upload/session/${session.uploadId}/finish`, { body: settings }));

    // The first is hashing a large file by the time the others arrive.
    const firstFinish = finish();
    await new Promise(resolve => setTimeout(resolve, 30));
    const [second, cancel] = await Promise.all([
      finish(),
      statusOf(json(farm.base, token, `upload/session/${session.uploadId}`, { method: 'DELETE' }))
    ]);
    const answers = [await firstFinish, second];

    results.check('only one of two finishes queues a job',
      answers.filter(status => status === 200).length === 1,
      `finishes answered ${answers}`);
    results.check('and cancelling mid-finish does not pull the file away',
      cancel === 409 && answers[0] === 200, `cancel answered ${cancel}; finishes ${answers}`);

    console.log('\n  Uploads a page left behind');

    const left = [];
    for (let i = 0; i < 3; i++) left.push((await open(farm.base, token, MB, `left-${i}.blend`)).status);

    const fourth = await open(farm.base, token, MB, 'wanted.blend');

    results.check('three abandoned uploads do not block a fourth',
      left.every(status => status === 201) && fourth.status === 201,
      `opened ${left}, then ${fourth.status}`);

    console.log('\n  The disk reserve with other uploads still arriving');

    const free = freeBytes(box);
    const reserve = await start(RESERVE_PORT, 'reserve', { MIN_FREE_BYTES: String(free - 300 * MB) });
    const reserveToken = await adminSession(reserve.base);
    const firstBig = await open(reserve.base, reserveToken, 200 * MB, 'a.blend');
    const secondBig = await open(reserve.base, reserveToken, 200 * MB, 'b.blend');

    results.check('an upload counts what others have promised but not yet sent',
      firstBig.status === 201 && secondBig.status === 507,
      `first ${firstBig.status}, second ${secondBig.status}`);

    console.log('\n  A supplied file over quota');

    const quota = await start(QUOTA_PORT, 'quota', { USER_QUOTA_BYTES: String(MB) });
    const quotaToken = await adminSession(quota.base);
    const job = (await submitJob(quota.base, quotaToken,
      createFakeScene(path.join(box, 'quota'), 'owned.blend'),
      { frameStart: 1, frameEnd: 1, skipAssetCheck: true })).body.jobId;

    const form = new FormData();
    form.set('asset', new Blob([Buffer.alloc(2 * MB, 1)]), 'wood.png');
    const supplied = await fetch(`${quota.base}/jobs/${job}/assets`,
      { method: 'POST', headers: auth(quotaToken), body: form });

    results.check('is refused before it is stored',
      supplied.status === 413, `answered ${supplied.status}`);

    console.log('\n  A video encode cut off by a restart');

    const videoDir = path.join(box, 'video');
    const env = { FFMPEG_PATH: createFakeFfmpeg(box) };
    let video = await start(VIDEO_PORT, 'video', env);
    const videoToken = await adminSession(video.base);
    const rendered = (await submitJob(video.base, videoToken,
      createFakeScene(videoDir, 'clip.blend'),
      { frameStart: 1, frameEnd: 2, skipAssetCheck: true })).body.jobId;

    await waitForJob(video.base, videoToken, rendered, 60000);
    await stopServer(video);
    servers.splice(servers.indexOf(video), 1);

    const db = new Database(path.join(videoDir, 'test.db'));
    db.prepare('UPDATE jobs SET video = ? WHERE id = ?').run('encoding', rendered);
    db.close();

    video = await start(VIDEO_PORT, 'video', env);
    const afterToken = await adminSession(video.base);
    const again = await json(video.base, afterToken, `jobs/${rendered}/video`);

    results.check('does not leave the job unable to make one again',
      again.status !== 409, `asking again answered ${again.status}`);
  } finally {
    for (const server of servers) await stopServer(server);
    removeSandbox(box);
  }

  return results;
}
