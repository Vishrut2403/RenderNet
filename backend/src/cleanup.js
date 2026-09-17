import fs from 'fs';
import path from 'path';
import { pruneOldJobs } from './queue.js';
import { getActiveJobPaths } from './storage.js';
import { purgeExpiredSessions } from './db.js';
import { UPLOADS_DIR, RENDERS_DIR, SCRATCH_DIR, RETENTION_DAYS } from './paths.js';
import { pruneOldLogs } from './logger.js';
import { sweepPartials } from './upload-sessions.js';

function expired(target, cutoff) {
  try {
    return fs.statSync(target).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

function sceneAge(target) {
  try {
    const stats = fs.statSync(target);

    if (!stats.isDirectory()) return stats.mtimeMs;

    const inside = fs.readdirSync(target)
      .map(name => fs.statSync(path.join(target, name)).mtimeMs);

    return inside.length > 0 ? Math.max(...inside) : stats.mtimeMs;
  } catch {
    return Infinity;
  }
}

export function cleanupOldFiles() {
  const now = Date.now();
  const cutoff = now - (RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const active = getActiveJobPaths();
    const uploadsDir = UPLOADS_DIR;
    if (fs.existsSync(uploadsDir)) {
      const uploadFiles = fs.readdirSync(uploadsDir);
      let deletedUploads = 0;
      
      uploadFiles.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        if (active.has(path.resolve(filePath))) return;
        if (sceneAge(filePath) >= cutoff) return;

        try {
          fs.rmSync(filePath, { recursive: true, force: true });
          deletedUploads++;
        } catch (error) {
          console.warn(`   Could not delete ${file}: ${error.message}`);
        }
      });
      
      if (deletedUploads > 0) {
        console.log(`Cleaned ${deletedUploads} old upload(s)`);
      }
    }
    [RENDERS_DIR, SCRATCH_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) return;

      let deleted = 0;

      fs.readdirSync(dir).forEach(folder => {
        const folderPath = path.join(dir, folder);
        if (active.has(path.resolve(folderPath))) return;
        if (!expired(folderPath, cutoff)) return;

        try {
          fs.rmSync(folderPath, { recursive: true, force: true });
          deleted++;
        } catch (error) {
          console.warn(`   Could not delete ${folderPath}: ${error.message}`);
        }
      });

      if (deleted > 0) {
        console.log(`Cleaned ${deleted} old folder(s) from ${dir}`);
      }
    });
    
    const prunedJobs = pruneOldJobs(cutoff);
    const prunedSessions = purgeExpiredSessions();
    const prunedLogs = pruneOldLogs();
    const prunedPartials = sweepPartials();

    if (prunedJobs || prunedSessions) {
      console.log(`Pruned ${prunedJobs} job record(s) and ${prunedSessions} expired session(s)`);
    }

    if (prunedLogs) {
      console.log(`Pruned ${prunedLogs} old log file(s)`);
    }

    if (prunedPartials) {
      console.log(`Removed ${prunedPartials} abandoned part-upload(s)`);
    }

  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}
