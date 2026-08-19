// The ids go straight to Blender's -E flag, so they are its identifiers rather
// than names of our own - it has renamed EEVEE's twice across 4.x and 5.x. The
// labels live here too so the upload form cannot drift from what is accepted.
export const ENGINES = [
  { id: 'CYCLES', label: 'Cycles — physically based, slower' },
  { id: 'BLENDER_EEVEE', label: 'EEVEE — real-time, much faster' },
  { id: 'BLENDER_WORKBENCH', label: 'Workbench — preview quality' }
];

export const ENGINE_IDS = ENGINES.map(engine => engine.id);
