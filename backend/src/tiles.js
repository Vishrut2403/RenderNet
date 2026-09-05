// A still that would take one machine all night, cut into regions the farm can
// render at the same time. Each region is an ordinary unit of work - claimed,
// retried and counted like a frame - and the pieces are put back together once
// they have all arrived.
import path from 'path';
import { primaryOf, extensionOf } from './formats.js';

export const MAX_TILES = 16;
export const TILES_DIR = 'tiles';

// As square as the count allows: a 4-tile job is 2x2 rather than 4x1, because a
// region the full width of the frame saves less of the work than a compact one.
export function gridFor(count) {
  let columns = Math.round(Math.sqrt(count));

  while (columns > 1 && count % columns !== 0) columns--;

  return { columns, rows: count / columns };
}

export function tileName(index) {
  return `tile_${String(index).padStart(4, '0')}`;
}

export function tilesPath(outputFolder) {
  return path.join(outputFolder, TILES_DIR);
}

export function isTiled(job) {
  return Number.isInteger(job?.tiles) && job.tiles > 1;
}

// What the finished picture is called: the one frame of the scene it is, in the
// format the job asked for, beside the regions it was made from.
export function compositeName(job) {
  return `frame_${String(job.frameStart).padStart(4, '0')}${extensionOf(primaryOf(job.formats))}`;
}

// The same arithmetic has to be used twice - once to tell Blender which region
// to render, and once to put the pieces back - and only Blender knows the
// frame's size in pixels, so it is written here in Python for both to import.
// Regions meet on whole pixels: fractions alone would leave a seam wherever
// Blender's own rounding disagreed with ours.
export const GRID_PYTHON = `
def grid_for(count):
    columns = round(count ** 0.5)
    while columns > 1 and count % columns:
        columns -= 1
    return columns, count // columns


def region_of(index, count, width, height):
    columns, rows = grid_for(count)
    column = (index - 1) % columns
    row = (index - 1) // columns

    x0 = round(column * width / columns)
    x1 = round((column + 1) * width / columns)
    y0 = round(row * height / rows)
    y1 = round((row + 1) * height / rows)

    return {
        'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1,
        'width': x1 - x0, 'height': y1 - y0,
    }


def frame_size(scene):
    percent = scene.render.resolution_percentage / 100
    return (round(scene.render.resolution_x * percent),
            round(scene.render.resolution_y * percent))
`;

// Read raw and written raw: the tiles already carry whatever view transform
// the render applied, so putting them through colour management again would
// shift every pixel.
export const COMPOSITE_SCRIPT = `import bpy, os, json
import numpy
${GRID_PYTHON}

spec = json.loads(os.environ['RENDERNET_TILE_SPEC'])
scene = bpy.context.scene

# A fresh Blender reading the scene as it was saved, while the tiles were
# rendered at whatever the job asked for. Same rule as sceneOverrides applies.
percent = spec.get('resolutionPercent')

if percent and percent != 100:
    scene.render.resolution_percentage = percent

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
