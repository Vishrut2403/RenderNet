// A still that would take one machine all night, cut into regions the farm can
// render at the same time. Each region is an ordinary unit of work - claimed,
// retried and counted like a frame - and the pieces are put back together once
// they have all arrived.
import path from 'path';

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
