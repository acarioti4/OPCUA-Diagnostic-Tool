/// main.js
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const log = require('electron-log');

let mainWindow;
let worker; // child process

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

  // Hide menu bar
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  // Remove global application menu (File/Edit/etc.)
  Menu.setApplicationMenu(null);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('run-probe', (event, probeConfig) => {
  log.info('Main: run-probe received', probeConfig);

  // Fork worker
  if (worker) {
    worker.kill();
    worker = null;
  }

  worker = fork(path.join(__dirname, 'worker.js'));

  // Relay messages from worker to renderer
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

  // Send configuration to worker
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
