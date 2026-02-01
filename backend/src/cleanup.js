import fs from 'fs';
import path from 'path';

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
    const rendersDir = 'renders';
    if (fs.existsSync(rendersDir)) {
      const renderFolders = fs.readdirSync(rendersDir);
      let deletedRenders = 0;
      
      renderFolders.forEach(folder => {
        const folderPath = path.join(rendersDir, folder);
        const stats = fs.statSync(folderPath);
        
        if (stats.mtimeMs < fortyEightHoursAgo) {
          fs.rmSync(folderPath, { recursive: true, force: true });
          deletedRenders++;
          console.log(`   🗑️ Deleted old render folder: ${folder}`);
        }
      });
      
      if (deletedRenders > 0) {
        console.log(`Cleaned ${deletedRenders} old render folder(s)`);
      }
    }
    
    console.log('Cleanup complete!');
    
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

export function forceCleanup() {
  console.log('FORCE CLEANUP - Deleting ALL files');
}