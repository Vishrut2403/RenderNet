import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dataPath } from './paths.js';

const DIRECTORY = 'assets';

export function assetsDir(job) {
  return dataPath(job.outputFolder, DIRECTORY);
}

export function assetFilename(storedPath, originalName) {
  const stem = crypto.createHash('sha1').update(storedPath).digest('hex').slice(0, 12);

  return stem + path.extname(originalName || storedPath).toLowerCase();
}

export function assetPath(job, storedPath, originalName) {
  return path.join(assetsDir(job), assetFilename(storedPath, originalName));
}

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
