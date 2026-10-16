import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** .../server  (works for both `src` during dev and `dist` when compiled) */
const packageRoot = resolve(here, '..');
/** repository root, also the app root inside the packaged desktop build */
const projectRoot = resolve(packageRoot, '..');

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const dataDir = ensureDir(
  process.env.DB_TOOL_DATA_DIR ? resolve(process.env.DB_TOOL_DATA_DIR) : join(projectRoot, 'data'),
);
export const connectionsFile = join(dataDir, 'connections.json');
export const historyFile = join(dataDir, 'query-history.json');
export const secretKeyFile = join(dataDir, 'secret.key');

export const host = process.env.DB_TOOL_HOST ?? '127.0.0.1';
export const preferredPort = Number(process.env.DB_TOOL_PORT ?? 4173) || 4173;
/** When set, every /api call must carry this token. Used by the desktop shell. */
export const authToken = process.env.DB_TOOL_TOKEN ?? '';
export const webDistDir = resolve(projectRoot, 'web', 'dist');
export const version = '0.1.0';
