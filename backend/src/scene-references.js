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
