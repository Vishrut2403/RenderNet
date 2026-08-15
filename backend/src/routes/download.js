import express from 'express';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { getJob } from '../queue.js';
import { getFilesInDirectory } from '../utils/file-utils.js';
import { verifyToken } from '../auth.js';

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
  
  req.user = {
    username: verification.username,
    role: verification.role
  };
  
  next();
}

function canAccess(job, user) {
  return job.owner === user.username || user.role === 'admin';
}

router.get('/files/render_:id/:filename', authenticateDownload, (req, res) => {
  const job = getJob(Number(req.params.id));

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!canAccess(job, req.user)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.resolve(job.outputFolder, path.basename(req.params.filename));

  if (!filePath.startsWith(path.resolve(job.outputFolder) + path.sep)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

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
    
    if (job.status !== 'completed') {
      return res.status(400).json({
        error: `Cannot download files. Job status: ${job.status}`,
        details: 'Wait for job to complete before downloading'
      });
    }
    
    if (!fs.existsSync(job.outputFolder)) {
      return res.status(404).json({
        error: 'No files found',
        details: 'Files may have been cleaned up (48 hour limit)'
      });
    }
    
    const files = getFilesInDirectory(job.outputFolder);
    
    if (files.length === 0) {
      return res.status(404).json({ error: 'No rendered files found' });
    }
    
    res.json({
      jobId,
      outputFolder: job.outputFolder,
      totalFiles: files.length,
      files: files.map(filename => ({
        filename,
        url: `/api/download/files/render_${jobId}/${filename}?token=${req.query.token || ''}`
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
    
    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Job not completed yet' });
    }
    
    if (!fs.existsSync(job.outputFolder)) {
      return res.status(404).json({ error: 'Output folder not found' });
    }
    
    console.log(`Creating ZIP for job ${jobId} (user: ${req.user.username})`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.attachment(`render_${jobId}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    
    archive.pipe(res);
    
    archive.directory(job.outputFolder, false);

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create ZIP' });
      }
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