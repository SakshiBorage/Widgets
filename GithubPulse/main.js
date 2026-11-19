const { app, BrowserWindow, ipcMain, Menu, screen, globalShortcut, shell } = require('electron');
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');

const REFRESH_MS = 30 * 60 * 1000;
const KEYCHAIN_SERVICE = 'GithubPulseWidget-token';
let win;
let currentUsername = null;

const posFile = () => path.join(app.getPath('userData'), 'geometry.json');
const configFile = () => path.join(app.getPath('userData'), 'config.json');

const MIN_WIDTH = 320;
const MIN_HEIGHT = 140;
const MAX_WIDTH = 1000;
const MAX_HEIGHT = 320;

function loadGeometry() {
  try {
    const g = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      g.x >= a.x - 20 && g.x < a.x + a.width - 60 && g.y >= a.y - 20 && g.y < a.y + a.height - 40);
    return visible ? g : null;
  } catch {
    return null;
  }
}

function saveGeometry() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [width, height] = win.getSize();
  try { fs.writeFileSync(posFile(), JSON.stringify({ x, y, width, height })); } catch {}
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return { username: '' };
  }
}

function saveUsername(username) {
  fs.writeFileSync(configFile(), JSON.stringify({ username }));
}

function readToken(username) {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', username, '-w'], (err, out) => {
      if (err) return resolve(null);
      resolve(out.trim());
    });
  });
}

function saveToken(username, token) {
  return new Promise((resolve, reject) => {
    execFile('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', username, '-w', token], (err) => {
      if (err) return reject(new Error('Could not save token to Keychain.'));
      resolve();
    });
  });
}

async function fetchContributions(username, token) {
  const query = `{
    user(login: "${username}") {
      contributionsCollection {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }`;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) throw new Error('Token invalid or expired.');
  if (!res.ok) throw new Error(`GitHub request failed (${res.status}).`);

  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message);

  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  const days = weeks.flatMap((w) => w.contributionDays);
  return days.map((d) => ({ date: d.date, count: d.contributionCount }));
}

async function refresh() {
  if (!win || win.isDestroyed()) return;
  const { username } = loadConfig();
  if (!username) {
    win.webContents.send('need-setup', {});
    return;
  }
  currentUsername = username;
  try {
    const token = await readToken(username);
    if (!token) {
      win.webContents.send('need-setup', { username });
      return;
    }
    const days = await fetchContributions(username, token);
    win.webContents.send('contrib', { username, days, updatedAt: Date.now() });
  } catch (e) {
    win.webContents.send('contrib', { username, error: e.message });
  }
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Refresh now', click: refresh },
    { label: 'Change account / token…', click: () => win.webContents.send('need-setup', { username: currentUsername, force: true }) },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const defaultWidth = 520;
  const defaultHeight = 180;
  const saved = loadGeometry();
  const width = saved ? saved.width : defaultWidth;
  const height = saved ? saved.height : defaultHeight;
  win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    x: saved ? saved.x : workArea.x + workArea.width - width - 20,
    y: saved ? saved.y : workArea.y + 20,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // desktop layer: above wallpaper/icons, below every normal app window
  win.setAlwaysOnTop(true, 'normal', -1);
  win.on('moved', saveGeometry);
  win.on('resize', saveGeometry);
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', refresh);
  win.webContents.on('context-menu', () => buildContextMenu().popup());
}

ipcMain.on('refresh', refresh);
ipcMain.on('quit', () => app.quit());
ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', async (_e, { username, token }) => {
  try {
    username = (username || '').trim();
    if (!username) throw new Error('Username is required.');
    saveUsername(username);
    if (token) await saveToken(username, token);
    await refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    createWindow();
    // quick peek: lift above other windows for a few seconds, then back to the desktop layer
    globalShortcut.register('CommandOrControl+Alt+G', () => {
      if (!win || win.isDestroyed()) return;
      win.setAlwaysOnTop(true, 'floating');
      win.show();
      setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'normal', -1); }, 4000);
    });
    setInterval(refresh, REFRESH_MS);
  });
}
app.on('window-all-closed', () => app.quit());
