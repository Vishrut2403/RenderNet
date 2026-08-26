import { execSync, spawnSync } from 'child_process';
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

// What this machine's Blender lists for -E. An operator who knows more than the
// build does - EEVEE wants a GL context a headless box may not give it - can
// narrow the list with WORKER_ENGINES.
export function renderableEngines(blenderPath) {
  const configured = (process.env.WORKER_ENGINES || '')
    .split(',')
    .map(engine => engine.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;

  const probe = spawnSync(blenderPath, ['-b', '--factory-startup', '-E', 'help'], {
    encoding: 'utf8',
    timeout: 60000
  });

  if (probe.status !== 0) return [];

  return probe.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[A-Z][A-Z_]+$/.test(line));
}
