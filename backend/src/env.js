import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Imported before anything else in index.js. ESM evaluates every import ahead of
// the importing module's own body, so a module reading process.env at load time
// - BLENDER_PATH, DB_PATH, API_URL - would miss .env entirely if dotenv ran
// there instead. Resolved from the source tree rather than the working
// directory, for the same reason the data paths are.
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(backendRoot, '.env') });
