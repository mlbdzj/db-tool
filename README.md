# DB Tool

[English](README.md) · [简体中文](README.zh-CN.md)

A local-first database management tool for **MySQL / MariaDB** and **PostgreSQL**.
Use it as a web app in your browser, or package it as a desktop client (Electron).

## Features

- **Connection management** — keep several connections side by side. Passwords are encrypted with a key stored on your machine and are never sent back to the UI.
- **Schema browsing** — databases → tables / views → columns, with primary key, auto-increment and comment markers.
- **SQL editor** — syntax highlighting, run with `Ctrl / ⌘ + Enter`, multiple statements split into separate result sets, row count and timing, query history.
- **Table data browsing and editing** — paging, sorting, `WHERE` filters, double-click a cell to edit, insert and delete rows. All changes are committed in a single transaction.
- **Export** — export a result set or a whole table as CSV (UTF-8 BOM, opens straight in Excel) or JSON; large tables are streamed in chunks.
- **Safe mode** — blocks `UPDATE / DELETE / DROP / TRUNCATE` without a `WHERE` clause until you confirm. Can be turned off per connection.

## Requirements

- Node.js 20 or newer (developed against Node 24)
- A target database: MySQL 5.7+/8.x or PostgreSQL 10+

## Quick start (run in the browser)

```bash
npm install
npm run build
npm start
```

Then open http://127.0.0.1:4173 .

## Development mode

```bash
npm run dev          # API on 4173 with hot restart + UI on 5173 with hot reload
```

Open http://127.0.0.1:5173 ; `/api` is proxied to the API server.

## Desktop client

```bash
npm run desktop      # build, then open the Electron app
npm run dist         # package an installer and a portable build into release/
```

`npm run dist` produces:

- `DB Tool-0.1.0-setup.exe` — NSIS installer, lets you pick the install directory and creates a desktop shortcut
- `DB Tool-0.1.0-portable.exe` — single portable executable

On launch the desktop build starts a local service that only listens on `127.0.0.1` (on a free port) and requires a one-time access token. Its data directory lives in the OS user data folder, independent from development mode.

### Unsigned installers

The packaged builds are **unsigned**. If the machine that runs them has Smart App Control enabled
(`Settings → Privacy & security → Windows Security → App & browser control → Smart App Control`),
Windows blocks both executables with `An Application Control policy has blocked this file`. Options:

- sign the artifacts (electron-builder's `win.certificateFile` / `win.certificatePassword`);
- or use the unpacked build in `release/win-unpacked/` — the main binary inherits Electron's known reputation and usually is not blocked;
- turning Smart App Control off is a one-way move: once disabled, only a Windows reset can re-enable it.

The policy applies per machine, so these installers run by double-clicking on machines that do not enable it.

## Self-checks

```bash
# API end to end (needs a reachable MySQL)
SMOKE_MYSQL_PASSWORD=your-password npm run smoke

# Desktop UI end to end (real clicks, real SQL)
node_modules/.bin/electron . --remote-debugging-port=9222
SMOKE_MYSQL_PASSWORD=your-password node scripts/desktop-e2e.mjs
```

Both scripts create a temporary connection named `自检连接 MySQL`, then delete it when they finish, so no stray connections are left behind.

## Project layout

```
server/   local API: connections, SQL execution, schema reads, row edits, export
web/      React UI: sidebar, SQL editor, data grid (virtual scrolling)
electron/ desktop shell: starts the local service and opens the window
scripts/  self-check scripts and icon generation
build/    icon assets used when packaging
```

## Data and security

- Saved connections live in `<user data dir>/connections.json`. Password fields are encrypted with AES-256-GCM using `secret.key` in the same directory.
  **Never commit or share `data/` or `secret.key`.**
- The service binds to `127.0.0.1` only, so other machines on the network cannot reach it.
- Connection details and query history never leave your machine. No telemetry.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and UI in development mode |
| `npm run build` | Compile the API and bundle the UI |
| `npm start` | Run the compiled service (also serves the UI) |
| `npm run desktop` | Build and launch the desktop app |
| `npm run dist` | Build the Windows installer / portable build |
| `npm run typecheck` | Type-check the API and the UI |
| `npm run smoke` | API end-to-end self-check |
| `npm run icon` | Regenerate the app icon |

---

Adding a translation? Copy `README.md`, translate it, then add a link to the switcher line at the top of every README.
