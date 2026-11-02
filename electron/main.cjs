const { app, BrowserWindow, Menu, shell, dialog, ipcMain, protocol, net } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const AUTH_TOKEN = randomBytes(24).toString('hex');
const DEV_URL = process.env.DB_TOOL_DEV_URL ?? '';
/** Packaged renderer files, loaded through the privileged `app://` scheme. */
const RENDERER_ROOT = path.join(__dirname, '..', 'web', 'dist');
const APP_ENTRY = 'app://db-tool/index.html';

// A real, secure origin (instead of file://) so ES modules, fetch and
// localStorage behave exactly like they do in development.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let serverProcess = null;
let serverOrigin = '';
let mainWindow = null;
let serverStderr = '';
let hasUnsavedChanges = false;
let closeDialogOpen = false;

function serverEntry() {
  return path.join(__dirname, '..', 'server', 'dist', 'index.js');
}

/**
 * The API runs as a separate process using Electron's bundled Node, so a stuck
 * query can never freeze the window and the server can be restarted on its own.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverEntry()], {
      // Never point cwd at the app directory: when packaged it lives inside
      // app.asar, which is an archive rather than a real directory, and the
      // child process would fail to start.
      cwd: app.getPath('userData'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // 0 lets the OS hand out a free port, so the desktop app can never
        // collide with whatever else is running on this machine.
        DB_TOOL_PORT: process.env.DB_TOOL_PORT ?? '0',
        DB_TOOL_TOKEN: AUTH_TOKEN,
        DB_TOOL_DATA_DIR: app.getPath('userData'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    serverProcess = child;

    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('本地服务启动超时')), 25000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = /__DB_TOOL_READY__(\{[^\n]*\})/.exec(buffer);
      if (!match) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(match[1]));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      serverStderr = `${serverStderr}${text}`.split('\n').slice(-8).join('\n');
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`本地服务已退出（代码 ${code}）${serverStderr ? `\n\n${serverStderr}` : ''}`));
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#12141a',
    title: 'DB Tool',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', async (event) => {
    const win = mainWindow;
    if (!win || !hasUnsavedChanges || closeDialogOpen) return;
    event.preventDefault();
    closeDialogOpen = true;
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['继续编辑', '放弃改动并退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '有未提交的改动',
        message: '表格里还有未提交的改动，直接退出会丢失这些改动。',
        detail: '选「继续编辑」回到应用；选「放弃改动并退出」会关闭窗口，未提交的改动不会写入数据库。',
      });
      if (response === 1) {
        hasUnsavedChanges = false;
        win.destroy();
      }
    } finally {
      closeDialogOpen = false;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    // The window is a single page application: any navigation means a link was
    // clicked, so hand it to the system browser instead of replacing the app.
    const appOrigin = DEV_URL ? DEV_URL.split('?')[0] : 'app://db-tool';
    if (target.startsWith(appOrigin)) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });

  void mainWindow.loadURL(DEV_URL || APP_ENTRY);
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.removeAllListeners('exit');
  serverProcess.kill();
  serverProcess = null;
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Serve the bundled UI from web/dist. Nothing serves it over HTTP, so the
    // local service stays a pure API.
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const target = path.join(RENDERER_ROOT, relative);
      if (target !== RENDERER_ROOT && !target.startsWith(`${RENDERER_ROOT}${path.sep}`)) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    });
    ipcMain.on('dbtool:dirty-state', (_event, dirty) => {
      hasUnsavedChanges = Boolean(dirty);
    });
    ipcMain.on('dbtool:context', (event) => {
      event.returnValue = DEV_URL
        ? { apiBase: '', token: '' }
        : { apiBase: serverOrigin, token: AUTH_TOKEN };
    });
    try {
      if (DEV_URL) {
        // The dev server is started separately (npm run dev:desktop) and the
        // window talks to it through its /api proxy, so no local service is
        // spawned here.
        createWindow();
      } else {
        const server = await startServer();
        serverOrigin = server.url;
        createWindow();
      }
    } catch (error) {
      dialog.showErrorBox('无法启动 DB Tool', error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    stopServer();
    app.quit();
  });

  app.on('before-quit', stopServer);
  process.on('exit', stopServer);
}
