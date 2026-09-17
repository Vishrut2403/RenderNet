import express from 'express';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { getJob } from '../job-views.js';
import { getFilesInDirectory } from '../utils/file-utils.js';
import { verifyToken, mustChangePassword, requireAuth } from '../auth.js';
import { mintDownloadToken, readDownloadToken } from '../download-tokens.js';
import { getLatestDoneFrame } from '../db.js';
import { PREVIEWABLE_EXTENSIONS } from '../formats.js';
import { videoName } from '../video.js';
import { isTiled, compositeName } from '../tiles.js';
import { dataPath, RETENTION_DAYS } from '../paths.js';

const router = express.Router();

function authenticateDownload(req, res, next) {
  const header = req.headers.authorization?.replace('Bearer ', '');

  if (header) {
    const verification = verifyToken(header);

    if (!verification.valid) {
      return res.status(401).json({ error: verification.error });
    }

    if (mustChangePassword(verification.username)) {
      return res.status(403).json({
        error: 'Choose a new password before using RenderNet',
        mustChangePassword: true
      });
    }

    req.user = { username: verification.username, role: verification.role };
    return next();
  }

  const scoped = readDownloadToken(req.query.token);

  if (!scoped) {
    return res.status(401).json({ error: 'No valid download token provided' });
  }

  req.user = { username: scoped.username, role: 'user' };
  req.scopedJobId = scoped.jobId;

  next();
}

function canAccess(job, req) {
  if (req.scopedJobId !== undefined) return req.scopedJobId === job.id;

  return job.owner === req.user.username || req.user.role === 'admin';
}

router.post('/:id/token', requireAuth, (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.owner !== req.user.username && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json(mintDownloadToken(job.id, req.user.username));
});

function deliveredFrames(job) {
  if (job.status === 'completed') return true;
  return job.status === 'failed' && job.completedFrames > 0;
}

router.get('/files/render_:id/:filename', authenticateDownload, (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const outputFolder = dataPath(job.outputFolder);
  const filePath = path.resolve(outputFolder, path.basename(req.params.filename));

  if (!filePath.startsWith(outputFolder + path.sep)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.sendFile(filePath);
});

router.get('/:id/preview', authenticateDownload, (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const latest = isTiled(job)
    ? (job.composite === 'ready'
      ? { filename: compositeName(job), frame: job.frameStart }
      : null)
    : getLatestDoneFrame(job.id);

  if (!latest) {
    return res.status(404).json({ error: 'No frame rendered yet' });
  }

  const outputFolder = dataPath(job.outputFolder);
  const filePath = path.resolve(outputFolder, path.basename(latest.filename));

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Frame is no longer on disk' });
  }

  res.setHeader('X-Frame-Number', String(latest.frame));
  res.sendFile(filePath);
});

router.get('/:id/files', authenticateDownload, (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const job = getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (!canAccess(job, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!deliveredFrames(job)) {
      return res.status(400).json({
        error: `Cannot download files. Job status: ${job.status}`,
        details: 'Wait for the job to finish before downloading'
      });
    }

    if (!fs.existsSync(dataPath(job.outputFolder))) {
      return res.status(404).json({
        error: 'No files found',
        details: `Files are removed after ${RETENTION_DAYS} days`
      });
    }
    
    const files = getFilesInDirectory(dataPath(job.outputFolder));
    
    if (files.length === 0) {
      return res.status(404).json({ error: 'No rendered files found' });
    }
    
    res.json({
      jobId,
      outputFolder: job.outputFolder,
      totalFiles: files.length,
      partial: job.status !== 'completed',
      files: files.map(filename => ({
        filename,
        previewable: PREVIEWABLE_EXTENSIONS.includes(path.extname(filename).toLowerCase()),
        path: `/download/files/render_${jobId}/${encodeURIComponent(filename)}`
      }))
    });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});


router.get('/:id/video', authenticateDownload, (req, res) => {
  const jobId = Number(req.params.id);
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const file = dataPath(job.outputFolder, videoName(jobId));

  if (job.video !== 'ready' || !fs.existsSync(file)) {
    return res.status(404).json({ error: `Job ${jobId} has no video` });
  }

  res.download(file);
});

router.get('/:id/zip', authenticateDownload, (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const job = getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (!canAccess(job, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!deliveredFrames(job)) {
      return res.status(400).json({ error: 'Job has no finished frames to download' });
    }

    if (!fs.existsSync(dataPath(job.outputFolder))) {
      return res.status(404).json({ error: 'Output folder not found' });
    }

    const partial = job.status !== 'completed';

    console.log(`Creating ZIP for job ${jobId} (user: ${req.user.username})`);

    const archive = archiver('zip', { zlib: { level: 9 } });

    res.attachment(partial ? `render_${jobId}_partial.zip` : `render_${jobId}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    
    archive.pipe(res);

    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });

    const folder = dataPath(job.outputFolder);

    for (const filename of getFilesInDirectory(folder)) {
      archive.file(path.join(folder, filename), { name: filename });
    }

    archive.on('error', (err) => {
      console.error('Archive error:', err);

      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create ZIP' });
        return;
      }

      res.destroy(err);
    });
    
    archive.on('end', () => {
      console.log(`ZIP completed for job ${jobId}`);
    });
    
    archive.finalize();
    
  } catch (error) {
    console.error('ZIP download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download' });
    }
  }
});

export default router;