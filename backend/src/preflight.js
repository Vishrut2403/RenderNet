import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { findBlenderExecutable } from './utils/blender-check.js';

const MARKER = 'RENDERNET_PREFLIGHT ';
const TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 120 * 1000;
const REPORTED = 8;

// Walked datablock by datablock rather than through blend_paths, which also
// reports Blender's own bundled assets - stored relative to the .blend, so they
// resolve somewhere else entirely once a file is uploaded, and every scene
// would look broken. Packed files are skipped because packing is the fix being
// asked for.
const SCRIPT = `import bpy, os, json


def referenced():
    data = bpy.data

    for image in data.images:
        if image.source in {'FILE', 'SEQUENCE', 'MOVIE', 'TILED'}:
            yield image

    for group in (data.libraries, data.sounds, data.movieclips, data.volumes,
                  data.cache_files, data.fonts):
        for block in group:
            yield block


missing = []

for block in referenced():
    if getattr(block, 'packed_file', None):
        continue

    stored = block.filepath

    if not stored or stored == '<builtin>':
        continue

    resolved = os.path.normpath(
        bpy.path.native_pathsep(bpy.path.abspath(stored, library=block.library)))

    if not os.path.exists(resolved):
        missing.append(resolved)

print('${MARKER}' + json.dumps({'missing': sorted(set(missing))}))
`;

function parse(output) {
  const line = output.split('\n').reverse().find(text => text.includes(MARKER));

  if (!line) return null;

  try {
    return JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length));
  } catch {
    return null;
  }
}

// A scene that reaches for files it did not bring renders untextured rather
// than failing, which is worth catching before 500 frames of it. Anything that
// goes wrong with the check itself lets the job through: a broken preflight
// must not be able to stop the farm.
export function checkAssets(blendPath) {
  return new Promise(resolve => {
    const blender = findBlenderExecutable();

    if (!blender) return resolve({ checked: false, missing: [] });

    const scriptPath = path.join(os.tmpdir(), `rendernet-preflight-${process.pid}.py`);
    fs.writeFileSync(scriptPath, SCRIPT);

    const probe = spawn(blender, ['-b', blendPath, '-P', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    probe.stdout.on('data', chunk => { output += chunk; });
    probe.stderr.on('data', chunk => { output += chunk; });

    const done = result => {
      clearTimeout(timer);
      fs.rmSync(scriptPath, { force: true });
      resolve(result);
    };

    const timer = setTimeout(() => {
      probe.kill('SIGKILL');
      console.warn(`Asset check for ${path.basename(blendPath)} timed out; rendering anyway`);
      done({ checked: false, missing: [] });
    }, TIMEOUT_MS);

    timer.unref?.();

    probe.on('error', error => {
      console.warn(`Asset check could not run: ${error.message}`);
      done({ checked: false, missing: [] });
    });

    probe.on('close', () => {
      const report = parse(output);

      if (!report) {
        console.warn(`Asset check for ${path.basename(blendPath)} said nothing; rendering anyway`);
        return done({ checked: false, missing: [] });
      }

      done({ checked: true, missing: report.missing });
    });
  });
}

export function missingAssetsMessage(missing) {
  const shown = missing.slice(0, REPORTED).map(file => path.basename(file));
  const rest = missing.length - shown.length;

  return `${missing.length} file${missing.length === 1 ? '' : 's'} the scene needs `
    + `${missing.length === 1 ? 'is' : 'are'} not packed into it and not on this machine: `
    + `${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}. `
    + 'In Blender: File → External Data → Pack Resources, save, and upload again.';
}
