'use strict';

// 运行：node --test scripts/i18n.test.cjs
// 多语言（i18n）的静态契约测试：词典完整性、页面标注与词典一致性、
// HTML/JS 引用的键都存在、主进程语言解析与持久化、渲染层与 preload 的 API 接线。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
const PAGES = ['index', 'convert', 'merge', 'clip', 'crop', 'record', 'disc', 'dub'];
// 页面 -> 页面脚本清单：默认 html/js/<page>.js；disc.html 合并光盘抓取 + CD 抓轨，
// 拆成 dvd / cd 两个功能文件 + type 类型切换控制器
const PAGE_SCRIPTS = { disc: ['disc.dvd.js', 'disc.cd.js', 'disc.type.js'] };

const dicts = Object.fromEntries(LANGS.map((lng) => [
  lng, JSON.parse(fs.readFileSync(path.join(repo, 'locales', `${lng}.json`), 'utf8')),
]));

// 展平成点路径 → 字符串，便于比较键集合与占位符
function flatten(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

const flat = Object.fromEntries(LANGS.map((lng) => [lng, flatten(dicts[lng])]));
const zhKeys = Object.keys(flat['zh-CN']).sort();

function pageScriptFiles(page) {
  return (PAGE_SCRIPTS[page] || [`${page}.js`])
    .map((name) => path.join(repo, 'html', 'js', name))
    .filter((file) => fs.existsSync(file));
}

// 页面与脚本里出现的键（data-i18n / data-i18n-attr / data-i18n-title / t('...') / labelKey）
function referencedKeys() {
  const found = new Set();
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(repo, `html/${page}.html`), 'utf8');
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) found.add(m[1]);
    for (const m of html.matchAll(/data-i18n-title="([^"]+)"/g)) found.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) {
        const idx = pair.indexOf(':');
        if (idx >= 0) found.add(pair.slice(idx + 1).trim());
      }
    }
    for (const file of pageScriptFiles(page)) {
      const js = fs.readFileSync(file, 'utf8');
      for (const m of js.matchAll(/\bt\(\s*'([\w.-]+)'/g)) found.add(m[1]);
      for (const m of js.matchAll(/labelKey:\s*'([\w.-]+)'/g)) found.add(m[1]);
    }
  }
  return found;
}

test('词典：五种语言齐全、键集合一致、占位符一致、无空值', () => {
  assert.deepEqual(fs.readdirSync(path.join(repo, 'locales')).filter((f) => f.endsWith('.json')).sort(),
    LANGS.map((lng) => `${lng}.json`).sort(), 'locales/ 下应恰好有五个语言的词典');
  for (const lng of LANGS) {
    const keys = Object.keys(flat[lng]).sort();
    assert.deepEqual(keys, zhKeys, `${lng}.json 的键集合必须与 zh-CN 完全一致`);
    for (const key of keys) {
      assert.equal(typeof flat[lng][key], 'string', `${lng}：${key} 必须是字符串`);
      assert.ok(flat[lng][key].trim().length > 0, `${lng}：${key} 不得为空`);
      const vars = (text) => (text.match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join(',');
      assert.equal(vars(flat[lng][key]), vars(flat['zh-CN'][key]), `${lng}：${key} 的占位符必须与 zh-CN 一致`);
    }
  }
});

test('词典：页面与脚本引用的键全部存在，且无未使用的键', () => {
  const used = referencedKeys();
  const missing = [...used].filter((key) => !(key in flat['zh-CN']));
  assert.deepEqual(missing, [], 'HTML/JS 引用的键必须都在词典里');
  // 动态拼键（如预设表里的 tipKey、`t('convert.tip' + key)`）按「键名以字面量出现」认定已使用
  const corpus = PAGES.map((page) => fs.readFileSync(path.join(repo, `html/${page}.html`), 'utf8')
    + pageScriptFiles(page)
      .map((file) => fs.readFileSync(file, 'utf8')).join('\n')).join('\n')
    + fs.readFileSync(path.join(repo, 'html/js/theme.js'), 'utf8')
    + fs.readFileSync(path.join(repo, 'html/js/i18n.js'), 'utf8')
    // 主进程文案（报错 / 对话框标题 / 筛选器名）；新模块不存在时跳过，
    // 存在即计入语料，其词典键必须被真正引用
    + ['main/ffmpeg.js', 'main/disc.js', 'main/cdrip.js', 'main/i18n.js', 'main/dub.js']
      .map((file) => path.join(repo, file))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const unused = zhKeys.filter((key) => !used.has(key) && !corpus.includes(key));
  assert.deepEqual(unused, [], '词典里不应有页面未引用的键（避免堆积死文案）');
});

test('页面：i18n.js 先于 theme.js 与页面脚本加载，且标注了标题键', () => {
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(repo, `html/${page}.html`), 'utf8');
    const i18nIdx = html.indexOf('js/i18n.js');
    const themeIdx = html.indexOf('js/theme.js');
    // 页面脚本通常与页面同名（convert.html -> js/convert.js）；
    // disc.html 依次引入 js/disc.dvd.js → js/disc.cd.js → js/disc.type.js
    const pageIdx = Math.min(...(PAGE_SCRIPTS[page] || [`${page}.js`])
      .map((name) => html.indexOf(`js/${name}`))
      .filter((idx) => idx !== -1));
    assert.ok(i18nIdx !== -1, `${page}.html 须引入 js/i18n.js`);
    assert.ok(themeIdx !== -1, `${page}.html 须引入 js/theme.js`);
    assert.ok(i18nIdx < themeIdx && themeIdx < pageIdx,
      `${page}.html 加载顺序须为 i18n.js → theme.js → 页面脚本`);
    const title = html.match(/<html[^>]*data-i18n-title="([^"]+)"/);
    assert.ok(title, `${page}.html 的 <html> 须带 data-i18n-title`);
    assert.ok(title[1] in flat['zh-CN'], `${page}.html 的标题键 ${title[1]} 须在词典里`);
  }
});

