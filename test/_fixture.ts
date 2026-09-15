import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkspace } from '../src/index.js';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
export const ast = openWorkspace(FIXTURE);
