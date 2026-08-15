import express from 'express';
import multer from 'multer';
import path from 'path';
import { deleteFile } from '../utils/file-utils.js';
import { addToQueue } from '../queue.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: 'uploads/',
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
    if (file.originalname.endsWith('.blend')) {
      cb(null, true);
    } else {
      cb(new Error('Only .blend files are allowed'));
    }
  }
});

const ENGINES = ['CYCLES', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'];
const MAX_FRAMES = 2000;

router.post('/', upload.single('blend'), (req, res) => {
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

    const jobId = addToQueue({
      filePath: req.file.path,
      frameStart: start,
      frameEnd: end,
      renderEngine,
      owner: req.user.username,
      originalFilename: path.basename(req.file.originalname)
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