test('渲染层：i18n.js 提供 t/applyStatic/onChange，且不依赖 fetch 或内联样式', () => {
  const src = fs.readFileSync(path.join(repo, 'html/js/i18n.js'), 'utf8');
  for (const name of ['window.i18n', 'applyStatic', 'onChange', 'data-i18n-attr', 'dataset.i18nTitle']) {
    assert.ok(src.includes(name), `i18n.js 须包含 ${name}`);
  }
  assert.ok(!/fetch\s*\(/.test(src), 'i18n.js 不得用 fetch（页面是 file:// + 严格 CSP，词典走 preload）');
  assert.ok(!/innerHTML\s*=\s*t\(/.test(src), '不得把译文拼进 innerHTML');
});

test('preload：暴露语言 API，且不额外扩大攻击面', () => {
  const src = fs.readFileSync(path.join(repo, 'preload/preload.js'), 'utf8');
  assert.match(src, /i18n:\s*i18nBoot/, 'preload 须暴露 i18n 快照');
  assert.match(src, /setLanguage:\s*\(value\)\s*=>/, 'preload 须暴露 setLanguage');
  assert.match(src, /onLanguageChanged:\s*\(callback\)/, 'preload 须暴露 onLanguageChanged');
  assert.match(src, /sendSync\('ffgui:i18n-sync'\)/, 'preload 须同步取一次词典（避免英文界面首帧闪中文）');
});

// ---------- 主进程：语言解析、持久化与 IPC ----------
function loadMainI18n(locale = 'zh-CN', config = null) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-i18n-'));
  if (config) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config), 'utf8');
  const handlers = {};
  const sent = [];
  const electron = {
    app: { getPath: () => userData, getLocale: () => locale },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (ch, data) => sent.push([ch, data]) } }],
    },
    ipcMain: {
      on: (ch, fn) => { handlers[ch] = fn; },
      handle: (ch, fn) => { handlers[ch] = fn; },
    },
    nativeTheme: {},
  };
  const ctx = {
    require: (n) => (n === 'electron' ? electron : require(n)),
    process, console: { log() {}, error() {} }, module: { exports: {} },
    __dirname: path.join(repo, 'main'),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, 'main/i18n.js'), 'utf8'), ctx);
  return { api: ctx.module.exports, handlers, sent, userData };
}

