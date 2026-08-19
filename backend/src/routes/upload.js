import express from 'express';
import multer from 'multer';
import path from 'path';
import { deleteFile } from '../utils/file-utils.js';
import { addToQueue } from '../queue.js';
import { UPLOADS_DIR, USER_QUOTA_BYTES } from '../paths.js';
import { usageFor } from '../queue.js';
import { ENGINES } from '../engines.js';

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

function gigabytes(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Checked before multer so somebody already at their limit is told so instead
// of waiting out a 500MB upload that will be rejected on arrival.
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

router.post('/', withinQuota, upload.single('blend'), (req, res) => {
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

    if (!ENGINES.includes(renderEngine)) {
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

    const jobId = addToQueue({
      filePath: path.join('uploads', req.file.filename),
      frameStart: start,
      frameEnd: end,
      renderEngine,
      owner: req.user.username,
      originalFilename: path.basename(req.file.originalname),
      priority: Number(req.body.priority) === 1 ? 1 : 0
    });

    res.json({
      success: true,
      message: 'Job added to render queue',
      jobId
    });

  } catch (error) {
    console.error('Upload error:', error);
    deleteFile(req.file?.path);
    res.status(500).json({ error: error.message });
  }
});

// Multer rejects (wrong type, too large) surface here, not in the handler above.
router.use((error, req, res, next) => {
  deleteFile(req.file?.path);

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 500MB limit' });
  }

  res.status(400).json({ error: error.message });
});

export default router;