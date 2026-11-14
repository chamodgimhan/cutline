// The only bridge between the page and the desktop shell. Kept deliberately small: project files
// through native dialogs, the path of a file the user dropped or picked, and a few signals.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cutlineDesktop', {
  openProject: () => ipcRenderer.invoke('project:open'),
  readProject: (ref) => ipcRenderer.invoke('project:read', ref),
  writeProject: (ref, text) => ipcRenderer.invoke('project:write', ref, text),
  saveProjectAs: (name, text) => ipcRenderer.invoke('project:saveAs', name, text),
  /** Absolute path of a File from a picker or a drop, or '' when it has none. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  /** Size of a media file by path (and permission to read it), or null when it is not there. */
  mediaInfo: (file) => ipcRenderer.invoke('media:info', file),
  /** A project file the app was started with (double-clicked in the file manager), if any. */
  pendingFile: () => ipcRenderer.invoke('app:pendingFile'),
  onAction: (fn) => void ipcRenderer.on('action', (_e, id) => fn(id)),
  onOpenFile: (fn) => void ipcRenderer.on('open-file', (_e, file) => fn(file)),
  onRequestClose: (fn) => void ipcRenderer.on('request-close', () => fn()),
  closeNow: () => ipcRenderer.send('close:now'),
  blockedRequests: () => ipcRenderer.invoke('test:blockedRequests'),
});
