import express from 'express';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { getJob } from '../queue.js';
import { getFilesInDirectory } from '../utils/file-utils.js';
import { verifyToken, mustChangePassword } from '../auth.js';
import { getLatestDoneFrame } from '../db.js';
import { PREVIEWABLE_EXTENSIONS } from '../formats.js';
import { dataPath, RETENTION_DAYS } from '../paths.js';

const router = express.Router();

function authenticateDownload(req, res, next) {
  let token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    token = req.query.token;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'No authentication token provided' });
  }
  
  const verification = verifyToken(token);
  
  if (!verification.valid) {
    return res.status(401).json({ error: verification.error });
  }
  
  if (mustChangePassword(verification.username)) {
    return res.status(403).json({
      error: 'Choose a new password before using RenderNet',
      mustChangePassword: true
    });
  }

  req.user = {
    username: verification.username,
    role: verification.role
  };

  next();
}

function canAccess(job, user) {
  return job.owner === user.username || user.role === 'admin';
}

// A job that stopped early keeps every frame it delivered, and those frames are
// all that stands between the user and re-rendering the whole range. Cancelled
// jobs are absent because cancelling deletes their output.
function deliveredFrames(job) {
  if (job.status === 'completed') return true;
  return job.status === 'failed' && job.completedFrames > 0;
}

router.get('/files/render_:id/:filename', authenticateDownload, (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
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

// Serves while the job is still running, unlike the listing and the ZIP below.
// The point is to catch a render going wrong at frame 30 rather than at 500,
// which is no use once it has already stopped.
router.get('/:id/preview', authenticateDownload, (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const latest = getLatestDoneFrame(job.id);

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
    
    if (!canAccess(job, req.user)) {
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
      // API-relative and without a token: the caller knows its own API origin,
      // and only it knows whether the token belongs in the URL at all.
      files: files.map(filename => ({
        filename,
        // A browser cannot show an EXR, so the caller needs to know before it
        // puts the file in an <img>.
        previewable: PREVIEWABLE_EXTENSIONS.includes(path.extname(filename).toLowerCase()),
        path: `/download/files/render_${jobId}/${encodeURIComponent(filename)}`
      }))
    });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});


router.get('/:id/zip', authenticateDownload, (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const job = getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (!canAccess(job, req.user)) {
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
    
    archive.directory(dataPath(job.outputFolder), false);

    archive.on('error', (err) => {
      console.error('Archive error:', err);

      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create ZIP' });
        return;
      }

      // Mid-stream there is no status left to change, and ending cleanly would
      // hand back a truncated ZIP that looks complete. Destroying the socket is
      // the only way left to tell the client the download is not whole.
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