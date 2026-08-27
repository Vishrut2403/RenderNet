import { execSync } from 'child_process';
import fs from 'fs';

// Optional: a farm with no ffmpeg renders exactly as before and simply cannot
// offer a video.
export function findFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    return fs.existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : null;
  }

  try {
    const command = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    return execSync(command).toString().split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}
