const { app, BrowserWindow, ipcMain, Menu, screen, globalShortcut, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const REFRESH_MS = 30 * 60 * 1000;
const DAY_SECONDS = 86400;
let win;
let currentUsername = null;

const posFile = () => path.join(app.getPath('userData'), 'geometry.json');
const configFile = () => path.join(app.getPath('userData'), 'config.json');

const MIN_WIDTH = 320;
const MIN_HEIGHT = 140;
const MAX_WIDTH = 1000;
const MAX_HEIGHT = 320;
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 180;

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

function buildDays(calendarMap) {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const ts = todayStart - i * DAY_SECONDS;
    const count = calendarMap[String(ts)] || 0;
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    days.push({ date, count });
  }
  return days;
}

async function fetchLeetCodeCalendar(username) {
  const query = `
    query userPulse($username: String!) {
      matchedUser(username: $username) {
        submitStatsGlobal { acSubmissionNum { difficulty count } }
        userCalendar { streak totalActiveDays submissionCalendar }
      }
    }`;

  const res = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://leetcode.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ query, variables: { username } }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`LeetCode request failed (${res.status}).`);

  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message);

  const user = json.data.matchedUser;
  if (!user) throw new Error('User not found.');

  const calendarMap = JSON.parse(user.userCalendar.submissionCalendar || '{}');
  const days = buildDays(calendarMap);
  const allStats = (user.submitStatsGlobal.acSubmissionNum || []).find((d) => d.difficulty === 'All');

  return {
    days,
    streak: user.userCalendar.streak || 0,
    totalActiveDays: user.userCalendar.totalActiveDays || 0,
    totalSolved: (allStats && allStats.count) || 0,
  };
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
    const { days, streak, totalActiveDays, totalSolved } = await fetchLeetCodeCalendar(username);
    win.webContents.send('contrib', { username, days, streak, totalActiveDays, totalSolved, updatedAt: Date.now() });
  } catch (e) {
    win.webContents.send('contrib', { username, error: e.message });
  }
}

function liftToFront() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'floating');
  win.show();
  setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'normal', -1); }, 4000);
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Refresh now', click: refresh },
    { label: 'Change username…', click: () => win.webContents.send('need-setup', { username: currentUsername, force: true }) },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
}

function githubPulseGeometry() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), '..', 'github-pulse-widget', 'geometry.json'), 'utf8'));
  } catch {
    return null;
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const saved = loadGeometry();
  const width = saved ? saved.width : DEFAULT_WIDTH;
  const height = saved ? saved.height : DEFAULT_HEIGHT;
  const githubPulse = saved ? null : githubPulseGeometry();
  const defaultX = githubPulse ? githubPulse.x : workArea.x + workArea.width - width - 20;
  const defaultY = githubPulse ? githubPulse.y + githubPulse.height + 16 : workArea.y + 20 + DEFAULT_HEIGHT + 16;
  win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    x: saved ? saved.x : defaultX,
    y: saved ? saved.y : defaultY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // desktop layer: pinned to the desktop wallpaper, below every normal app window,
  // present on every Space/full-screen app at the same spot (not just the one it was created on)
  win.setAlwaysOnTop(true, 'normal', -1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.on('moved', saveGeometry);
  win.on('resize', saveGeometry);
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', refresh);
  win.webContents.on('context-menu', () => buildContextMenu().popup());
}

ipcMain.on('refresh', refresh);
ipcMain.on('quit', () => app.quit());
ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\/leetcode\.com\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', async (_e, { username }) => {
  try {
    username = (username || '').trim();
    if (!username) throw new Error('Username is required.');
    saveUsername(username);
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
    globalShortcut.register('CommandOrControl+Alt+L', liftToFront);
    setInterval(refresh, REFRESH_MS);
  });
}
app.on('window-all-closed', () => app.quit());
