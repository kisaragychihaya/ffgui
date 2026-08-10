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
});
