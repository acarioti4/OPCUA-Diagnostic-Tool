/// main.js
/**
 * Main Electron process - manages window, IPC, and worker process
 * Architecture: Main Process (this) -> Renderer Process (UI) -> Worker Process (OPC-UA diagnostics)
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const log = require('electron-log');

let mainWindow;
let worker;

/**
 * Creates application window with security settings:
 * - nodeIntegration: false, contextIsolation: true (Electron security best practices)
 * - preload.js provides controlled API bridge to renderer
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * IPC handler: Start diagnostic probe
 * Spawns worker process in separate Node.js process to keep UI responsive
 * and isolate OPC-UA operations. Relays messages: worker -> main -> renderer
 */
ipcMain.on('run-probe', (event, probeConfig) => {
  log.info('Main: run-probe received', probeConfig);

  if (worker) {
    worker.kill();
    worker = null;
  }

  worker = fork(path.join(__dirname, 'worker.js'));

  worker.on('message', (msg) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('probe-event', msg);
    }
  });

  worker.on('exit', (code, signal) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('probe-event', { type: 'finished', code, signal });
    }
    worker = null;
  });

  worker.send({
    type: 'start',
    config: probeConfig,
    userDataPath: app.getPath('userData')
  });
});

ipcMain.on('cancel-probe', () => {
  if (worker) {
    worker.kill();
    worker = null;
  }
});
