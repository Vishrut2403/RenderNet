import fs from 'fs';
import path from 'path';
import { ensureDir, hashFile } from './utils/file-utils.js';
import { UPLOADS_DIR, dataPath } from './paths.js';


function nameFor(originalName) {
  const name = path.basename(originalName || '');

  return name && name !== '.' && name !== '..' ? name : 'scene.blend';
}

function fileIn(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .find(entry => entry.isFile())?.name ?? null;
  } catch {
    return null;
  }
}

export async function storeBlend(arrivedAt, originalName) {
  ensureDir(UPLOADS_DIR);

  const hash = await hashFile(arrivedAt);
  const directory = path.join(UPLOADS_DIR, hash);
  const held = fileIn(directory);

  if (held) {
    fs.rmSync(arrivedAt, { force: true });

    const now = new Date();
    try {
      fs.utimesSync(path.join(directory, held), now, now);
      fs.utimesSync(directory, now, now);
    } catch {
    }

    return { filePath: path.join('uploads', hash, held) };
  }

  const name = nameFor(originalName);

  fs.mkdirSync(directory, { recursive: true });
  fs.renameSync(arrivedAt, path.join(directory, name));

  return { filePath: path.join('uploads', hash, name) };
}

export function removeBlend(filePath) {
  const target = dataPath(filePath);
  const inside = path.relative(UPLOADS_DIR, target).split(path.sep);

  if (inside.length === 2) fs.rmSync(path.dirname(target), { recursive: true, force: true });
  else fs.unlinkSync(target);
}

export function blendDirectory(filePath) {
  const target = dataPath(filePath);

  return path.relative(UPLOADS_DIR, target).split(path.sep).length === 2
    ? path.dirname(target)
    : null;
}
