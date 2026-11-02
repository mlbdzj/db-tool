#!/usr/bin/env node
/**
 * Development entry point for the desktop app.
 *
 * Starts the API with tsx watch and the renderer with Vite, then opens Electron
 * against the Vite dev server (`DB_TOOL_DEV_URL`). The window talks to the API
 * through Vite's /api proxy, so nothing needs to be built first.
 *
 *   npm run dev:desktop
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const DEV_URL = process.env.DB_TOOL_DEV_URL ?? 'http://127.0.0.1:5173';
const children = [];
let shuttingDown = false;

function run(label, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[${label}] exited with code ${code}, shutting down`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'GET' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`dev server did not answer at ${url}`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', 'npm', ['run', 'dev:server']);
run('ui', 'npm', ['run', 'dev:web']);

try {
  await waitForServer(DEV_URL);
  console.log(`\nrenderer ready at ${DEV_URL}, starting Electron\n`);
  run('app', electronBinary, ['.'], { DB_TOOL_DEV_URL: DEV_URL });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
