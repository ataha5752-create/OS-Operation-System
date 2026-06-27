const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// Disable security warnings in Electron
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// Add command line switch to ignore SSL certificate errors since the backend uses self-signed certificates
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

// Start backend Express server
try {
  require('./server.js');
  console.log('[Electron] Backend Express server initialized successfully.');
} catch (err) {
  console.error('[Electron] Error starting backend Express server:', err);
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    title: "WE Ops Control System",
    icon: path.join(__dirname, 'we_logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Load backend homepage (HTTPS on port 3000)
  mainWindow.loadURL('https://localhost:3000');

  // Handle load failure (e.g. if SSL is bypassed and we fell back to HTTP)
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.log(`[Electron] Failed to load URL: ${validatedURL}, Error: ${errorDescription} (${errorCode})`);
    
    // If HTTPS fails, attempt HTTP fallback
    if (validatedURL.startsWith('https://localhost:3000')) {
      console.log('[Electron] Attempting fallback to HTTP...');
      mainWindow.loadURL('http://localhost:3000');
    }
  });

  // Remove default Electron menu bar
  Menu.setApplicationMenu(null);

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (mainWindow === null) createWindow();
  });
});

app.on('window-all-closed', function () {
  // Terminate process when windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
