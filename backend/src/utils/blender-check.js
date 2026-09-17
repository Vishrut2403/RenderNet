import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnPlan } from './process-control.js';

export function findBlenderExecutable() {
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

export function renderableEngines(blenderPath) {
  const configured = (process.env.WORKER_ENGINES || '')
    .split(',')
    .map(engine => engine.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;

  const plan = spawnPlan(blenderPath, ['-b', '--factory-startup', '-E', 'help']);

  const probe = spawnSync(plan.command, plan.args, {
    ...plan.options,
    encoding: 'utf8',
    timeout: 60000
  });

  if (probe.status !== 0) return [];

  return probe.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[A-Z][A-Z_]+$/.test(line));
}

const DEVICE_KINDS = ['OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'];
const DEVICE_MARKER = 'RENDERNET_DEVICES ';

const DEVICE_SCRIPT = `import bpy, json

prefs = bpy.context.preferences.addons['cycles'].preferences

try:
    prefs.refresh_devices()
except Exception:
    pass

kinds = ${JSON.stringify(DEVICE_KINDS)}
found = [kind for kind in kinds
         if any(device.type == kind for device in prefs.get_devices_for_type(kind))]

print('${DEVICE_MARKER}' + json.dumps(found))
`;

export function usableDevices(blenderPath) {
  const scriptPath = path.join(os.tmpdir(), `rendernet-devices-${process.pid}.py`);

  try {
    fs.writeFileSync(scriptPath, DEVICE_SCRIPT);

    const plan = spawnPlan(blenderPath, ['-b', '--factory-startup', '-P', scriptPath]);

    const probe = spawnSync(plan.command, plan.args, {
      ...plan.options,
      encoding: 'utf8',
      timeout: 60000
    });

    if (probe.status !== 0) return [];

    const line = (probe.stdout || '')
      .split('\n')
      .reverse()
      .find(text => text.includes(DEVICE_MARKER));

    if (!line) return [];

    const found = JSON.parse(line.slice(line.indexOf(DEVICE_MARKER) + DEVICE_MARKER.length));

    return DEVICE_KINDS.filter(kind => found.includes(kind));
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

export function chooseDevice(blenderPath) {
  const wanted = (process.env.CYCLES_DEVICE || '').trim().toUpperCase();

  if (wanted === 'CPU') return { device: 'CPU', wanted: null };

  const available = usableDevices(blenderPath);

  if (wanted && available.includes(wanted)) return { device: wanted, wanted: null };

  return { device: available[0] || 'CPU', wanted: wanted || null };
}
