// 界面多语言（渲染层）：所有页面最先加载（须先于 theme.js 与各页面脚本）。
//
// 词典来自 preload：window.ffgui.i18n = { setting, lang, dict, fallback, available }，
// 由预加载脚本同步取回，因此本脚本解析时即可用，不需要 await，也不会先闪中文。
//
// 用法：
// - 静态文案在元素上标 data-i18n="ns.key"（写 textContent）；
//   属性文案标 data-i18n-attr="placeholder:ns.key;title:ns.key"；
//   页面标题标在 <html data-i18n-title="ns.title">，本脚本同步 document.title 与 <html lang>。
// - 动态文案用 window.i18n.t('ns.key', { var })，支持点路径与 {{var}} 插值；
//   缺键先回退 zh-CN 词典，再回退键名本身。
// - 动态生成的文案在 window.i18n.onChange(cb) 里重刷（静态部分 applyStatic 自动处理）。
// - 语言切换经 window.ffgui.setLanguage(value) 走主进程持久化并广播，所有窗口一起生效。
(function () {
  const boot = (window.ffgui && window.ffgui.i18n) || {};
  let lang = boot.lang || 'zh-CN';
  let dict = boot.dict || {};
  let fallback = boot.fallback || {};
  let setting = boot.setting || 'system';
  const available = boot.available || ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
  const listeners = [];

  // 语言自称（用各自语言书写，不翻译）
  const NATIVE_NAMES = {
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
  };
  // 切换按钮上的短标签
  const SHORT_NAMES = { 'zh-CN': '中文', 'zh-TW': '繁中', en: 'EN', ja: '日本語', ko: '한국어' };

  function lookup(source, key) {
    let node = source;
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

  function t(key, vars) {
    if (!key) return '';
    let text = lookup(dict, key);
    if (text === undefined) text = lookup(fallback, key);
    if (text === undefined) return key;
    return interpolate(text, vars);
  }

  // 刷新静态标注：<html lang>、页面标题、data-i18n 文本、data-i18n-attr 属性
  function applyStatic() {
    document.documentElement.lang = lang;
    const titleKey = document.documentElement.dataset.i18nTitle;
    if (titleKey) document.title = t(titleKey);
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const idx = pair.indexOf(':');
        if (idx < 0) continue;
        const attr = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (attr && key) el.setAttribute(attr, t(key));
      }
    });
  }

  // ---------- 右上角语言菜单（各页面共用，由本脚本注入，样式见 style.css） ----------
  const GLOBE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 2.5 15.4 0 18"/><path d="M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>';
  let menuEls = null;

  function renderMenu() {
    if (!menuEls) return;
    const { toggle, toggleLabel, popup } = menuEls;
    toggleLabel.textContent = SHORT_NAMES[lang] || lang;
    toggle.title = t('lang.label');
    toggle.setAttribute('aria-label', t('lang.label'));
    // 当前生效语言提示（跟随系统时显示解析结果）
    popup.querySelectorAll('.lang-item').forEach((item) => {
      const value = item.dataset.lang;
      const active = value === setting;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
      const sub = item.querySelector('.lang-item-sub');
      if (sub && value === 'system') sub.textContent = NATIVE_NAMES[lang] || lang;
    });
  }

  function closeMenu() {
    if (!menuEls) return;
    menuEls.popup.classList.add('hidden');
    menuEls.toggle.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    if (!menuEls) return;
    renderMenu();
    menuEls.popup.classList.remove('hidden');
    menuEls.toggle.setAttribute('aria-expanded', 'true');
  }

  function initMenu() {
    if (menuEls || !document.body) return;
    const wrap = document.createElement('div');
    wrap.className = 'lang-menu';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lang-toggle';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = GLOBE_ICON;
    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'lang-toggle-label';
    toggle.appendChild(toggleLabel);

    const popup = document.createElement('div');
    popup.className = 'lang-popup hidden';
    popup.setAttribute('role', 'menu');

    // 「跟随系统」+ 各语种；语言名用各自语言书写，只有「跟随系统」走翻译
    const values = ['system', ...available];
    for (const value of values) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lang-item';
      item.dataset.lang = value;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      const name = document.createElement('span');
      name.className = 'lang-item-name';
      if (value === 'system') name.textContent = t('lang.system');
      else name.textContent = NATIVE_NAMES[value] || value;
      item.appendChild(name);
      if (value === 'system') {
        const sub = document.createElement('span');
        sub.className = 'lang-item-sub';
        item.appendChild(sub);
      }
      item.addEventListener('click', () => {
        closeMenu();
        // 本地先反馈（主进程广播回来会幂等再刷一次）
        setting = value;
        renderMenu();
        if (window.ffgui && window.ffgui.setLanguage) window.ffgui.setLanguage(value);
      });
      popup.appendChild(item);
    }

    wrap.appendChild(toggle);
    wrap.appendChild(popup);
    document.body.appendChild(wrap);
    menuEls = { toggle, toggleLabel, popup };

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (popup.classList.contains('hidden')) openMenu();
      else closeMenu();
    });
    document.addEventListener('click', (event) => {
      if (!popup.classList.contains('hidden') && !wrap.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });

    renderMenu();
  }

  // 主进程广播新语言：换词典 → 重刷静态文案 → 通知各页面重刷动态文案
  function apply(payload) {
    if (!payload || !payload.dict) return;
    setting = payload.setting || setting;
    lang = payload.lang || lang;
    dict = payload.dict;
    fallback = payload.fallback || fallback;
    applyStatic();
    renderMenu();
    for (const cb of listeners.slice()) {
      try {
        cb(lang);
      } catch (err) {
        console.error('[i18n] onChange 回调异常:', err);
      }
    }
  }

  window.i18n = {
    t,
    lang: () => lang,
    setting: () => setting,
    applyStatic,
    onChange(cb) {
      listeners.push(cb);
    },
  };

  applyStatic();
  if (window.ffgui && window.ffgui.onLanguageChanged) window.ffgui.onLanguageChanged(apply);

  // 脚本在 body 末尾，DOM 已解析；仍再挂一次以覆盖被移动到 <head> 引入的情况
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initMenu();
      applyStatic();
    });
  } else {
    initMenu();
  }
})();
