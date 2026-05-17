'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeImage,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const store = require('./store');
const proxmox = require('./proxmox');
const deployer = require('./deployer');
const verifier = require('./verifier');
const diagnostics = require('./diagnostics');
const { parsePublicKey } = require('./keyinfo');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

let win;

/** True if the rectangle overlaps the work area of at least one display. */
function isOnScreen(rect) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      rect.x < a.x + a.width &&
      rect.x + rect.width > a.x &&
      rect.y < a.y + a.height &&
      rect.y + rect.height > a.y
    );
  });
}

function createWindow() {
  const saved = store.loadWindowState() || {};

  const options = {
    width: saved.width || 1240,
    height: saved.height || 878,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0e1014',
    title: 'SSH Deployer',
    frame: false,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  // restore the previous position only if it still lands on a display
  if (
    typeof saved.x === 'number' &&
    typeof saved.y === 'number' &&
    isOnScreen({ x: saved.x, y: saved.y, width: options.width, height: options.height })
  ) {
    options.x = saved.x;
    options.y = saved.y;
  }

  win = new BrowserWindow(options);
  if (saved.maximized) win.maximize();

  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // remember size / position / maximized state across launches
  const persistWindowState = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    store.saveWindowState({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: win.isMaximized(),
    });
  };
  let saveTimer = null;
  const persistSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistWindowState, 400);
  };

  // tell the renderer when the window is (un)maximized so it can swap the icon
  const sendWindowState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('window:state', win.isMaximized());
    }
  };
  win.on('maximize', () => {
    sendWindowState();
    persistSoon();
  });
  win.on('unmaximize', () => {
    sendWindowState();
    persistSoon();
  });
  win.on('resize', persistSoon);
  win.on('move', persistSoon);
  win.on('close', () => {
    clearTimeout(saveTimer);
    persistWindowState();
  });

  // open external links in the default browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (!img.isEmpty()) app.dock.setIcon(img);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Turn a renderer-supplied credential object into ssh2 connect options.
 * Reads the private key file from disk so the renderer never handles it.
 */
function resolveAuth(c) {
  const out = {
    host: c.host,
    port: Number(c.port) || 22,
    username: (c.username || '').trim() || 'root',
    readyTimeout: 25000,
    keepaliveInterval: 10000,
  };
  if (c.authType === 'key') {
    if (!c.privateKeyPath) throw new Error('No private key file selected');
    out.privateKey = fs.readFileSync(c.privateKeyPath);
    if (c.passphrase) out.passphrase = c.passphrase;
  } else {
    out.password = c.password || '';
  }
  return out;
}

ipcMain.on('window:control', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === 'minimize') w.minimize();
  else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === 'close') w.close();
});

ipcMain.handle('history:list', () => store.loadHistory());
ipcMain.handle('history:add', (_e, entry) => store.addHistory(entry));
ipcMain.handle('history:clear', () => store.saveHistory([]));

ipcMain.handle('env:list', () => store.listEnvironments());
ipcMain.handle('env:save', (_e, env) => store.saveEnvironment(env));
ipcMain.handle('env:delete', (_e, id) => store.deleteEnvironment(id));
ipcMain.handle('env:setLast', (_e, id) => store.setLastEnvironment(id));

ipcMain.handle('key:parse', (_e, text) => parsePublicKey(text));

ipcMain.handle('dialog:pickKey', async () => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const r = await dialog.showOpenDialog(win, {
    title: 'Select private SSH key',
    defaultPath: fs.existsSync(sshDir) ? sshDir : os.homedir(),
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
});

// Pick a public key file (.pub) and return its contents.
ipcMain.handle('dialog:pickPublicKey', async () => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const r = await dialog.showOpenDialog(win, {
    title: 'Select an SSH public key (.pub)',
    defaultPath: fs.existsSync(sshDir) ? sshDir : os.homedir(),
    properties: ['openFile', 'showHiddenFiles'],
    filters: [
      { name: 'SSH public key', extensions: ['pub'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  try {
    const content = fs.readFileSync(file, 'utf8');
    // the matching private key is the same path without the .pub suffix
    let privateKeyPath = '';
    if (/\.pub$/i.test(file)) {
      const candidate = file.replace(/\.pub$/i, '');
      if (fs.existsSync(candidate)) privateKeyPath = candidate;
    }
    return { path: file, content, privateKeyPath };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('proxmox:connect', async (_e, conn) => {
  try {
    const auth = resolveAuth(conn);
    const result = await proxmox.fetchHosts(auth);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('proxmox:diagnose', async (_e, conn) => {
  let auth;
  try {
    auth = resolveAuth(conn);
  } catch (err) {
    return [
      {
        name: 'Private key file',
        status: 'fail',
        detail: (err && err.message) || String(err),
      },
    ];
  }
  try {
    return await diagnostics.diagnose(auth);
  } catch (err) {
    return [
      {
        name: 'Diagnostics',
        status: 'fail',
        detail: (err && err.message) || String(err),
      },
    ];
  }
});

ipcMain.handle('proxmox:resolveAddresses', async (e, payload) => {
  try {
    const auth = resolveAuth(payload.conn);
    await proxmox.resolveAddresses(auth, payload.guests || [], (upd) => {
      if (!e.sender.isDestroyed()) e.sender.send('address:progress', upd);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('verify:start', async (e, payload) => {
  const emit = (msg) => {
    if (!e.sender.isDestroyed()) e.sender.send('verify:progress', msg);
  };
  let privateKey;
  try {
    privateKey = fs.readFileSync(payload.privateKeyPath);
  } catch (err) {
    return {
      error: 'Cannot read the private key file: ' + ((err && err.message) || err),
    };
  }
  try {
    return await verifier.verifyAll(
      { hosts: payload.hosts || [], privateKey, passphrase: payload.passphrase },
      emit
    );
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('deploy:start', async (e, payload) => {
  const emit = (msg) => {
    if (!e.sender.isDestroyed()) e.sender.send('deploy:progress', msg);
  };
  try {
    if (payload.mode === 'proxmox') {
      const proxmoxAuth = resolveAuth(payload.proxmoxConn);
      return await deployer.deployViaProxmox(
        {
          hosts: payload.hosts,
          publicKey: payload.publicKey,
          proxmoxAuth,
          connectedNode: payload.connectedNode,
          nodeIps: payload.nodeIps,
        },
        emit
      );
    }
    return await deployer.deployViaDirect(
      {
        hosts: payload.hosts,
        publicKey: payload.publicKey,
        creds: payload.creds,
        resolveAuth,
      },
      emit
    );
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});
