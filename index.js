const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 900,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    // Windows 任务栏/标题栏图标用 ICO 更可靠；其他平台用 PNG
    icon: path.join(
      __dirname, 'assets', 'imgs',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
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
  // 多语言：先应用持久化语言设置（主进程报错与弹窗标题据此翻译），再注册切换 IPC
  const i18n = require('./main/i18n');
  i18n.init();
  i18n.registerI18nIpc();
  // 注册 ffmpeg 能力探测 / 文件选择 / 转换任务等 IPC
  require('./main/ffmpeg').registerIpc();
  // 光盘抓取：Rust 侧车 + 内部 FFmpeg 转码编排
  require('./main/disc').registerDiscIpc();
  // CD 抓轨：libcdio 读取音频 CD，FFmpeg 编码 FLAC 无损
  require('./main/cdrip').registerCdIpc();
  // 主题：先应用持久化设置（nativeTheme.themeSource），再注册切换 IPC
  const theme = require('./main/theme');
  theme.initTheme();
  theme.registerThemeIpc();

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
