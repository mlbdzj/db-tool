const { contextBridge, ipcRenderer } = require('electron');

/**
 * The main process owns the local service. The window never learns about it
 * from a URL: the API origin and the one-time token are handed over here, so a
 * page opened in a regular browser has no way to reach the service.
 */
const context = ipcRenderer.sendSync('dbtool:context') || {};

contextBridge.exposeInMainWorld('dbToolShell', {
  apiBase: typeof context.apiBase === 'string' ? context.apiBase : '',
  token: typeof context.token === 'string' ? context.token : '',
  setDirtyState: (dirty) => ipcRenderer.send('dbtool:dirty-state', Boolean(dirty)),
});
