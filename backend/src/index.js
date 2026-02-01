import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ensureDir } from './utils/file-utils.js';
import { findBlenderExecutable } from './utils/blender-check.js';
import { cleanupOldFiles } from './cleanup.js';
import authRouter from './routes/auth.js'
import { requireAuth } from './auth.js';
import uploadRouter from './routes/upload.js';
import jobsRouter from './routes/jobs.js';
import downloadRouter from './routes/download.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: '*', 
  credentials: true
}));
app.use(express.json());

app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!' });
});

ensureDir('uploads');
ensureDir('renders');

const blenderPath = findBlenderExecutable();
if (!blenderPath) {
  console.error('WARNING: Blender not found! Renders will fail.');
  console.error('Make sure Blender is installed and in your PATH');
} else {
  console.log('Blender found:', blenderPath);
}


app.use('/api/auth', authRouter);
app.use('/api/upload', requireAuth, uploadRouter);
app.use('/api/jobs', requireAuth, jobsRouter);
app.use('/api/download', requireAuth, downloadRouter);

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    blenderAvailable: !!blenderPath
  });
});

app.get('/api/cleanup-test', (req, res) => {
  cleanupOldFiles();
  res.json({ message: 'Cleanup triggered' });
});

cleanupOldFiles();

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; 
setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
console.log('Auto-cleanup scheduled (runs every 24 hours, deletes files older than 48 hours)');

app.listen(PORT, () => {
  console.log(`Render Farm started.
    Port: ${PORT}  , BlenderPath: ${blenderPath ? 'Found': 'Not Found'} `);
});