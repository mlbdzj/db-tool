# DB Tool

[English](README.md) · [简体中文](README.zh-CN.md)

A local-first **desktop** database client for **MySQL / MariaDB** and **PostgreSQL**.

The app is a native Electron window: the UI is bundled inside the application and served
from a private `app://` scheme, and the local service only exposes an HTTP API on
`127.0.0.1`. There is no browser version — opening the service URL in a normal browser
shows nothing, and every API call requires a one-time token that only the app knows.

## Features

- **Connection management** — keep several connections side by side. Passwords are encrypted with a key stored on your machine and are never returned by the API.
- **Schema browsing** — databases → tables / views → columns, with primary key, auto-increment and comment markers.
- **SQL editor** — syntax highlighting, run with `Ctrl / ⌘ + Enter`, multiple statements split into separate result sets, row count and timing, cancellable queries, query history.
- **Table data browsing and editing** — paging, sorting, `WHERE` filters, double-click a cell to edit, insert and delete rows. All changes are committed in a single transaction.
- **Export** — export a result set or a whole table as CSV (UTF-8 BOM, opens straight in Excel) or JSON; large tables are streamed in chunks.
- **Safe mode** — blocks `UPDATE / DELETE / DROP / TRUNCATE` without a `WHERE` clause until you confirm. Can be turned off per connection.

## Requirements

- Node.js 20 or newer (developed against Node 24)
- A target database: MySQL 5.7+/8.x or PostgreSQL 10+

## Run the app

```bash
npm install
npm run desktop      # build the service and the UI, then open the window
```

To package installers:

```bash
npm run dist         # artifacts land in release/
```

`npm run dist` produces:

- `DB Tool-0.1.0-setup.exe` — NSIS installer, lets you pick the install directory and creates a desktop shortcut
- `DB Tool-0.1.0-portable.exe` — single portable executable

## Development

```bash
npm run dev:desktop  # API with hot restart + UI with hot reload, then Electron
```

Under the hood that runs `npm run dev:server` (tsx watch on the API) and `npm run dev:web`
(Vite on `127.0.0.1:5173`), then starts Electron with `DB_TOOL_DEV_URL` so the window loads
the dev server and talks to the API through its `/api` proxy.

The API port comes from `DB_TOOL_PORT` (default `3000`; use `0` to let the OS pick a free port).
The dev server proxies to `DB_TOOL_API` (default `http://127.0.0.1:3000`).

## How the window talks to the service

On launch the app starts the compiled service on an OS-assigned free port that only listens on
`127.0.0.1`, generates a one-time access token, and passes both to the renderer through the
preload bridge (`window.dbToolShell`). The window itself is loaded from `app://db-tool`, never
from the service, so the service has no UI to serve and no browser client.

The data directory lives in the OS user data folder, independent from development mode.

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
# API end to end (needs a reachable MySQL and the API running on :3000)
SMOKE_MYSQL_PASSWORD=your-password npm run smoke

# Desktop UI end to end (real clicks, real SQL)
node_modules/.bin/electron . --remote-debugging-port=9222
SMOKE_MYSQL_PASSWORD=your-password node scripts/desktop-e2e.mjs
```

Both scripts create a temporary connection named `自检连接 MySQL`, then delete it when they finish,
so no stray connections are left behind.

## Project layout

```
server/   local API: connections, SQL execution, schema reads, row edits, export
web/      React renderer: sidebar, SQL editor, data grid (virtual scrolling)
electron/ desktop shell: `app://` renderer, starts the local service, IPC bridge
scripts/  dev launcher and self-check scripts
build/    icon assets used when packaging
```

## Data and security

- Saved connections live in `<user data dir>/connections.json`. Password fields are encrypted with AES-256-GCM using `secret.key` in the same directory.
  **Never commit or share `data/` or `secret.key`.**
- The service binds to `127.0.0.1` only, so other machines on the network cannot reach it.
- The window never loads the UI over HTTP, and the API rejects requests without the per-launch token.
- Connection details and query history never leave your machine. No telemetry.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev:desktop` | Desktop app in development mode |
| `npm run desktop` | Build and launch the desktop app |
| `npm run dist` | Build the Windows installer / portable build |
| `npm run build` | Compile the API and bundle the UI |
| `npm start` | Run the compiled API alone (no window) |
| `npm run typecheck` | Type-check the API and the UI |
| `npm run smoke` | API end-to-end self-check |
| `npm run icon` | Regenerate the app icon |

---

Adding a translation? Copy `README.md`, translate it, then add a link to the switcher line at the top of every README.
