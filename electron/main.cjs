const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const AUTH_TOKEN = randomBytes(24).toString('hex');
const DEV_URL = process.env.DB_TOOL_DEV_URL ?? '';

let serverProcess = null;
let mainWindow = null;
let serverStderr = '';

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

function createWindow(url) {
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
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url.split('?')[0])) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });

  void mainWindow.loadURL(url);
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
    try {
      const server = await startServer();
      createWindow(DEV_URL || `${server.url}?token=${AUTH_TOKEN}`);
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
