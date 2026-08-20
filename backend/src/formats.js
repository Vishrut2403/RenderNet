// Blender's own format identifiers, with the extension it writes for each.
// Ordered deliberately: the first one a job selects becomes its primary, and a
// browser can show a PNG or a JPEG where it cannot show an EXR.
export const FORMATS = [
  { id: 'PNG', label: 'PNG — lossless, 8-bit', extension: '.png' },
  { id: 'JPEG', label: 'JPEG — small, lossy', extension: '.jpg' },
  { id: 'OPEN_EXR', label: 'OpenEXR — 32-bit, for compositing', extension: '.exr' }
];

export const FORMAT_IDS = FORMATS.map(format => format.id);

export const PREVIEWABLE_EXTENSIONS = FORMATS
  .filter(format => format.id !== 'OPEN_EXR')
  .map(format => format.extension);

export function extensionOf(id) {
  return FORMATS.find(format => format.id === id)?.extension ?? null;
}

// Kept in the declared order rather than the order they were ticked, so the
// primary is predictable whatever the form sent.
export function normaliseFormats(ids) {
  const wanted = new Set(ids);
  return FORMAT_IDS.filter(id => wanted.has(id));
}

export function parseFormats(stored) {
  return normaliseFormats((stored || 'PNG').split(',').map(id => id.trim()).filter(Boolean));
}

export function primaryOf(stored) {
  return parseFormats(stored)[0] ?? 'PNG';
}

export function extrasOf(stored) {
  return parseFormats(stored).slice(1);
}
