import { execSync } from 'child_process';

export function findBlenderExecutable() {
  try {
    const command = process.platform === 'win32' ? 'where blender' : 'which blender';
    const result = execSync(command).toString().split('\n')[0].trim();
    return result || null;
  } catch {
    console.error('Blender not found in PATH');
    return null;
  }
}