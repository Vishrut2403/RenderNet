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

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const reading = fs.createReadStream(filePath);

    reading.on('error', reject);
    reading.on('data', chunk => hash.update(chunk));
    reading.on('end', () => resolve(hash.digest('hex')));
  });
}

export function startsWith(filePath, bytes) {
  let handle = null;

  try {
    const head = Buffer.alloc(bytes.length);

    handle = fs.openSync(filePath, 'r');

    return fs.readSync(handle, head, 0, bytes.length, 0) === bytes.length
      && head.equals(Buffer.from(bytes));
  } catch {
    return false;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

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
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name);
  } catch (error) {
    console.error(`Failed to read directory ${dirPath}:`, error.message);
    return [];
  }
}