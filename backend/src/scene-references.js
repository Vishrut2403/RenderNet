export const REFERENCED_PYTHON = `
def referenced():
    data = bpy.data

    for image in data.images:
        if image.source in {'FILE', 'SEQUENCE', 'MOVIE', 'TILED'}:
            yield image

    for group in (data.libraries, data.sounds, data.movieclips, data.volumes,
                  data.cache_files, data.fonts):
        for block in group:
            yield block
`;

export const SUPPLIED_PYTHON = `
def apply_supplied(manifest):
    if not manifest:
        return

    with open(manifest) as handle:
        given = json.load(handle)

    for block in referenced():
        if getattr(block, 'packed_file', None) or block.filepath not in given:
            continue

        block.filepath = given[block.filepath]

        again = getattr(block, 'reload', None)

        if again:
            again()
`;
