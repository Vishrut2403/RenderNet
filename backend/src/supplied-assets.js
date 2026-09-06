import crypto from 'crypto';
import path from 'path';
import { dataPath } from './paths.js';

// Inside the job's own output folder, which is what keeps a supplied file with
// the job that supplied it: the quota already counts that folder and deleting
// the job already removes it, so neither needs to learn about assets.
const DIRECTORY = 'assets';

export function assetsDir(job) {
  return dataPath(job.outputFolder, DIRECTORY);
}

// Named from the path the scene stores rather than from the file the artist
// picked: two textures called wood.png in different folders are two
// dependencies, and supplying one again should replace it rather than collide.
export function assetFilename(storedPath, originalName) {
  const stem = crypto.createHash('sha1').update(storedPath).digest('hex').slice(0, 12);

  return stem + path.extname(originalName || storedPath).toLowerCase();
}

export function assetPath(job, storedPath, originalName) {
  return path.join(assetsDir(job), assetFilename(storedPath, originalName));
}
