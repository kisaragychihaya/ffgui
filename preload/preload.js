const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 向渲染进程暴露的受限 API
contextBridge.exposeInMainWorld('ffgui', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // ffmpeg 能力（硬件加速 / 编码器 / 封装格式），首次启动生成缓存
  getCapabilities: () => ipcRenderer.invoke('ffgui:getCapabilities'),
  // 删除能力缓存文件（下次调用 getCapabilities 时重新探测）
  clearCapsCache: () => ipcRenderer.invoke('ffgui:clearCapsCache'),

  // 文件 / 目录选择
  pickMediaFiles: () => ipcRenderer.invoke('ffgui:pickMediaFiles'),
  pickDirectory: () => ipcRenderer.invoke('ffgui:pickDirectory'),
  // 拖拽文件时取真实路径（Electron 新版 File 对象不再带 path）
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // 转换任务
  convert: (job) => ipcRenderer.invoke('ffgui:convert', job),
  cancelConvert: () => ipcRenderer.invoke('ffgui:cancelConvert'),
  onConvertEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ffgui:convert-event', listener);
    return () => ipcRenderer.removeListener('ffgui:convert-event', listener);
  },

  // 合并任务（探测 + 拼接；进度事件复用 onConvertEvent，取消复用 cancelConvert）
  probeMedia: (files) => ipcRenderer.invoke('ffgui:probeMedia', files),
  merge: (job) => ipcRenderer.invoke('ffgui:merge', job),

  // 截取任务（无损切；进度事件复用 onConvertEvent，取消复用 cancelConvert）
  clip: (job) => ipcRenderer.invoke('ffgui:clip', job),
  // 浏览器放不了的格式：转一份低码率临时预览副本供播放定位
  makePreview: (job) => ipcRenderer.invoke('ffgui:makePreview', job),
  // 抓帧截图（主进程弹保存对话框，ffmpeg 从原文件抓一帧 PNG）
  captureFrame: (payload) => ipcRenderer.invoke('ffgui:captureFrame', payload),
  // 本地路径转 file:// URL（<video> 播放本地文件用）
  pathToFileUrl: (p) => {
    // Windows 路径：C:\path\to\file -> file:///C:/path/to/file
    // macOS/Linux 路径：/path/to/file -> file:///path/to/file
    const normalized = p.replace(/\\/g, '/');
    return 'file:///' + normalized;
  },
});
