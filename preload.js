// preload.js - the ONLY bridge between the remote Friend web app and the machine.
//
// Runs with Node access but in an isolated world; contextBridge exposes a tiny, explicit
// surface to the page (window.friendDesktop). The page can ask the desktop to SCAN for
// Claude Code / AI artifacts and to READ a chosen subset into transcripts - nothing else.
// There is deliberately no generic readFile(path): the main process re-validates every
// path against the allowed roots before reading, so this bridge can never become an
// arbitrary file-read primitive even if the page were compromised.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('friendDesktop', {
  isDesktop: true,
  platform: process.platform, // 'darwin' | 'win32' | 'linux'
  version: process.env.FRIEND_DESKTOP_VERSION || '0.1.0',
  // Fast manifest of what is on this computer. -> { items, categories, totalBytes, home }
  scanClaude: () => ipcRenderer.invoke('friend:scan'),
  // Read + parse the selected manifest items into ParsedSession[] the brain can ingest.
  readSessions: (items) => ipcRenderer.invoke('friend:read-sessions', items),
});
