import express from 'express';
import multer from 'multer';
import path from 'path';
import { deleteFile, freeBytes } from '../utils/file-utils.js';
import { storeBlend } from '../blend-store.js';
import { addToQueue } from '../queue.js';
import { readScene } from '../preflight.js';
import { getJob } from '../job-views.js';
import { DATA_DIR, PARTIALS_DIR, USER_QUOTA_BYTES, MIN_FREE_BYTES } from '../paths.js';
import {
  openSession, sessionFor, describeSession, appendChunk, finishSession, abortSession
} from '../upload-sessions.js';
import { usageFor, dropUnusedBlend } from '../storage.js';
import { ENGINE_IDS } from '../engines.js';
import { MAX_TILES } from '../tiles.js';
import {
  FORMAT_IDS, normaliseFormats, EXR_CODEC_IDS, EXR_DEPTH_IDS,
  DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY
} from '../formats.js';

const router = express.Router();

// Landed among the part-uploads: where it belongs in uploads/ is not known
// until the bytes have been read and hashed. A stray left by a request that
// died is swept from there like any other partial.
const storage = multer.diskStorage({
  destination: PARTIALS_DIR,
  filename: (req, file, cb) => {
    // basename strips any path separators a crafted filename might carry.
    cb(null, `${Date.now()}-${path.basename(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.blend')) {
      cb(null, true);
    } else {
      cb(new Error('Only .blend files are allowed'));
    }
  }
});

const MAX_FRAMES = 2000;
const MAX_SAMPLES = 16384;

// Absent means "whatever the scene says", which is not the same as a value.
function optionalInteger(raw, { min, max }) {
  if (raw === undefined || raw === '') return { ok: true, value: null };

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false };
  }

  return { ok: true, value };
}

function gigabytes(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Both checked before multer so somebody who cannot be served is told now
// rather than after waiting out a 500MB upload.
function withinQuota(req, res, next) {
  const { bytes } = usageFor(req.user.username, { fresh: true });

  if (bytes >= USER_QUOTA_BYTES) {
    return res.status(413).json({
      error: `You are using ${gigabytes(bytes)} of your ${gigabytes(USER_QUOTA_BYTES)}. `
        + 'Delete a finished job before uploading another.'
    });
  }

  next();
}

function roomOnDisk(req, res, next) {
  const free = freeBytes(DATA_DIR);

  if (free !== null && free < MIN_FREE_BYTES) {
    return res.status(507).json({
      error: `The workstation has only ${gigabytes(free)} of disk left, below the `
        + `${gigabytes(MIN_FREE_BYTES)} it keeps spare. Nothing can be uploaded or `
        + 'rendered until somebody deletes finished jobs.'
    });
  }

  next();
}

function withSession(req, res, next) {
  const session = sessionFor(req.params.id, req.user.username);

  if (!session) {
    return res.status(404).json({ error: 'No such upload' });
  }

  req.session = session;
  next();
}

// Read before the scene is stored, so a refusal costs the artist nothing: an
// upload consumed by a settings error would have to be sent all over again.
function checkSettings(body, owner, size) {
  const refuse = (status, error) => ({ status, error });

  const start = Number(body.frameStart);
  const end = Number(body.frameEnd);

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return refuse(400, 'frameStart and frameEnd must be integers');
  }

  if (start < 0 || end < start) {
    return refuse(400, 'Frame range must be positive and end must not precede start');
  }

  if (end - start + 1 > MAX_FRAMES) {
    return refuse(400, `Frame range exceeds the ${MAX_FRAMES} frame limit`);
  }

  const testFrame = body.testFrame === undefined || body.testFrame === ''
    ? null
    : Number(body.testFrame);

  if (testFrame !== null) {
    if (!Number.isInteger(testFrame) || testFrame < start || testFrame > end) {
      return refuse(400, `testFrame must be a whole frame from ${start} to ${end}`);
    }

    if (start === end) {
      return refuse(400, 'A single-frame job has nothing to hold back for approval');
    }
  }

  const tiles = body.tiles === undefined || body.tiles === '' ? null : Number(body.tiles);

  if (tiles !== null) {
    if (!Number.isInteger(tiles) || tiles < 2 || tiles > MAX_TILES) {
      return refuse(400, `tiles must be a whole number from 2 to ${MAX_TILES}`);
    }

    if (start !== end) {
      return refuse(400, 'Only a single frame can be split into tiles');
    }
  }

  const renderEngine = body.renderEngine || 'CYCLES';

  if (!ENGINE_IDS.includes(renderEngine)) {
    return refuse(400, `Unsupported render engine: ${renderEngine}`);
  }

  const { bytes } = usageFor(owner, { fresh: true });

  if (bytes + size > USER_QUOTA_BYTES) {
    return refuse(413, `That would put you at ${gigabytes(bytes + size)} of your `
      + `${gigabytes(USER_QUOTA_BYTES)}. Delete a finished job first.`);
  }

  const resolution = optionalInteger(body.resolutionPercent, { min: 1, max: 100 });

  if (!resolution.ok) {
    return refuse(400, 'resolutionPercent must be a whole number from 1 to 100');
  }

  const samples = optionalInteger(body.samples, { min: 1, max: MAX_SAMPLES });

  if (!samples.ok) {
    return refuse(400, `samples must be a whole number from 1 to ${MAX_SAMPLES}`);
  }

  // Sent as one comma-separated field: a repeated field arrives as a string
  // when one box is ticked and an array when several are, and that is a
  // needless difference to handle.
  const chosen = (body.formats ?? 'PNG').split(',').map(id => id.trim()).filter(Boolean);
  const formats = normaliseFormats(chosen);

  if (formats.length === 0 || chosen.some(id => !FORMAT_IDS.includes(id))) {
    return refuse(400, `Pick at least one output format from ${FORMAT_IDS.join(', ')}`);
  }

  const exrCodec = body.exrCodec || DEFAULT_EXR_CODEC;
  const exrDepth = String(body.exrDepth || DEFAULT_EXR_DEPTH);

  if (!EXR_CODEC_IDS.includes(exrCodec) || !EXR_DEPTH_IDS.includes(exrDepth)) {
    return refuse(400, `OpenEXR takes one of ${EXR_CODEC_IDS.join(', ')} `
      + `at ${EXR_DEPTH_IDS.join(' or ')} bits`);
  }

  const jpegQuality = optionalInteger(body.jpegQuality, { min: 1, max: 100 });

  if (!jpegQuality.ok) {
    return refuse(400, 'jpegQuality must be a whole number from 1 to 100');
  }

  if (tiles !== null && formats.length > 1) {
    return refuse(400, 'A tiled still is put back together in one format, so choose one');
  }

  return {
    settings: {
      frameStart: start,
      frameEnd: end,
      renderEngine,
      owner,
      priority: Number(body.priority) === 1 ? 1 : 0,
      resolutionPercent: resolution.value ?? 100,
      samples: samples.value,
      formats: formats.join(','),
      exrCodec,
      exrDepth,
      jpegQuality: jpegQuality.value ?? DEFAULT_JPEG_QUALITY,
      skipAssetCheck: body.skipAssetCheck === '1',
      testFrame,
      tiles
    }
  };
}

function queueUpload(file, settings) {
  const jobId = addToQueue({
    ...settings,
    filePath: file.filePath,
    originalFilename: path.basename(file.originalname)
  });

  return {
    success: true,
    message: 'Job added to render queue',
    jobId,
    // Null when it started straight away, or when nothing has been rendered
    // yet to work an estimate from.
    startsIn: getJob(jobId)?.startsIn ?? null
  };
}

router.post('/', roomOnDisk, withinQuota, upload.single('blend'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const checked = checkSettings(req.body, req.user.username, req.file.size);

    if (checked.error) {
      deleteFile(req.file.path);
      return res.status(checked.status).json({ error: checked.error });
    }

    const stored = await storeBlend(req.file.path, req.file.originalname);

    res.json(queueUpload({ ...stored, originalname: req.file.originalname }, checked.settings));
  } catch (error) {
    console.error('Upload error:', error);
    deleteFile(req.file?.path);
    res.status(500).json({ error: error.message });
  }
});

router.post('/session', roomOnDisk, withinQuota, (req, res) => {
  const opened = openSession({
    owner: req.user.username,
    filename: req.body?.filename,
    size: Number(req.body?.size)
  });

  if (opened.error) {
    return res.status(opened.status).json({ error: opened.error });
  }

  res.status(201).json(describeSession(opened.session));
});

// The client asks how much arrived before sending anything, so an upload
// interrupted an hour ago carries on from where it stopped.
router.get('/session/:id', withSession, (req, res) => {
  res.json(describeSession(req.session));
});

router.put('/session/:id', withSession, async (req, res) => {
  const offset = Number(req.query.offset);

  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'offset must be a whole number of bytes' });
  }

  const written = await appendChunk(req.session, offset, req);

  if (written.error) {
    return res.status(written.status).json({ error: written.error, received: written.received });
  }

  res.json(written);
});

// The scene's settings in the vocabulary this route accepts: an engine or a
// format the farm does not offer is left out.
function offeredSettings(scene) {
  const engine = ENGINE_IDS.includes(scene.engine) ? scene.engine : null;
  const percent = scene.resolutionPercent;

  return {
    frameStart: scene.frameStart,
    frameEnd: scene.frameEnd,
    frameStep: scene.frameStep,
    renderEngine: engine,
    resolutionPercent: percent >= 1 && percent <= 100 ? percent : null,
    samples: engine === 'CYCLES' ? scene.samples : null,
    format: FORMAT_IDS.includes(scene.format) ? scene.format : null,
    width: scene.width,
    height: scene.height,
    camera: scene.camera
  };
}

// What the form cannot carry across from the scene.
function warningsFor(scene, settings, scenes) {
  const notes = [];

  if (!settings.renderEngine) notes.push(`This farm does not run ${scene.engine}`);
  if (!settings.format) notes.push(`This farm does not write ${scene.format}`);
  if (!scene.camera) notes.push(`${scene.name} has no camera`);
  if (scene.frameStep > 1) notes.push(`Frame step ${scene.frameStep} is not applied`);
  if (scenes.length > 1) notes.push(`${scenes.length} scenes; ${scene.name} renders`);

  return notes;
}

function readingOf(report) {
  const active = report.scenes.find(scene => scene.name === report.active) ?? report.scenes[0];

  if (!active) return { read: false, scenes: [], active: null, settings: null, warnings: [] };

  const settings = offeredSettings(active);

  return {
    read: true,
    scenes: report.scenes.map(scene => scene.name),
    active: active.name,
    settings,
    warnings: warningsFor(active, settings, report.scenes)
  };
}

// Blender is given the partial file where it lies: it goes by what is inside a
// file rather than by its extension, and every byte is there once the last
// chunk has landed.
router.post('/session/:id/inspect', withSession, async (req, res) => {
  const { session } = req;

  if (session.busy || session.received !== session.size) {
    return res.status(409).json({
      error: `Only ${session.received} of ${session.size} bytes have arrived`
    });
  }

  // Once per upload: every reading costs a Blender, and the file cannot change
  // underneath one.
  if (!session.reading) {
    session.reading = readScene(session.path)
      .then(readingOf)
      .catch(() => ({ read: false, scenes: [], active: null, settings: null, warnings: [] }));
  }

  res.json(await session.reading);
});

router.post('/session/:id/finish', async (req, res) => {
  const session = sessionFor(req.params.id, req.user.username);

  if (!session) {
    return res.status(404).json({ error: 'No such upload' });
  }

  if (session.busy) {
    return res.status(409).json({ error: 'A chunk of this upload is still arriving' });
  }

  if (session.received !== session.size) {
    return res.status(409).json({
      error: `Only ${session.received} of ${session.size} bytes have arrived`,
      received: session.received
    });
  }

  const checked = checkSettings(req.body ?? {}, req.user.username, session.size);

  if (checked.error) {
    return res.status(checked.status).json({ error: checked.error });
  }

  const assembled = await finishSession(session);

  try {
    res.json(queueUpload(assembled.file, checked.settings));
  } catch (error) {
    console.error('Upload error:', error);
    dropUnusedBlend(assembled.file.filePath);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/session/:id', withSession, (req, res) => {
  abortSession(req.session);
  res.json({ success: true });
});

// Multer rejects (wrong type, too large) surface here, not in the handler
// above. The fourth parameter is unused but required: Express decides this is
// error-handling middleware by counting them.
router.use((error, req, res, _next) => {
  deleteFile(req.file?.path);

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 500MB limit' });
  }

  res.status(400).json({ error: error.message });
});

export default router;
