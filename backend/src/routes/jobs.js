import express from 'express';
import { cancelJob } from '../queue.js';
import { getJob, getAllJobs, getQueueStatus, getQueuePosition } from '../queue.js';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../auth');
const jobQueue = require('../queue');

const upload = multer({ dest: 'uploads/' });

router.get('/:id', (req, res) => {
  const jobId = parseInt(req.params.id);
  const job = getJob(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const queuePosition = job.status === 'pending' ? getQueuePosition(jobId) : null;
  
  res.json({
    ...job,
    queuePosition
  });
});

router.get('/', (req, res) => {
  const allJobs = getAllJobs();
  res.json({
    total: allJobs.length,
    jobs: allJobs
  });
});

router.post('/:id/cancel', (req, res) => {
  const jobId = parseInt(req.params.id);
  const job = getJob(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (job.owner !== req.user.username && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only cancel your own jobs' });
  }
  
  const result = cancelJob(jobId);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

router.get('/queue/status', (req, res) => {
  res.json(getQueueStatus());
});

export default router;