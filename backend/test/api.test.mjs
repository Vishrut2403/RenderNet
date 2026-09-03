// End-to-end HTTP tests against a real server instance in a sandbox directory.
// What only a real Blender can answer is checked here and skipped without one;
// what merely needs frames on disk lives in the downloads suite, which runs
// everywhere.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { ENGINE_IDS } from '../src/engines.js';
import {
  createResults, makeSandbox, removeSandbox, startServer, stopServer,
  login, auth, status, submitJob, waitForJob, blenderAvailable, blenderEngines,
  engineRenders, createFixtureBlend, exrHeader, EXR_COMPRESSION, EXR_HALF, EXR_FLOAT,
  ffmpegAvailable, waitForCondition,
  adminSession, signUp, SIGNUP_CODE, ADMIN_PASSWORD
} from './helpers.mjs';

const PORT = 5592;

export default async function run() {
  const results = createResults('api');
  const sandbox = makeSandbox('api');
  let server;

  try {
    // Seeded before the server boots so the one-time users.json import runs.
    const legacyHash = crypto.createHash('sha256').update('legacypass').digest('hex');
    fs.writeFileSync(path.join(sandbox, 'users.json'), JSON.stringify({
      admin: {
        username: 'admin',
        passwordHash: crypto.createHash('sha256').update('admin123').digest('hex'),
        role: 'admin',
        createdAt: '2026-02-02T00:00:00.000Z'
      },
      legacyuser: {
        username: 'legacyuser',
        passwordHash: legacyHash,
        role: 'user',
        createdAt: '2026-03-01T00:00:00.000Z'
      }
    }, null, 2));

    server = await startServer({ port: PORT, cwd: sandbox });
    const { base } = server;

    const openDb = () => new Database(path.join(sandbox, 'test.db'), { readonly: true });
    const algoFor = username => {
      const db = openDb();
      const row = db.prepare('SELECT hashAlgo, passwordHash FROM users WHERE username = ?').get(username);
      db.close();
      return row;
    };

    console.log('\n  Password hashing and legacy migration');
    results.check('users.json imported into the database', !!algoFor('legacyuser'));
    results.check('imported hashes keep their original algorithm',
      algoFor('legacyuser').hashAlgo === 'sha256', algoFor('legacyuser')?.hashAlgo);

    const legacyToken = await login(base, 'legacyuser', 'legacypass');
    results.check('legacy sha256 password still authenticates', !!legacyToken);
    results.check('hash upgraded to bcrypt after login',
      algoFor('legacyuser').hashAlgo === 'bcrypt', algoFor('legacyuser').hashAlgo);
    results.check('upgraded hash is a bcrypt digest',
      algoFor('legacyuser').passwordHash.startsWith('$2b$'));
    results.check('re-login works against the upgraded hash',
      !!(await login(base, 'legacyuser', 'legacypass')));

    results.check('wrong password rejected',
      await status(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'legacyuser', password: 'wrong' })
      }) === 401);

    // Only the extension is checked at upload time, so validation and access
    // control can be exercised without invoking Blender.
    const stubBlend = path.join(sandbox, 'stub.blend');
    fs.writeFileSync(stubBlend, Buffer.alloc(1024, 7));

    console.log('\n  The seeded admin must replace its password first');
    const seeded = await (await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    })).json();

    results.check('the default password still signs in', !!seeded.token);
    results.check('and the response says a change is required',
      seeded.mustChangePassword === true, JSON.stringify(seeded.mustChangePassword));
    results.check('but it cannot reach the jobs it would own',
      await status(`${base}/jobs`, { headers: auth(seeded.token) }) === 403);
    results.check('nor upload anything',
      (await submitJob(base, seeded.token, stubBlend, { frameStart: 1, frameEnd: 1 })).status === 403);
    results.check('nor download anything',
      await status(`${base}/download/1/zip`, { headers: auth(seeded.token) }) === 403);
    results.check('verify reports the requirement so the UI can act on it',
      (await (await fetch(`${base}/auth/verify`, { headers: auth(seeded.token) })).json())
        .mustChangePassword === true);

    const cleared = await fetch(`${base}/auth/change-password`, {
      method: 'POST',
      headers: { ...auth(seeded.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'admin123', newPassword: ADMIN_PASSWORD })
    });
    results.check('changing the password is allowed while locked out', cleared.status === 200,
      `got ${cleared.status}`);
    results.check('the same token then works normally',
      await status(`${base}/jobs`, { headers: auth(seeded.token) }) === 200);

    console.log('\n  Account creation is gated');
    results.check('signup with no code rejected',
      await signUp(base, 'nocode', 'password123', null) === 400);
    results.check('signup with the wrong code rejected',
      await signUp(base, 'wrongcode', 'password123', 'not-the-code') === 400);
    results.check('signup with the right code accepted',
      await signUp(base, 'tester', 'testpass123', SIGNUP_CODE) === 200);
    results.check('a rejected signup creates no account',
      await status(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'wrongcode', password: 'password123' })
      }) === 401);

    const adminToken = await adminSession(base);
    const userToken = await login(base, 'tester', 'testpass123');

    results.check('new signups are hashed with bcrypt',
      algoFor('tester').hashAlgo === 'bcrypt' && algoFor('tester').passwordHash.startsWith('$2b$'));

    const changed = await fetch(`${base}/auth/change-password`, {
      method: 'POST',
      headers: { ...auth(userToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'testpass123', newPassword: 'newpass456' })
    });
    results.check('password change succeeds', changed.status === 200, `got ${changed.status}`);
    results.check('new password authenticates', !!(await login(base, 'tester', 'newpass456')));
    results.check('old password no longer authenticates',
      await status(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: 'testpass123' })
      }) === 401);

    // A JSON body can carry any shape. An object reaching SQLite as a bind
    // parameter throws, and an async route that throws is an unhandled
    // rejection - which takes the whole server down, render and all.
    console.log('\n  Malformed credentials do not take the server down');
    const post = (route, body) => status(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const malformed = [
      await post('/auth/login', { username: { a: 1 }, password: 'x' }),
      await post('/auth/login', { username: 'admin', password: ['x'] }),
      await post('/auth/login', { username: 42, password: 'x' }),
      await post('/auth/signup', { username: { a: 1 }, password: 'x', code: SIGNUP_CODE })
    ];

    results.check('non-string credentials are refused, not thrown on',
      malformed.every(code => code === 400), malformed.join(','));
    results.check('and the server is still serving afterwards',
      await status(`${base}/health`) === 200);

    console.log('\n  Repeated failed logins lock the account out');
    await signUp(base, 'guessme', 'correcthorse', SIGNUP_CODE);

    const tryLogin = (password) => fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'guessme', password })
    });

    const refusals = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      refusals.push((await tryLogin(`wrong-${attempt}`)).status);
    }

    results.check('the first five wrong guesses are ordinary refusals',
      refusals.every(code => code === 401), refusals.join(','));

    const locked = await tryLogin('wrong-6');
    results.check('the sixth is refused as a lockout', locked.status === 429,
      `got ${locked.status}`);
    results.check('and says how long to wait', !!locked.headers.get('retry-after'),
      String(locked.headers.get('retry-after')));

    // The point of a lockout: guessing is stopped even if the next guess is
    // the right one, so an attacker cannot simply keep going.
    const rightButLocked = await tryLogin('correcthorse');
    results.check('the correct password is refused while locked out',
      rightButLocked.status === 429, `got ${rightButLocked.status}`);

    // A name that does not exist is counted the same way, so a lockout never
    // reveals which accounts are real.
    const ghost = (password) => fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'no-such-person', password })
    });

    for (let attempt = 1; attempt <= 5; attempt++) await ghost(`wrong-${attempt}`);

    results.check('an unknown username locks out the same way',
      (await ghost('wrong-6')).status === 429);

    results.check('an untouched account is unaffected',
      !!(await login(base, 'tester', 'newpass456')));

    console.log('\n  The engine list is served, not duplicated');
    results.check('anonymous callers get nothing',
      await status(`${base}/engines`) === 401);

    const offered = await (await fetch(`${base}/engines`, { headers: auth(adminToken) })).json();

    results.check('every engine carries an id and a label',
      offered.engines?.length > 0
        && offered.engines.every(entry => entry.id && entry.label),
      JSON.stringify(offered.engines));

    // The form offers exactly these, so anything here the upload route would
    // refuse is an option that fails only once somebody picks it.
    const refused = [];
    for (const { id } of offered.engines ?? []) {
      const attempt = await submitJob(base, adminToken, stubBlend, {
        frameStart: 1, frameEnd: 1, engine: id
      });
      if (attempt.status !== 200) refused.push(`${id} -> ${attempt.status}`);
    }

    results.check('and upload accepts every one of them',
      refused.length === 0, refused.join(', '));

    console.log('\n  Upload validation');
    const bad = async opts => (await submitJob(base, adminToken, stubBlend, opts)).status;
    results.check('end before start rejected', await bad({ frameStart: 5, frameEnd: 1 }) === 400);
    results.check('non-integer range rejected', await bad({ frameStart: 'abc', frameEnd: 3 }) === 400);
    results.check('negative start rejected', await bad({ frameStart: -2, frameEnd: 3 }) === 400);
    results.check('oversized range rejected', await bad({ frameStart: 1, frameEnd: 99999 }) === 400);
    results.check('unknown engine rejected', await bad({ frameStart: 1, frameEnd: 2, engine: 'EVIL' }) === 400);

    results.check('zero resolution rejected',
      await bad({ frameStart: 1, frameEnd: 1, resolutionPercent: 0 }) === 400);
    results.check('resolution above 100 rejected',
      await bad({ frameStart: 1, frameEnd: 1, resolutionPercent: 101 }) === 400);
    results.check('fractional resolution rejected',
      await bad({ frameStart: 1, frameEnd: 1, resolutionPercent: 12.5 }) === 400);
    results.check('zero samples rejected',
      await bad({ frameStart: 1, frameEnd: 1, samples: 0 }) === 400);

    const notBlend = path.join(sandbox, 'notablend.txt');
    fs.writeFileSync(notBlend, 'nope');
    results.check('non-blend file rejected with 400',
      (await submitJob(base, adminToken, notBlend, { frameStart: 1, frameEnd: 1 })).status === 400);

    const upperBlend = path.join(sandbox, 'SHOUTING.BLEND');
    fs.writeFileSync(upperBlend, Buffer.alloc(1024, 7));
    results.check('extension check is case-insensitive',
      (await submitJob(base, adminToken, upperBlend, { frameStart: 1, frameEnd: 1 })).status === 200);

    console.log('\n  Ownership and access control');
    const stub = await submitJob(base, adminToken, stubBlend, { frameStart: 1, frameEnd: 1 });
    const stubId = stub.body.jobId;

    const adminJob = await (await fetch(`${base}/jobs/${stubId}`, { headers: auth(adminToken) })).json();
    results.check('owner comes from session, not request body', adminJob.owner === 'admin', adminJob.owner);
    results.check('output folder id matches job id',
      adminJob.outputFolder.endsWith(String(adminJob.id)), adminJob.outputFolder);

    results.check('other user cannot read the job',
      await status(`${base}/jobs/${stubId}`, { headers: auth(userToken) }) === 403);
    results.check('other user cannot cancel the job',
      await status(`${base}/jobs/${stubId}/cancel`, { method: 'POST', headers: auth(userToken) }) === 403);

    const userList = await (await fetch(`${base}/jobs`, { headers: auth(userToken) })).json();
    results.check('job list excludes other users jobs', userList.total === 0, `got ${userList.total}`);

    const adminList = await (await fetch(`${base}/jobs`, { headers: auth(adminToken) })).json();
    results.check('admin sees all jobs', adminList.total > 0, `got ${adminList.total}`);

    console.log('\n  Admin endpoints');
    results.check('admin can list users',
      await status(`${base}/auth/users`, { headers: auth(adminToken) }) === 200);
    results.check('non-admin cannot list users',
      await status(`${base}/auth/users`, { headers: auth(userToken) }) === 403);

    const users = await (await fetch(`${base}/auth/users`, { headers: auth(adminToken) })).text();
    results.check('password hashes are not exposed', !users.includes('passwordHash'));

    // A throwaway account: resetting one still in use below would lock the
    // token those checks depend on and pass them for the wrong reason.
    await signUp(base, 'resetme', 'originalpass');
    await fetch(`${base}/auth/admin/reset-password`, {
      method: 'POST',
      headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUsername: 'resetme', newPassword: 'reset-by-admin' })
    });
    const afterReset = await (await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'resetme', password: 'reset-by-admin' })
    })).json();
    // The admin who set it knows it, so the owner has to replace it.
    results.check('an admin reset hands the account back locked',
      afterReset.mustChangePassword === true, JSON.stringify(afterReset.mustChangePassword));

    console.log('\n  Worker callback authentication');
    results.check('worker route rejects a request with no secret',
      await status(`${base}/worker/jobs/1/progress`, { method: 'POST' }) === 401);

    if (!blenderAvailable()) {
      console.log('\n  Rendering, downloads and persistence');
      for (const name of ['render completes', 'frames written',
        'every offered engine is one this Blender lists',
        'the EXR is written half float, not the 32-bit a scene defaults to',
        'a JPEG at quality 10 is smaller than the same frame at 90',
        'a scene set to 16-bit PNG is still written at the 8 the form promises',
        'a scene reaching for a file it did not bring is stopped before rendering',
        'the frames are encoded into a playable video',
        'BLENDER_EEVEE renders', 'BLENDER_WORKBENCH renders']) {
        results.skipped(name, 'Blender not installed');
      }
      return results;
    }

    console.log('\n  Rendering');
    const blend = createFixtureBlend(sandbox);
    const submitted = await submitJob(base, adminToken, blend, { frameStart: 1, frameEnd: 2 });
    const jobId = submitted.body.jobId;
    const finished = await waitForJob(base, adminToken, jobId);

    results.check('render completes', finished.status === 'completed',
      `${finished.status}: ${finished.error || ''}`);
    results.check('frames written to disk',
      fs.readdirSync(path.join(sandbox, finished.outputFolder)).length === 2);

    // The upload form offers these by name and the worker passes them straight
    // to -E. Blender keeps renamed identifiers working as aliases for a while,
    // so drifting from its canonical list is a warning rather than a breakage -
    // but it is the only notice there is before the alias goes.
    const accepted = blenderEngines();
    const unknown = ENGINE_IDS.filter(engine => !accepted.includes(engine));

    results.check('every offered engine is one this Blender lists',
      unknown.length === 0,
      `${JSON.stringify(unknown)} not in ${JSON.stringify(accepted)}`);

    // The stand-in can only mimic the render_post handler. This is the one
    // place the script itself runs inside a real Blender.
    const multi = await submitJob(base, adminToken, blend, {
      frameStart: 1, frameEnd: 1, formats: ['PNG', 'JPEG', 'OPEN_EXR']
    });
    const multiJob = await waitForJob(base, adminToken, multi.body.jobId);

    results.check('Blender writes every chosen format from one render',
      multiJob.status === 'completed',
      `${multiJob.status}: ${JSON.stringify(multiJob.frameErrors ?? [])}`);

    const produced = fs.readdirSync(path.join(sandbox, multiJob.outputFolder)).sort();
    results.check('all three files are there',
      produced.join(',') === 'frame_0001.exr,frame_0001.jpg,frame_0001.png', produced.join(','));

    // Each format has to be its own encoding, not the same bytes renamed.
    const bytes = name => fs.readFileSync(path.join(sandbox, multiJob.outputFolder, name));
    results.check('the PNG is a PNG', bytes('frame_0001.png').subarray(1, 4).toString() === 'PNG');
    results.check('the JPEG is a JPEG', bytes('frame_0001.jpg').subarray(0, 2).toString('hex') === 'ffd8');
    results.check('the EXR is an EXR',
      bytes('frame_0001.exr').subarray(0, 4).toString('hex') === '762f3101');

    // The codec and the depth are only visible in the file Blender wrote, and
    // the default is the one that decides how much disk every job costs.
    const written = exrHeader(path.join(sandbox, multiJob.outputFolder, 'frame_0001.exr'));
    results.check('the EXR is written half float, not the 32-bit a scene defaults to',
      written.pixelTypes.length > 0 && written.pixelTypes.every(type => type === EXR_HALF),
      JSON.stringify(written.pixelTypes));
    results.check('and compressed with the codec the job asked for',
      written.compression === EXR_COMPRESSION.ZIP, String(written.compression));

    const lossy = await submitJob(base, adminToken, blend, {
      frameStart: 1, frameEnd: 1, formats: ['PNG', 'JPEG', 'OPEN_EXR'],
      exrCodec: 'DWAA', exrDepth: '32', jpegQuality: 10
    });
    const lossyJob = await waitForJob(base, adminToken, lossy.body.jobId);

    results.check('a job that asks for other settings still renders',
      lossyJob.status === 'completed',
      `${lossyJob.status}: ${JSON.stringify(lossyJob.frameErrors ?? [])}`);

    const other = exrHeader(path.join(sandbox, lossyJob.outputFolder, 'frame_0001.exr'));
    results.check('with the codec and depth it chose instead',
      other.compression === EXR_COMPRESSION.DWAA
        && other.pixelTypes.every(type => type === EXR_FLOAT),
      `${other.compression} / ${JSON.stringify(other.pixelTypes)}`);

    // The JPEG is saved from the finished render rather than by the render
    // itself, so its quality proves the handler applies settings too.
    const sizeOf = (job, name) => fs.statSync(path.join(sandbox, job.outputFolder, name)).size;
    results.check('and a JPEG at quality 10 is smaller than the same frame at 90',
      sizeOf(lossyJob, 'frame_0001.jpg') < sizeOf(multiJob, 'frame_0001.jpg'),
      `${sizeOf(lossyJob, 'frame_0001.jpg')} vs ${sizeOf(multiJob, 'frame_0001.jpg')}`);

    // The format is forced on the command line, but the depth is a separate
    // setting the scene carries, and a 16-bit PNG is not what the form offers.
    const deep = createFixtureBlend(sandbox, {
      name: 'deep.blend', extra: "s.render.image_settings.color_depth = '16'"
    });
    const deepJob = await waitForJob(base, adminToken, (await submitJob(base, adminToken, deep, {
      frameStart: 1, frameEnd: 1, formats: ['PNG']
    })).body.jobId);

    // Byte 24 of a PNG is the bit depth in its header.
    const pngDepth = fs.readFileSync(path.join(sandbox, deepJob.outputFolder, 'frame_0001.png'))[24];
    results.check('a scene set to 16-bit PNG is still written at the 8 the form promises',
      pngDepth === 8, String(pngDepth));

    // The asset check is a script run inside Blender against a real scene, so a
    // scene that genuinely reaches for a file that is not there is the only way
    // to know it reports one.
    const wanting = createFixtureBlend(sandbox, {
      name: 'wanting.blend',
      extra: [
        "mat = bpy.data.materials.new('Textured')",
        'mat.use_nodes = True',
        "img = bpy.data.images.new('missing_tex', 8, 8)",
        "img.filepath = '/nowhere/rendernet/wood.png'",
        "img.source = 'FILE'",
        "node = mat.node_tree.nodes.new('ShaderNodeTexImage')",
        'node.image = img',
        "bpy.data.objects['Cube'].data.materials.append(mat)"
      ].join('\n')
    });

    const wantingJob = await waitForJob(base, adminToken, (await submitJob(base, adminToken, wanting, {
      frameStart: 1, frameEnd: 1
    })).body.jobId);

    results.check('a scene reaching for a file it did not bring is stopped before rendering',
      wantingJob.status === 'failed' && wantingJob.completedFrames === 0,
      `${wantingJob.status}: ${wantingJob.error}`);
    results.check('and the file it wanted is named',
      wantingJob.missingAssets?.includes('wood.png'), JSON.stringify(wantingJob.missingAssets));

    // The ordinary fixture has nothing outside itself, so the same check has to
    // let it through - a check that stopped everything would be worse than none.
    results.check('while a self-contained scene is passed as sound',
      multiJob.assetCheck === 'ok', multiJob.assetCheck);

    // A stub ffmpeg proves the plumbing; only the real one proves that what
    // comes out is a video a player will open.
    if (!ffmpegAvailable()) {
      results.skipped('the frames are encoded into a playable video', 'ffmpeg not installed');
    } else {
      const asked = await fetch(`${base}/jobs/${jobId}/video`, {
        method: 'POST', headers: auth(adminToken)
      });

      results.check('a video can be asked for', asked.status === 202, String(asked.status));

      const encoded = await waitForCondition(async () => {
        const job = await (await fetch(`${base}/jobs/${jobId}`, { headers: auth(adminToken) })).json();
        return job.video === 'ready';
      }, { label: 'ffmpeg to finish', timeoutMs: 60000 });

      const video = path.join(sandbox, finished.outputFolder, `render_${jobId}.mp4`);

      // 'ftyp' at byte four is what a player looks for.
      results.check('the frames are encoded into a playable video',
        encoded && fs.existsSync(video)
          && fs.readFileSync(video).subarray(4, 8).toString() === 'ftyp',
        encoded ? `${fs.existsSync(video)}` : 'ffmpeg did not finish');
    }

    // The expression is built by hand and handed to Blender's own interpreter,
    // so the only proof it is valid Python against a real scene is running it.
    const tuned = await submitJob(base, adminToken, blend, {
      frameStart: 1, frameEnd: 1, resolutionPercent: 25, samples: 2
    });
    const tunedJob = await waitForJob(base, adminToken, tuned.body.jobId);

    results.check('Blender accepts the overrides expression',
      tunedJob.status === 'completed',
      `${tunedJob.status}: ${JSON.stringify(tunedJob.frameErrors ?? [])}`);

    for (const engine of ENGINE_IDS.filter(name => name !== 'CYCLES')) {
      if (!engineRenders(engine, blend, sandbox)) {
        results.skipped(`${engine} renders`, 'this machine cannot render with it headless');
        continue;
      }

      const job = await submitJob(base, adminToken, blend, {
        frameStart: 1, frameEnd: 1, engine
      });
      const done = await waitForJob(base, adminToken, job.body.jobId);

      results.check(`${engine} renders`, done.status === 'completed',
        `${done.status}: ${done.error || ''} ${JSON.stringify(done.frameErrors ?? [])}`);
    }

  } finally {
    await stopServer(server);
    removeSandbox(sandbox);
  }

  return results;
}
