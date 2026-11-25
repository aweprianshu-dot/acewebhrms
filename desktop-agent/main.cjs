const { app, BrowserWindow, ipcMain, powerMonitor, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createAgentController } = require('./agent-core.cjs');

let mainWindow;
const configPath = path.join(__dirname, 'agent-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const secureFile = () => path.join(app.getPath('userData'), 'agent-auth.bin');

const agent = createAgentController({
  firebaseApiKey: firebaseConfig.apiKey,
  readAuthBytes: () => {
    try {
      return fs.readFileSync(secureFile());
    } catch {
      return null;
    }
  },
  writeAuthBytes: (buf) => fs.writeFileSync(secureFile(), buf),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (s) => safeStorage.encryptString(s),
  decryptString: (b) => safeStorage.decryptString(b),
  fetchImpl: (...args) => fetch(...args),
  captureScreenshot: async () => {
    const screenshotDesktop = (await import('screenshot-desktop')).default;
    return screenshotDesktop({ format: 'png' });
  },
  getActiveWindow: async () => {
    const activeWinModule = await import('active-win');
    return activeWinModule.default();
  },
  getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  onStatusUpdate: (payload) => {
    mainWindow?.webContents.send('agent:status-update', payload);
  },
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 660,
    minWidth: 500,
    minHeight: 580,
    title: 'ACE HRMS Monitoring Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  agent.loadAuth();
  createWindow();
});
app.on('window-all-closed', () => {
  agent.stop();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => agent.stop());

ipcMain.handle('agent:set-api', async (_event, nextUrl) => agent.setApiBase(nextUrl));
ipcMain.handle('agent:login', async (_event, creds) => agent.login(creds));
ipcMain.handle('agent:consent', async (_event, accepted) => agent.acceptConsent(accepted));
ipcMain.handle('agent:start', async () => {
  try {
    agent.start();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
ipcMain.handle('agent:stop', async () => {
  agent.stop();
  return { success: true };
});
ipcMain.handle('agent:withdraw', async () => agent.withdraw());
ipcMain.handle('agent:status', async () => agent.getStatus());
