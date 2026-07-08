// Friend desktop app (Electron main process).
//
// Friend on your computer: a thin native window over the hosted app at friend.ecodia.au.
// Like the mobile shell, it IS the hosted app (full parity by construction, every web ship
// reaches it), just wrapped natively with a real window, the macOS traffic-light inset, a
// dock icon, and a persistent session so a sign-in survives quit and relaunch.
//
// SHOT=1 loads the window hidden, captures the rendered page to a file, and quits, so the
// app can be boot-verified without stealing the user's screen focus.

const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const FRIEND_URL = (process.env.FRIEND_URL ?? 'https://friend.ecodia.au').replace(/\/$/, '');
const SHOT = process.env.SHOT === '1';

function iconPath() {
  const p = path.join(__dirname, 'build', 'icon.png');
  return fs.existsSync(p) ? p : null;
}

let mainWindow = null;

async function createWindow() {
  const icon = iconPath();
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: !SHOT,
    title: 'Friend',
    // Warm cream so the frame never flashes white before the page paints.
    backgroundColor: '#faf7f0',
    // macOS: keep the traffic lights but hide the title bar chrome, insetting the
    // lights into the page so the window reads as one calm surface.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    ...(icon ? { icon } : {}),
    webPreferences: {
      // The default session is persistent (stored under userData), so cookies and the
      // Supabase auth session survive quit and relaunch. No custom in-memory partition.
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  // Open real external links (not app navigations) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(FRIEND_URL)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await win.loadURL(FRIEND_URL);
  return win;
}

app.whenReady().then(async () => {
  // Dock icon (mac; the packaged .app uses its .icns bundle icon).
  if (process.platform === 'darwin' && app.dock) {
    const i = iconPath();
    if (i) {
      try {
        app.dock.setIcon(i);
      } catch {
        /* non-fatal */
      }
    }
  }

  const win = await createWindow();

  if (SHOT) {
    // Boot-verify: loadURL above already resolved on final load. Show the window WITHOUT
    // stealing focus (showInactive) so the page actually paints, wait, capture, quit.
    try {
      win.showInactive();
      await new Promise((r) => setTimeout(r, 4500));
      const img = await win.webContents.capturePage();
      const out = process.env.SHOT_OUT || path.join(app.getPath('temp'), 'friend-desktop.png');
      fs.writeFileSync(out, img.toPNG());
      process.stdout.write(`[friend-desktop] shot written: ${out}\n`);
    } catch (e) {
      process.stderr.write(`[friend-desktop] shot failed: ${e && e.message}\n`);
    }
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SHOT) app.quit();
});
