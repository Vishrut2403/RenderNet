// Every datablock a scene reaches for outside itself. Shared, because two
// scripts have to agree on the answer: the one that reports what is missing
// before a job is queued, and the one that points those datablocks at the files
// the artist handed over. A walk that drifted between them would ask for a file
// and then not use it.
//
// Walked datablock by datablock rather than through blend_paths, which also
// reports Blender's own bundled assets - stored relative to the .blend, so they
// resolve somewhere else entirely once a file is uploaded, and every scene
// would look broken.
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

// Pointing those datablocks at the copies the artist handed over. Shared for
// the same reason the walk is: the check has to see the scene the render will
// see, or supplying a linked .blend would never reveal what that .blend itself
// reaches for.
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

        # A library reloaded here brings its own contents in with it, which is
        # how the walk above comes to see what it reaches for in turn.
        again = getattr(block, 'reload', None)

        if again:
            again()
`;
