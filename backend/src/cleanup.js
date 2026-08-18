import fs from 'fs';
import path from 'path';
import { pruneOldJobs, getActiveJobPaths } from './queue.js';
import { purgeExpiredSessions } from './db.js';
import { UPLOADS_DIR, RENDERS_DIR, SCRATCH_DIR, RETENTION_DAYS } from './paths.js';

export function cleanupOldFiles() {
  const now = Date.now();
  // A backstop for files nobody came back for, not the main limit - people are
  // expected to delete their own jobs once they have downloaded them, and the
  // per-user quota is what actually keeps the disk in check.
  const cutoff = now - (RETENTION_DAYS * 24 * 60 * 60 * 1000);

  console.log('Starting cleanup process...');

  try {
    // A job can sit in the queue for longer than the cutoff; deleting by age
    // alone would take its .blend away before it ever renders.
    const active = getActiveJobPaths();
    const uploadsDir = UPLOADS_DIR;
    if (fs.existsSync(uploadsDir)) {
      const uploadFiles = fs.readdirSync(uploadsDir);
      let deletedUploads = 0;
      
      uploadFiles.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        if (active.has(path.resolve(filePath))) return;

        const stats = fs.statSync(filePath);

        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          deletedUploads++;
          console.log(`   🗑️ Deleted old upload: ${file}`);
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

        const stats = fs.statSync(folderPath);

        if (stats.mtimeMs < cutoff) {
          fs.rmSync(folderPath, { recursive: true, force: true });
          deleted++;
          console.log(`   🗑️ Deleted old folder: ${folderPath}`);
        }
      });

      if (deleted > 0) {
        console.log(`Cleaned ${deleted} old folder(s) from ${dir}`);
      }
    });
    
    const prunedJobs = pruneOldJobs(cutoff);
    const prunedSessions = purgeExpiredSessions();

    if (prunedJobs || prunedSessions) {
      console.log(`Pruned ${prunedJobs} job record(s) and ${prunedSessions} expired session(s)`);
    }

    console.log('Cleanup complete!');

  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}
