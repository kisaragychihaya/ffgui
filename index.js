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