test('主进程：默认跟随系统并按 locale 解析', () => {
  const cases = { 'zh-CN': 'zh-CN', 'zh-HK': 'zh-TW', 'zh-TW': 'zh-TW', 'ja-JP': 'ja', 'ko-KR': 'ko', 'fr-FR': 'en' };
  for (const [locale, expect] of Object.entries(cases)) {
    const { api } = loadMainI18n(locale);
    api.init();
    assert.equal(api.getSetting(), 'system', `${locale}：默认设置应为 system`);
    assert.equal(api.getLanguage(), expect, `${locale} 应解析为 ${expect}`);
  }
});

test('主进程：持久化设置生效，非法值回退 system', () => {
  const saved = loadMainI18n('ja-JP', { language: 'ko' });
  saved.api.init();
  assert.equal(saved.api.getSetting(), 'ko', 'config.json 的 language 应生效');
  assert.equal(saved.api.getLanguage(), 'ko');

  const bad = loadMainI18n('zh-CN', { language: 'neon' });
  bad.api.init();
  assert.equal(bad.api.getSetting(), 'system', '非法语言值须回退为跟随系统');
});

test('主进程：切换语言持久化并向所有窗口广播词典', () => {
  const { api, handlers, sent, userData } = loadMainI18n('zh-CN');
  api.init();
  api.registerI18nIpc();

  // 同步取词：返回设置值、生效语言与词典
  const syncEvent = {};
  handlers['ffgui:i18n-sync'](syncEvent);
  assert.equal(syncEvent.returnValue.lang, 'zh-CN');
  assert.equal(typeof syncEvent.returnValue.dict, 'object');
  // vm 里构造的数组原型与本 realm 不同，按值比较
  assert.equal(Array.from(syncEvent.returnValue.available).join(','), LANGS.join(','));

  handlers['ffgui:language-set']({}, 'neon');
  assert.equal(api.getLanguage(), 'zh-CN', '非法语言值不得生效');
  assert.deepEqual(sent, [], '非法语言值不得广播');

  handlers['ffgui:language-set']({}, 'en');
  assert.equal(api.getLanguage(), 'en');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'ffgui:language-changed');
  assert.equal(sent[0][1].lang, 'en');
  assert.equal(typeof sent[0][1].dict, 'object', '广播须带新词典');
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(cfg.language, 'en', '语言设置须持久化到 config.json');
  assert.equal(cfg.theme, undefined, '不得覆盖其他字段（此处本就没有）');

  // 保留 config.json 里已有的 theme 字段
  const keep = loadMainI18n('zh-CN', { theme: 'dark' });
  keep.api.init();
  keep.api.registerI18nIpc();
  keep.handlers['ffgui:language-set']({}, 'ja');
  const cfgKeep = JSON.parse(fs.readFileSync(path.join(keep.userData, 'config.json'), 'utf8'));
  assert.equal(cfgKeep.theme, 'dark', '写语言不得冲掉主题设置');
  assert.equal(cfgKeep.language, 'ja');
});

test('主进程：t() 支持点路径、插值与回退键名', () => {
  const { api } = loadMainI18n('zh-CN');
  api.init();
  const { t } = api;
  // 中文措辞是回归测试的断言对象，必须保持与原实现逐字一致
  assert.equal(t('main.err.cancelled'), '已取消');
  assert.match(t('main.err.audioTrackInteger'), /整数/);
  assert.match(t('main.err.audioTrackRequired', { format: 'MP3' }), /^MP3 .*填写/);
  assert.match(t('main.err.audioTrackMissing', { n: 3 }), /没有第 3 条音轨/);
  assert.match(t('main.disc.errSubtitleExplicit', { titleId: '7' }), /显式选择不保留字幕/);
  assert.match(t('main.disc.errMp4Aac'), /仅支持 AAC/);
  assert.equal(t('main.dialog.pickMedia'), '选择音视频文件');
  assert.equal(t('不存在的键'), '不存在的键', '缺词须回退键名，便于发现漏词');
});

test('主进程：光盘页与渲染层词典都覆盖侧车缺失提示', () => {
  // 主进程返回已翻译文本、渲染层按 err.code 兜底，两处都要有对应文案
  assert.ok(flat['zh-CN']['main.disc.errSidecarMissing'], '主进程须有侧车缺失文案');
  assert.ok(flat['zh-CN']['disc.errSidecarMissing'], '渲染层须有侧车缺失兜底文案');
});
