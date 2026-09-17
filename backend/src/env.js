import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(backendRoot, '.env') });
