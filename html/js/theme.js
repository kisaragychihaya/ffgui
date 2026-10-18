// 全局主题应用：所有页面最先加载（须先于各页面脚本）。
// 主进程把持久化的主题（system/light/dark）写入 nativeTheme.themeSource，
// 会强制渲染进程的 prefers-color-scheme，因此此处只监听 matchMedia
// 即可同时覆盖 跟随系统 / 浅色 / 深色 三种状态（system 时跟随 OS 变化）。
// 本脚本还向每个页面注入右上角的主题切换按钮（跟随系统 → 浅色 → 深色 循环）。
(function () {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    document.documentElement.dataset.theme = media.matches ? 'dark' : 'light';
  }
  applyTheme();
  media.addEventListener('change', applyTheme);

  // ---------- 主题切换按钮（各页面共用，由本脚本注入，样式见 style.css） ----------
  const ORDER = ['system', 'light', 'dark']; // 点击循环顺序
  const TITLE_KEYS = { system: 'theme.tipSystem', light: 'theme.tipLight', dark: 'theme.tipDark' };
  // 三个 SVG 图标按 data-mode 显隐（CSS 控制）
  const ICONS = {
    system: '<svg class="icon-theme-system" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
    light: '<svg class="icon-theme-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg class="icon-theme-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  let current = 'system'; // 当前设置（启动后由 getTheme() 同步为持久化值）

  function render(btn) {
    btn.dataset.mode = current;
    btn.title = window.i18n ? window.i18n.t(TITLE_KEYS[current]) : '';
  }

  function initToggle() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.innerHTML = ICONS.system + ICONS.light + ICONS.dark;
    document.body.appendChild(btn);
    render(btn);
    btn.addEventListener('click', () => {
      current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
      render(btn); // 本地立即反馈，广播回来后再幂等刷一次
      window.ffgui.setTheme(current);
    });
    // 启动时同步主进程持久化的主题设置
    window.ffgui.getTheme().then((theme) => { current = theme; render(btn); });
    // 其他页面/窗口触发的切换广播：同步图标与提示
    window.ffgui.onThemeChanged((theme) => { current = theme; render(btn); });
    // 界面语言切换后提示文案跟着变
    if (window.i18n) window.i18n.onChange(() => render(btn));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToggle);
  } else {
    initToggle();
  }
})();
