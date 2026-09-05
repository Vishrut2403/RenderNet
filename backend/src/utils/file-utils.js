import crypto from 'crypto';
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

// Streamed rather than read whole: an upload may be gigabytes, and this runs on
// the request that finishes one.
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const reading = fs.createReadStream(filePath);

    reading.on('error', reject);
    reading.on('data', chunk => hash.update(chunk));
    reading.on('end', () => resolve(hash.digest('hex')));
  });
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

// Files only: a tiled still keeps its pieces in a folder beside them, and a
// directory name in the listing would be offered as a download and added to
// the ZIP as one.
export function getFilesInDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name);
  } catch (error) {
    console.error(`Failed to read directory ${dirPath}:`, error.message);
    return [];
  }
}