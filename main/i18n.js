// 多语言：词典加载、t() 插值、系统语言映射、语言设置持久化与 IPC 广播。
// 词典放在项目根 locales/<lng>.json（打包后在 asar 内，主进程 fs 可直接读）。
// 与 main/theme.js 共用 userData/config.json：两边都按「读 → 合并 → 写」处理，互不覆盖字段。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const SUPPORTED = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']; // 支持的语言
const FALLBACK = 'zh-CN'; // 缺词与词典缺失时的回退语言
const SETTINGS = ['system', ...SUPPORTED]; // 可持久化的设置值，system = 跟随系统

const dicts = {}; // 已加载词典缓存 { lang: dict }
let setting = 'system'; // 持久化设置值
let current = FALLBACK; // 实际生效语言（setting 为 system 时按系统 locale 解析）

// 词典目录：__dirname 为 main/，开发与打包后（asar 内）相对布局一致
function localesDir() {
  return path.join(__dirname, '..', 'locales');
}

function loadDict(lang) {
  if (dicts[lang]) return dicts[lang];
  try {
    dicts[lang] = JSON.parse(fs.readFileSync(path.join(localesDir(), `${lang}.json`), 'utf8'));
  } catch (err) {
    // 缺文件不报错（未内置该语种时静默回退）；解析失败才提示
    if (err.code !== 'ENOENT') console.error(`[ffgui] 读取词典 ${lang} 失败:`, err.message);
    dicts[lang] = lang === FALLBACK ? {} : loadDict(FALLBACK);
  }
  return dicts[lang];
}

function lookup(dict, key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(text, vars) {
  if (!vars) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g,
    (match, name) => (vars[name] === undefined ? match : String(vars[name])));
}

// t('main.error.audioTrackMissing') / t('main.dialog.saveFrame')
function t(key, vars) {
  let text = lookup(loadDict(current), key);
  if (text === undefined) text = lookup(loadDict(FALLBACK), key);
  if (text === undefined) return key; // 漏词时直接把键名显示出来，便于发现
  return interpolate(text, vars);
}

// 系统 locale 映射：zh → zh-CN，zh-TW/HK/MO → zh-TW，ja → ja，ko → ko，其余 → en
function detectSystemLang(locale) {
  const value = String(locale || '').toLowerCase();
  if (value.startsWith('zh')) return /tw|hk|mo|hant/.test(value) ? 'zh-TW' : 'zh-CN';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return 'en';
}

function systemLocale() {
  try {
    return app.getLocale();
  } catch {
    return ''; // 非 Electron 环境（测试）时按映射默认值
  }
}

function applySetting(value) {
  setting = SETTINGS.includes(value) ? value : 'system';
  current = setting === 'system' ? detectSystemLang(systemLocale()) : setting;
}

function getLanguage() {
  return current;
}

function getSetting() {
  return setting;
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {}; // 文件不存在或损坏时按空配置处理
  }
}

// 只写 language 字段，保留 theme 等其他字段
function saveSetting(value) {
  const cfg = readConfig();
  cfg.language = value;
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('[ffgui] 保存语言设置失败:', err.message);
  }
}

// 下发给渲染层的完整状态：设置值 + 生效语言 + 词典（渲染层无需再取一次）
function payload() {
  return {
    setting,
    lang: current,
    dict: loadDict(current),
    fallback: loadDict(FALLBACK),
    available: SUPPORTED,
  };
}

// 启动时应用持久化设置（缺省跟随系统）
function init() {
  const cfg = readConfig();
  applySetting(cfg.language);
}

function registerI18nIpc() {
  // 预加载脚本在页面脚本执行前同步取一次，避免英文界面首帧闪中文
  ipcMain.on('ffgui:i18n-sync', (event) => {
    event.returnValue = payload();
  });

  // 切换语言：持久化 → 设当前语言（后续主进程报错用新语言）→ 向所有窗口广播新词典
  ipcMain.on('ffgui:language-set', (event, value) => {
    if (!SETTINGS.includes(value)) return;
    saveSetting(value);
    applySetting(value);
    const data = payload();
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('ffgui:language-changed', data);
    });
  });
}

module.exports = {
  SUPPORTED,
  FALLBACK,
  SETTINGS,
  t,
  getLanguage,
  getSetting,
  detectSystemLang,
  init,
  registerI18nIpc,
};
