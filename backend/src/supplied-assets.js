import crypto from 'crypto';
import fs from 'fs';
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

// What the scene stores against where its copy actually is, for the scripts
// that have to open the file as the render will see it. Null when the job has
// been given nothing, which is the ordinary case.
export function writeManifest(job, assets) {
  if (assets.length === 0) return null;

  const directory = assetsDir(job);
  const manifest = path.join(directory, 'manifest.json');
  const given = Object.fromEntries(
    assets.map(asset => [asset.storedPath, path.join(directory, asset.filename)]));

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(given));

  return manifest;
}
