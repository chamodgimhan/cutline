// Cutline desktop shell (Electron main process).
// The window loads the built web app from disk through the app:// protocol. The page has no Node
// access; it talks to this process only through the small API in preload.cjs. Nothing here or in
// the page may use the network: every request that is not to the app's own files is cancelled.
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.join(__dirname, 'app');
const MEDIA_PREFIX = '/__media__/';
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
const PROJECT_FILTERS = [{ name: 'Cutline project', extensions: ['cutline'] }];
/** Media files the page may read through app://cutline/__media__/. Only paths the user chose, or named by a project they opened. */
const grantedMedia = new Set();
let win = null;
let pendingFile = null;
let closing = false;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const projectArg = (argv) => argv.find((a) => /\.cutline$/i.test(a) && fs.existsSync(a)) ?? null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = projectArg(argv);
    if (file) win.webContents.send('open-file', file);
  });
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (win) win.webContents.send('open-file', file);
    else pendingFile = file;
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height) && s.width >= 800 && s.height >= 500) return s;
  } catch {
    // first run, or an unreadable file: use the defaults
  }
  return { width: 1500, height: 900, maximized: false };
}

function saveState() {
  if (!win) return;
  const b = win.getNormalBounds();
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    // not being able to remember the window size is not worth an error
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

/** Serve one of the app's own files, read straight from disk. Paths that try to leave the app folder are refused. */
function serveApp(request) {
  const url = new URL(request.url);
  // Media lives under the app's own origin, so the page reads it like any of its own files (no cross-origin rules).
  if (url.pathname.startsWith(MEDIA_PREFIX)) return serveMedia(request, decodeURIComponent(url.pathname.slice(MEDIA_PREFIX.length)));
  const file = path.normalize(path.join(APP_DIR, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!file.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
  try {
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** Serve a byte range of a granted media file. */
function serveMedia(request, file) {
  if (!grantedMedia.has(file)) return new Response('Not allowed', { status: 403 });
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = Math.min(size - 1, m && m[2] ? Number(m[2]) : size - 1);
  if (start > end || start >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const stream = fs.createReadStream(file, { start, end });
  const body = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      stream.on('end', () => controller.close());
      stream.on('error', (e) => controller.error(e));
    },
    cancel() {
      stream.destroy();
    },
  });
  return new Response(body, { status: m ? 206 : 200, headers: { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
}

const send = (id) => () => win?.webContents.send('action', id);
function buildMenu() {
  const item = (label, id, accelerator) => ({ label, accelerator, click: send(id) });
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      item('New Project', 'file.new', 'CmdOrCtrl+Alt+N'), item('Open Project…', 'file.open', 'CmdOrCtrl+O'), item('Open Recent…', 'file.recent', 'CmdOrCtrl+Shift+O'),
      { type: 'separator' }, item('Save', 'file.save', 'CmdOrCtrl+S'), item('Save As…', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
      { type: 'separator' }, item('Export…', 'file.export', 'CmdOrCtrl+E'), { type: 'separator' }, mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      item('Undo', 'edit.undo'), item('Redo', 'edit.redo'), { type: 'separator' }, item('Cut', 'edit.cut'), item('Copy', 'edit.copy'), item('Paste', 'edit.paste'),
      item('Duplicate', 'edit.duplicate'), item('Delete', 'edit.delete'), item('Ripple Delete', 'edit.rippleDelete'), { type: 'separator' }, item('Select All', 'edit.selectAll'),
    ] },
    { label: 'Clip', submenu: [item('Split at Playhead', 'clip.split'), item('Link', 'clip.link'), item('Unlink', 'clip.unlink'), item('Freeze Frame', 'clip.freeze')] },
    { label: 'Sequence', submenu: [item('Insert from Source', 'seq.insert'), item('Overwrite from Source', 'seq.overwrite'), item('Lift', 'seq.lift'), item('Extract', 'seq.extract'), { type: 'separator' }, item('Add Video Track', 'seq.addVideoTrack'), item('Add Audio Track', 'seq.addAudioTrack'), item('Add Caption Track', 'seq.addCaptionTrack')] },
    { label: 'Playback', submenu: [item('Play / Pause', 'play.toggle'), item('Go to Start', 'play.start'), item('Go to End', 'play.end'), item('Loop In to Out', 'play.loop')] },
    { label: 'View', submenu: [item('Zoom In', 'view.zoomIn'), item('Zoom Out', 'view.zoomOut'), item('Zoom to Fit', 'view.zoomFit'), { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [item('Keyboard Shortcuts…', 'help.shortcuts'), item('Export Error Log', 'help.exportLog'), { type: 'separator' }, item('About and Licence…', 'help.about')] },
  ]));
}

/** Write a file so that a crash or full disk mid-write cannot destroy the previous version. */
function writeSafely(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function registerIpc() {
  const read = (file) => ({ name: path.basename(file), text: fs.readFileSync(file, 'utf8'), ref: file });
  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: PROJECT_FILTERS });
    return r.canceled || !r.filePaths[0] ? null : read(r.filePaths[0]);
  });
  ipcMain.handle('project:read', (_e, file) => {
    if (typeof file !== 'string' || !/\.cutline$/i.test(file)) throw new Error('not a project file');
    return read(file);
  });
  ipcMain.handle('project:write', (_e, file, text) => {
    if (typeof file !== 'string' || !/\.cutline$/i.test(file) || typeof text !== 'string') throw new Error('not a project file');
    writeSafely(file, text);
  });
  ipcMain.handle('project:saveAs', async (_e, name, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: String(name), filters: PROJECT_FILTERS });
    if (r.canceled || !r.filePath) return null;
    const file = /\.cutline$/i.test(r.filePath) ? r.filePath : `${r.filePath}.cutline`;
    writeSafely(file, String(text));
    app.addRecentDocument(file);
    return { name: path.basename(file), ref: file };
  });
  // The page asks about a media path (from a file the user imported, or a project they opened): if it is a
  // regular file, it may then be read through app://cutline/__media__/.
  ipcMain.handle('media:info', (_e, file) => {
    try {
      const st = fs.statSync(String(file));
      if (!st.isFile()) return null;
      grantedMedia.add(String(file));
      return { size: st.size };
    } catch {
      return null;
    }
  });
  ipcMain.on('close:now', () => {
    closing = true;
    win?.close();
  });
  ipcMain.handle('app:pendingFile', () => {
    const f = pendingFile ?? projectArg(process.argv.slice(1));
    pendingFile = null;
    return f;
  });
}

function start() {
  protocol.handle('app', serveApp);
  // Belt and braces with the page's content security policy: no request leaves this machine.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const ok = /^(app|blob|data|devtools|chrome-extension):/.test(details.url);
    if (!ok) blockedRequests.push(details.url);
    done({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  registerIpc();
  buildMenu();
  const state = readState();
  win = new BrowserWindow({
    ...state, minWidth: 900, minHeight: 600, show: false, title: 'Cutline', backgroundColor: '#0f1114', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  // Links never open inside the app, and the app window never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://cutline/')) e.preventDefault();
  });
  win.on('close', (e) => {
    saveState();
    if (closing) return;
    // Let the page ask about unsaved changes first; it answers with close:now.
    e.preventDefault();
    win.webContents.send('request-close');
  });
  win.on('closed', () => (win = null));
  void win.loadURL('app://cutline/index.html');
}

/** Requests that were refused (for the smoke test, which asserts this stays empty in a normal session). */
const blockedRequests = [];
ipcMain.handle('test:blockedRequests', () => blockedRequests.slice());
