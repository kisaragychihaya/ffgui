const { app, BrowserWindow } = require('electron');
const path = require('path');

// 兼容 electron-squirrel-startup（Windows 安装包快捷方式场景）
if (require('electron-squirrel-startup')) {
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'html', 'index.html'));

  if (!app.isPackaged) {
    // 开发模式下打开 DevTools
    win.webContents.openDevTools();
  } else {
    // 打包后禁止打开 DevTools（快捷键 / 菜单触发均拦截）
    win.webContents.on('devtools-opened', () => {
      win.webContents.closeDevTools();
    });
  }
}

app.whenReady().then(() => {
  // 注册 ffmpeg 能力探测 / 文件选择 / 转换任务等 IPC
  require('./main/ffmpeg').registerIpc();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
