import fs from 'fs';
import path from 'path';

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

export function getFilesInDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath);
  } catch (error) {
    console.error(`Failed to read directory ${dirPath}:`, error.message);
    return [];
  }
}