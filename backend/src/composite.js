// Putting a tiled still back together. Blender does it rather than an image
// library: it is already required to render at all, it ships numpy, and it can
// write whatever format the job asked for.
import fs from 'fs';
import path from 'path';
import { launch } from './utils/process-control.js';
import { findBlenderExecutable } from './utils/blender-check.js';
import { saveJob } from './db.js';
import { jobs } from './job-store.js';
import { forgetUsage } from './storage.js';
import { dataPath } from './paths.js';
import { primaryOf, extensionOf } from './formats.js';
import { GRID_PYTHON, TILES_DIR, tileName } from './tiles.js';

// Read raw and written raw: the tiles already carry whatever view transform the
// render applied, so putting them through colour management again would shift
// every pixel.
const COMPOSITE_SCRIPT = `import bpy, os, json
import numpy
${GRID_PYTHON}

spec = json.loads(os.environ['RENDERNET_TILE_SPEC'])
scene = bpy.context.scene
width, height = frame_size(scene)

canvas = numpy.zeros((height, width, 4), dtype=numpy.float32)
canvas[:, :, 3] = 1.0

for index, filepath in enumerate(spec['tiles'], start=1):
    region = region_of(index, spec['count'], width, height)
    tile = bpy.data.images.load(filepath)
    tile.colorspace_settings.name = 'Non-Color'

    pixels = numpy.empty(len(tile.pixels), dtype=numpy.float32)
    tile.pixels.foreach_get(pixels)
    pixels = pixels.reshape(tile.size[1], tile.size[0], 4)

    if tile.size[0] != region['width'] or tile.size[1] != region['height']:
        raise SystemExit(
            'Tile %d is %dx%d, expected %dx%d'
            % (index, tile.size[0], tile.size[1], region['width'], region['height'])
        )

    # Blender counts rows from the bottom, which is also how the region was
    # measured, so the tile drops straight in.
    canvas[region['y0']:region['y1'], region['x0']:region['x1']] = pixels
    bpy.data.images.remove(tile)

out = bpy.data.images.new('rendernet_composite', width=width, height=height, alpha=True)
out.colorspace_settings.name = 'Non-Color'
out.pixels.foreach_set(canvas.ravel())
out.file_format = spec['format']
out.filepath_raw = spec['output']
out.save()
`;

let queued = Promise.resolve();

export function isTiled(job) {
  return Number.isInteger(job?.tiles) && job.tiles > 1;
}

export function compositeName(job) {
  return `frame_${String(job.frameStart).padStart(4, '0')}${extensionOf(primaryOf(job.formats))}`;
}

export function startComposite(jobId, onDone) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.composite = 'running';
  saveJob(job);

  queued = queued
    .then(() => assemble(job))
    .then(error => finish(jobId, error, onDone))
    .catch(error => finish(jobId, error.message, onDone));
}

function finish(jobId, error, onDone) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.composite = error ? 'failed' : 'ready';
  saveJob(job);

  if (error) console.error(`Job ${jobId}: could not put the tiles together: ${error}`);
  else {
    forgetUsage(job.owner);
    console.log(`Job ${jobId}: tiles put together`);
  }

  onDone?.(error ?? null);
}

function assemble(job) {
  return new Promise(resolve => {
    const blender = findBlenderExecutable();

    if (!blender) return resolve('This machine has no Blender to put the tiles together with');

    const outputDir = dataPath(job.outputFolder);
    const tilesDir = path.join(outputDir, TILES_DIR);
    // Beside the tiles, not beside the picture: a crash here would otherwise
    // leave a .py file in what the job hands back.
    const script = path.join(tilesDir, `composite_${job.id}.py`);
    const extension = extensionOf(primaryOf(job.formats));

    const tiles = [];

    for (let index = 1; index <= job.tiles; index++) {
      const file = path.join(tilesDir, tileName(index) + extension);

      if (!fs.existsSync(file)) return resolve(`Tile ${index} of ${job.tiles} is missing`);

      tiles.push(file);
    }

    fs.writeFileSync(script, COMPOSITE_SCRIPT);

    const spec = {
      tiles,
      count: job.tiles,
      format: primaryOf(job.formats),
      output: path.join(outputDir, compositeName(job))
    };

    const child = launch(blender, [
      '-b', dataPath(job.filePath),
      '--factory-startup',
      '-noaudio',
      '-P', script
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RENDERNET_TILE_SPEC: JSON.stringify(spec) }
    });

    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });

    child.on('error', error => resolve(error.message));
    child.on('close', code => {
      fs.rmSync(script, { force: true });

      if (code !== 0) return resolve(lastLine(output) || `Blender exited with code ${code}`);
      if (!fs.existsSync(spec.output)) return resolve('Blender wrote no composite');

      resolve(null);
    });
  });
}

function lastLine(output) {
  return output.split('\n').map(line => line.trim()).filter(Boolean).pop() ?? '';
}
