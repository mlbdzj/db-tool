const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer stays sandboxed. All it can do is report whether it currently
 * holds uncommitted table edits, so the main process can warn before closing.
 */
contextBridge.exposeInMainWorld('dbToolShell', {
  setDirtyState: (dirty) => ipcRenderer.send('dbtool:dirty-state', Boolean(dirty)),
});
