import express from 'express';
import multer from 'multer';
import path from 'path';
import { ensureDir } from '../utils/file-utils.js';
import { addToQueue } from '../queue.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
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

router.post('/', upload.single('blend'), (req, res) => {
  try {
    const { frameStart, frameEnd, renderEngine,username } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    if (!frameStart || !frameEnd) {
      return res.status(400).json({ error: 'frameStart and frameEnd are required' });
    }

    console.log('Received:', { frameStart, frameEnd, renderEngine, username });
    
    const jobId = Date.now();
    const outputFolder = path.join('renders', `render_${jobId}`);
    ensureDir(outputFolder);
    
    const outputPath = path.join(outputFolder, 'frame_####.png');
    
    const finalJobId = addToQueue({
      filePath: req.file.path,
      outputPath,
      outputFolder,
      frameStart: parseInt(frameStart),
      frameEnd: parseInt(frameEnd),
      renderEngine: renderEngine || 'CYCLES', 
      owner: username || 'anonymous',             
      originalFilename: req.file.originalname
    });
    
    res.json({
      success: true,
      message: 'Job added to render queue',
      jobId: finalJobId
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;