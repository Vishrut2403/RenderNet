import fs from 'fs';

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch (error) {
    console.error(`Failed to delete ${filePath}:`, error.message);
  }
  return false;
}

// Null when the check itself fails: a farm that stops rendering because it
// could not read the filesystem is worse than one that tries and fails loudly.
export function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch (error) {
    console.error(`Could not measure free space on ${dir}:`, error.message);
    return null;
  }
}

export function getFilesInDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath);
  } catch (error) {
    console.error(`Failed to read directory ${dirPath}:`, error.message);
    return [];
  }
}