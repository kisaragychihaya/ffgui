const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 界面语言：同步取一次主进程状态（设置值 + 生效语言 + 词典），
// 页面脚本解析时即可用，英文界面首帧不会闪中文；主进程未就绪时按中文空词典兜底
let i18nBoot = { setting: 'system', lang: 'zh-CN', dict: {}, fallback: {}, available: ['zh-CN'] };
try {
  const boot = ipcRenderer.sendSync('ffgui:i18n-sync');
  if (boot && boot.dict) i18nBoot = boot;
} catch (err) {
  console.error('[ffgui] 读取界面语言失败，按中文显示:', err);
}

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
  // 字幕文件选择与时长探测（合并页可选字幕）
  pickSubtitle: () => ipcRenderer.invoke('ffgui:pickSubtitle'),
  probeSubtitle: (file) => ipcRenderer.invoke('ffgui:probeSubtitle', file),

  // 截取任务（无损切；进度事件复用 onConvertEvent，取消复用 cancelConvert）
  clip: (job) => ipcRenderer.invoke('ffgui:clip', job),
  // 浏览器放不了的格式：转一份低码率临时预览副本供播放定位
  makePreview: (job) => ipcRenderer.invoke('ffgui:makePreview', job),
  // 抓帧截图（主进程弹保存对话框，ffmpeg 从原文件抓一帧 PNG）
  captureFrame: (payload) => ipcRenderer.invoke('ffgui:captureFrame', payload),

  // 光盘抓取（ISO / 已提取目录 / 物理光驱；Rust 侧车探测抓取，内部 FFmpeg 转码）
  // 选轨语义：null/缺省=保留全部，显式 []=一条都不保留，非空数组=只保留指定轨
  discPickSource: (kind) => ipcRenderer.invoke('ffgui:disc-pick-source', kind),
  discPickKeydb: () => ipcRenderer.invoke('ffgui:disc-pick-keydb'),
  discListDrives: () => ipcRenderer.invoke('ffgui:disc-list-drives'),
  discProbe: (source) => ipcRenderer.invoke('ffgui:disc-probe', source),
  discStart: (job) => ipcRenderer.invoke('ffgui:disc-start', job),
  discCancel: (jobId) => ipcRenderer.invoke('ffgui:disc-cancel', jobId),
  onDiscEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ffgui:disc-event', listener);
    return () => ipcRenderer.removeListener('ffgui:disc-event', listener);
  },

  // CD 抓轨（音频 CD）：libcdio 读盘 + FFmpeg 编码 FLAC 无损，元数据可查 MusicBrainz
  // 设备名按平台归一：Windows 盘符 "E:"、macOS "/dev/rdiskN"、Linux "/dev/srN"
  cdListDrives: () => ipcRenderer.invoke('ffgui:cd-list-drives'),
  // 探测：读 TOC 得到轨列表、MusicBrainz DiscID 与 toc 查询串（不读音频数据）
  cdProbe: (device) => ipcRenderer.invoke('ffgui:cd-probe', device),
  // 元数据查询：toc -> 候选发行列表；releaseId -> 逐曲信息
  cdLookup: (toc) => ipcRenderer.invoke('ffgui:cd-lookup', toc),
  cdReleaseTracks: (releaseId) => ipcRenderer.invoke('ffgui:cd-release-tracks', releaseId),
  cdStart: (job) => ipcRenderer.invoke('ffgui:cd-start', job),
  cdCancel: (jobId) => ipcRenderer.invoke('ffgui:cd-cancel', jobId),
  onCdEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ffgui:cd-event', listener);
    return () => ipcRenderer.removeListener('ffgui:cd-event', listener);
  },

  // 字幕配音：视频 + 字幕文本合成语音作为新音轨混入视频
  // 状态含引擎（是否安装/运行）与模型（变体、已下载文件）；缺模型时经 dubDownloadModel 下载
  dubStatus: () => ipcRenderer.invoke('ffgui:dub-status'),
  // 引擎支持的发音语言（id + 词典键，渲染层用 t(dictKey) 显示）
  dubLanguages: () => ipcRenderer.invoke('ffgui:dub-languages'),
  // variant: 'Q4_K_M' | 'Q8_0'；mirror: 'official' | 'mirror'
  // 主进程按单个 payload 对象解构 { variant, mirror }
  dubDownloadModel: (variant, mirror) => ipcRenderer.invoke('ffgui:dub-download', { variant, mirror }),
  dubCancelDownload: () => ipcRenderer.invoke('ffgui:dub-cancel-download'),
  dubPickVideo: () => ipcRenderer.invoke('ffgui:dub-pick-video'),
  // 解析字幕为台词（cues: index/startMs/endMs/text，durationMs）
  dubParseSubtitle: (file) => ipcRenderer.invoke('ffgui:dub-parse-subtitle', file),
  dubStart: (job) => ipcRenderer.invoke('ffgui:dub-start', job),
  dubCancel: (jobId) => ipcRenderer.invoke('ffgui:dub-cancel', jobId),
  onDubEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ffgui:dub-event', listener);
    return () => ipcRenderer.removeListener('ffgui:dub-event', listener);
  },

  // 屏幕录制（渲染进程 getDisplayMedia + MediaRecorder 采集编码，分块写入主进程）  recordPickOutput: () => ipcRenderer.invoke('ffgui:recordPickOutput'),
  // 开始写盘：主进程显式创建输出文件流（同路径在录则报错，杜绝截断文件）
  recordStart: (targetPath) => ipcRenderer.invoke('ffgui:recordStart', targetPath),
  recordWriteChunk: (targetPath, buf) => ipcRenderer.invoke('ffgui:recordWriteChunk', targetPath, buf),
  recordFinish: (targetPath) => ipcRenderer.invoke('ffgui:recordFinish', targetPath),
  recordDiscard: (targetPath) => ipcRenderer.invoke('ffgui:recordDiscard', targetPath),
  // 录制结果 WebM 转 MP4（视频流复制 + 音频转 AAC；进度事件复用 onConvertEvent）
  recordRemux: (input) => ipcRenderer.invoke('ffgui:recordRemux', input),
  // 来源选择弹窗：枚举屏幕/窗口来源（含缩略图）
  getDesktopSources: () => ipcRenderer.invoke('ffgui:getDesktopSources'),
  // 选定来源后登记 id，随后调 getDisplayMedia 即被授予该来源
  prepareDesktopSource: (id) => ipcRenderer.invoke('ffgui:prepareDesktopSource', id),
  // 本地路径转 file:// URL（<video> 播放本地文件用）
  pathToFileUrl: (p) => {
    // Windows 路径：C:\path\to\file -> file:///C:/path/to/file
    // macOS/Linux 路径：/path/to/file -> file:///path/to/file
    const normalized = p.replace(/\\/g, '/');
    return 'file:///' + normalized;
  },

  // 主题（跟随系统/浅色/深色）：持久化与全局生效在主进程，切换后所有页面自动换肤
  getTheme: () => ipcRenderer.invoke('ffgui:theme-get'),
  setTheme: (theme) => ipcRenderer.send('ffgui:theme-set', theme),
  onThemeChanged: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on('ffgui:theme-changed', listener);
    return () => ipcRenderer.removeListener('ffgui:theme-changed', listener);
  },

  // 界面语言（跟随系统 / zh-CN / zh-TW / en / ja / ko）：词典随事件一起下发
  i18n: i18nBoot,
  setLanguage: (value) => ipcRenderer.send('ffgui:language-set', value),
  onLanguageChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ffgui:language-changed', listener);
    return () => ipcRenderer.removeListener('ffgui:language-changed', listener);
  },
});
