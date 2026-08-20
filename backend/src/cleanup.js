import fs from 'fs';
import path from 'path';
import { pruneOldJobs, getActiveJobPaths } from './queue.js';
import { purgeExpiredSessions } from './db.js';
import { UPLOADS_DIR, RENDERS_DIR, SCRATCH_DIR, RETENTION_DAYS } from './paths.js';
import { pruneOldLogs } from './logger.js';

// The workstation is switched off nightly, so in practice this gets one pass. A
// file that disappears mid-pass must not cost the rest of it.
function expired(target, cutoff) {
  try {
    return fs.statSync(target).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

export function cleanupOldFiles() {
  const now = Date.now();
  // A backstop for files nobody came back for; the per-user quota is the limit.
  const cutoff = now - (RETENTION_DAYS * 24 * 60 * 60 * 1000);

  console.log('Starting cleanup process...');

  try {
    // A job can sit queued for longer than the cutoff, and deleting by age alone
    // would take its .blend before it renders.
    const active = getActiveJobPaths();
    const uploadsDir = UPLOADS_DIR;
    if (fs.existsSync(uploadsDir)) {
      const uploadFiles = fs.readdirSync(uploadsDir);
      let deletedUploads = 0;
      
      uploadFiles.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        if (active.has(path.resolve(filePath))) return;
        if (!expired(filePath, cutoff)) return;

        try {
          fs.unlinkSync(filePath);
          deletedUploads++;
          console.log(`   🗑️ Deleted old upload: ${file}`);
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
          console.log(`   🗑️ Deleted old folder: ${folderPath}`);
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

    if (prunedJobs || prunedSessions) {
      console.log(`Pruned ${prunedJobs} job record(s) and ${prunedSessions} expired session(s)`);
    }

    if (prunedLogs) {
      console.log(`Pruned ${prunedLogs} old log file(s)`);
    }

    console.log('Cleanup complete!');

  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}
