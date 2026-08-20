import { execSync } from 'child_process';
import fs from 'fs';

export function findBlenderExecutable() {
  // A configured path wins, so the server and the render worker never disagree
  // about which binary is in play - a health check reporting no Blender while
  // renders succeed is worse than no health check.
  if (process.env.BLENDER_PATH) {
    return fs.existsSync(process.env.BLENDER_PATH) ? process.env.BLENDER_PATH : null;
  }

  try {
    const command = process.platform === 'win32' ? 'where blender' : 'which blender';
    const result = execSync(command).toString().split('\n')[0].trim();
    return result || null;
  } catch {
    console.error('Blender not found in PATH');
    return null;
  }
}