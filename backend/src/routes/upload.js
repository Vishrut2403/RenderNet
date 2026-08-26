import express from 'express';
import multer from 'multer';
import path from 'path';
import { deleteFile, freeBytes } from '../utils/file-utils.js';
import { addToQueue, getJob } from '../queue.js';
import { DATA_DIR, UPLOADS_DIR, USER_QUOTA_BYTES, MIN_FREE_BYTES } from '../paths.js';
import { usageFor } from '../queue.js';
import { ENGINE_IDS } from '../engines.js';
import {
  FORMAT_IDS, normaliseFormats, EXR_CODEC_IDS, EXR_DEPTH_IDS,
  DEFAULT_EXR_CODEC, DEFAULT_EXR_DEPTH, DEFAULT_JPEG_QUALITY
} from '../formats.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
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

router.post('/', roomOnDisk, withinQuota, upload.single('blend'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const start = Number(req.body.frameStart);
    const end = Number(req.body.frameEnd);

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return res.status(400).json({ error: 'frameStart and frameEnd must be integers' });
    }

    if (start < 0 || end < start) {
      return res.status(400).json({ error: 'Frame range must be positive and end must not precede start' });
    }

    if (end - start + 1 > MAX_FRAMES) {
      return res.status(400).json({ error: `Frame range exceeds the ${MAX_FRAMES} frame limit` });
    }

    const renderEngine = req.body.renderEngine || 'CYCLES';

    if (!ENGINE_IDS.includes(renderEngine)) {
      return res.status(400).json({ error: `Unsupported render engine: ${renderEngine}` });
    }

    const { bytes } = usageFor(req.user.username, { fresh: true });

    if (bytes + req.file.size > USER_QUOTA_BYTES) {
      deleteFile(req.file.path);
      return res.status(413).json({
        error: `That would put you at ${gigabytes(bytes + req.file.size)} of your `
          + `${gigabytes(USER_QUOTA_BYTES)}. Delete a finished job first.`
      });
    }

    const resolution = optionalInteger(req.body.resolutionPercent, { min: 1, max: 100 });

    if (!resolution.ok) {
      deleteFile(req.file.path);
      return res.status(400).json({ error: 'resolutionPercent must be a whole number from 1 to 100' });
    }

    const samples = optionalInteger(req.body.samples, { min: 1, max: MAX_SAMPLES });

    if (!samples.ok) {
      deleteFile(req.file.path);
      return res.status(400).json({ error: `samples must be a whole number from 1 to ${MAX_SAMPLES}` });
    }

    // Sent as one comma-separated field: a repeated field arrives as a string
    // when one box is ticked and an array when several are, and that is a
    // needless difference to handle.
    const chosen = (req.body.formats ?? 'PNG').split(',').map(id => id.trim()).filter(Boolean);
    const formats = normaliseFormats(chosen);

    if (formats.length === 0 || chosen.some(id => !FORMAT_IDS.includes(id))) {
      deleteFile(req.file.path);
      return res.status(400).json({
        error: `Pick at least one output format from ${FORMAT_IDS.join(', ')}`
      });
    }

    const exrCodec = req.body.exrCodec || DEFAULT_EXR_CODEC;
    const exrDepth = String(req.body.exrDepth || DEFAULT_EXR_DEPTH);

    if (!EXR_CODEC_IDS.includes(exrCodec) || !EXR_DEPTH_IDS.includes(exrDepth)) {
      deleteFile(req.file.path);
      return res.status(400).json({
        error: `OpenEXR takes one of ${EXR_CODEC_IDS.join(', ')} at ${EXR_DEPTH_IDS.join(' or ')} bits`
      });
    }

    const jpegQuality = optionalInteger(req.body.jpegQuality, { min: 1, max: 100 });

    if (!jpegQuality.ok) {
      deleteFile(req.file.path);
      return res.status(400).json({ error: 'jpegQuality must be a whole number from 1 to 100' });
    }

    const jobId = addToQueue({
      filePath: path.join('uploads', req.file.filename),
      frameStart: start,
      frameEnd: end,
      renderEngine,
      owner: req.user.username,
      originalFilename: path.basename(req.file.originalname),
      priority: Number(req.body.priority) === 1 ? 1 : 0,
      resolutionPercent: resolution.value ?? 100,
      samples: samples.value,
      formats: formats.join(','),
      exrCodec,
      exrDepth,
      jpegQuality: jpegQuality.value ?? DEFAULT_JPEG_QUALITY
    });

    res.json({
      success: true,
      message: 'Job added to render queue',
      jobId,
      // Null when it started straight away, or when nothing has been rendered
      // yet to work an estimate from.
      startsIn: getJob(jobId)?.startsIn ?? null
    });

  } catch (error) {
    console.error('Upload error:', error);
    deleteFile(req.file?.path);
    res.status(500).json({ error: error.message });
  }
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