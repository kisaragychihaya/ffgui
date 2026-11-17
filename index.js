const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { t } = require('./main/i18n');

// 真正退出（app.quit / 确认关闭）时置位，close 拦截据此放行；
// 新建窗口时复位，避免 macOS 关闭窗口后重新激活时仍处于「强制关闭」状态
let forceClose = false;

function createWindow() {
  const taskgate = require('./main/taskgate');
  forceClose = false;
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

  // 任务执行中拦截关闭按钮，二次确认后再取消任务强关窗口。
  // 渲染层各页有 beforeunload 拦截，确认退出后必须 win.destroy()（不触发卸载事件），
  // 留 500ms 让取消清理落地（ffmpeg close 回调删半成品）
  win.on('close', (e) => {
    if (forceClose) return;                  // 已确认退出 / app 层退出，放行
    if (!taskgate.isBusy()) return;          // 空闲放行
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: t('main.closeConfirm.title'),
      message: t('main.closeConfirm.message'),
      buttons: [t('main.closeConfirm.stay'), t('main.closeConfirm.exit')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice !== 1) return;                // 继续任务：留在页面
    forceClose = true;
    taskgate.cancelAll();
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, 500);
  });

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
  // 图片格式互转：复用 ffmpeg 的能力探测与任务执行器，独立注册 IPC
  require('./main/imgconv').registerImgconvIpc();
  // 光盘抓取：Rust 侧车 + 内部 FFmpeg 转码编排
  require('./main/disc').registerDiscIpc();
  // CD 抓轨：libcdio 读取音频 CD，FFmpeg 编码 FLAC 无损
  require('./main/cdrip').registerCdIpc();
  // 字幕配音：本地 TTS 引擎逐条合成 + FFmpeg 组装音轨并混流
  require('./main/dub').registerDubIpc();
  // 主题：先应用持久化设置（nativeTheme.themeSource），再注册切换 IPC
  const theme = require('./main/theme');
  theme.initTheme();
  theme.registerThemeIpc();
  // 应用自动更新（仅 Windows 安装版）：清理旧安装包、检查更新并注册 IPC
  require('./main/updater').init();

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

// app.quit() 等应用层退出（菜单 / Cmd+Q / 系统会话结束）不弹确认，直接放行
app.on('before-quit', () => {
  forceClose = true;
});
