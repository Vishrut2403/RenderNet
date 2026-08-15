import fs from 'fs';
import path from 'path';
import { pruneOldJobs } from './queue.js';
import { purgeExpiredSessions } from './db.js';

export function cleanupOldFiles() {
  const now = Date.now();
  const fortyEightHoursAgo = now - (48 * 60 * 60 * 1000);
  
  console.log('Starting cleanup process...');
  
  try {
    const uploadsDir = 'uploads';
    if (fs.existsSync(uploadsDir)) {
      const uploadFiles = fs.readdirSync(uploadsDir);
      let deletedUploads = 0;
      
      uploadFiles.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtimeMs < fortyEightHoursAgo) {
          fs.unlinkSync(filePath);
          deletedUploads++;
          console.log(`   🗑️ Deleted old upload: ${file}`);
        }
      });
      
      if (deletedUploads > 0) {
        console.log(`Cleaned ${deletedUploads} old upload(s)`);
      }
    }
    ['renders', 'worker-tmp'].forEach(dir => {
      if (!fs.existsSync(dir)) return;

      let deleted = 0;

      fs.readdirSync(dir).forEach(folder => {
        const folderPath = path.join(dir, folder);
        const stats = fs.statSync(folderPath);

        if (stats.mtimeMs < fortyEightHoursAgo) {
          fs.rmSync(folderPath, { recursive: true, force: true });
          deleted++;
          console.log(`   🗑️ Deleted old folder: ${folderPath}`);
        }
      });

      if (deleted > 0) {
        console.log(`Cleaned ${deleted} old folder(s) from ${dir}`);
      }
    });
    
    const prunedJobs = pruneOldJobs(fortyEightHoursAgo);
    const prunedSessions = purgeExpiredSessions();

    if (prunedJobs || prunedSessions) {
      console.log(`Pruned ${prunedJobs} job record(s) and ${prunedSessions} expired session(s)`);
    }

    console.log('Cleanup complete!');

  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

export function forceCleanup() {
  console.log('FORCE CLEANUP - Deleting ALL files');
}