import fs from 'fs';
import path from 'path';
import { ensureDir, hashFile } from './utils/file-utils.js';
import { UPLOADS_DIR, dataPath } from './paths.js';

// A scene is kept under the hash of its bytes, in a directory of its own so the
// file still carries the name the artist gave it. The same file sent again - a
// second frame range of one shot, a re-run, two people handed the same scene -
// lands on the directory already there and is stored once.

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

    // Wanted again now, so the retention sweep counts its age from this upload
    // rather than from whenever the first one happened to be.
    const now = new Date();
    try {
      fs.utimesSync(path.join(directory, held), now, now);
      fs.utimesSync(directory, now, now);
    } catch {
      // Only means the sweep may take it earlier than it should.
    }

    return { filePath: path.join('uploads', hash, held) };
  }

  const name = nameFor(originalName);

  fs.mkdirSync(directory, { recursive: true });
  fs.renameSync(arrivedAt, path.join(directory, name));

  return { filePath: path.join('uploads', hash, name) };
}

// Scenes stored before they were content-addressed sit straight in uploads/ and
// are removed on their own; everything since owns the directory it is in.
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
