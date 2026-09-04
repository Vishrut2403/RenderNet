// Blender's own format identifiers, with the extension it writes for each.
// Ordered deliberately: the first one a job selects becomes its primary, and a
// browser can show a PNG or a JPEG where it cannot show an EXR.
export const FORMATS = [
  { id: 'PNG', label: 'PNG', extension: '.png' },
  { id: 'JPEG', label: 'JPEG', extension: '.jpg' },
  { id: 'OPEN_EXR', label: 'OpenEXR', extension: '.exr' }
];

export const FORMAT_IDS = FORMATS.map(format => format.id);

// A useful few of Blender's eleven: lossless by default, one lossy choice for
// when the frames are only ever going to be watched.
export const EXR_CODECS = [
  { id: 'ZIP', label: 'ZIP' },
  { id: 'PIZ', label: 'PIZ' },
  { id: 'DWAA', label: 'DWAA' },
  { id: 'NONE', label: 'None' }
];

export const EXR_DEPTHS = [
  { id: '16', label: '16-bit half' },
  { id: '32', label: '32-bit full' }
];

export const EXR_CODEC_IDS = EXR_CODECS.map(codec => codec.id);
export const EXR_DEPTH_IDS = EXR_DEPTHS.map(depth => depth.id);

export const DEFAULT_EXR_CODEC = 'ZIP';
// Half rather than the 32-bit a scene usually carries: the same picture at half
// the bytes, and the farm is shared.
export const DEFAULT_EXR_DEPTH = '16';
export const DEFAULT_JPEG_QUALITY = 90;

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
