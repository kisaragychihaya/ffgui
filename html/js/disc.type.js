// 光盘页类型切换控制器：用户先选光盘类型（视频光盘 / 音乐 CD），
// 再按 typePanels() 显隐对应的功能区面板。两侧功能逻辑分别在
// disc.dvd.js / disc.cd.js 的 IIFE 里，跨 IIFE 通信只经
// window.__ffguiDiscPage / window.__ffguiCdPage 两个最小钩子
// （查询运行状态、惰性枚举光驱），不触碰两侧内部状态。
(function () {
  // ---------- 纯逻辑开始 ----------
  const t = (key, vars) => (typeof window !== 'undefined' && window.i18n ? window.i18n.t(key, vars) : key);

  // 目标类型 + 两侧运行状态 -> 是否允许切换；任一侧任务进行中都禁止
  function canSwitchType(target, running) {
    if (target !== 'video' && target !== 'cd') return false;
    if (running && (running.disc || running.cd)) return false;
    return true;
  }

  // 类型 -> 该侧应显示的面板 id；未知类型返回空数组
  function typePanels(type) {
    if (type === 'video') return ['source-panel', 'titles-panel', 'output-panel', 'action-panel'];
    if (type === 'cd') return ['cd-source-panel', 'tracks-panel', 'meta-panel', 'cd-output-panel', 'cd-action-panel'];
    return [];
  }
  // ---------- 纯逻辑结束 ----------

  // ---------- DOM ----------
  const ALL_PANELS = [...typePanels('video'), ...typePanels('cd')];
  const DRIVE_SELECTS = { video: 'sel-drive', cd: 'cd-sel-drive' };

  const hint = document.getElementById('type-hint');
  const optionButtons = Array.from(document.querySelectorAll('.type-option'));
  let currentType = null;

  // 按类型显隐两组外壳面板：typePanels(type) 内的显示，其余全部隐藏。
  // 面板内部状态（探测结果、选轨等）由各侧 IIFE 自行管理。
  function applyPanels(type) {
    const visible = new Set(typePanels(type));
    for (const id of ALL_PANELS) {
      document.getElementById(id).classList.toggle('hidden', !visible.has(id));
    }
  }

  // 目标侧光驱下拉仍是占位（无选项）时，经钩子惰性枚举一次
  function ensureDrives(type) {
    const select = document.getElementById(DRIVE_SELECTS[type]);
    const page = type === 'video' ? window.__ffguiDiscPage : window.__ffguiCdPage;
    if (select && page && select.options.length <= 1) page.refreshDrives();
  }

  function setType(type) {
    const running = {
      disc: window.__ffguiDiscPage ? window.__ffguiDiscPage.isRunning() : false,
      cd: window.__ffguiCdPage ? window.__ffguiCdPage.isRunning() : false,
    };
    if (!canSwitchType(type, running)) {
      hint.textContent = t('disc.typeSwitchRunning');
      return;
    }
    currentType = type;
    for (const btn of optionButtons) {
      btn.classList.toggle('selected', btn.dataset.discType === type);
    }
    applyPanels(type);
    hint.textContent = '';
    ensureDrives(type);
  }

  for (const btn of optionButtons) {
    btn.addEventListener('click', () => setType(btn.dataset.discType));
  }

  // 返回首页统一收口到这里：任一侧任务进行中都拦截并提示（文案与原来两侧一致），
  // 避免两侧各绑一个监听时「另一侧在跑」被先执行的监听直接放走页面；
  // 刷新/关闭窗口的拦截仍由两侧各自的 beforeunload 负责。
  document.getElementById('btn-back').addEventListener('click', () => {
    const discRunning = window.__ffguiDiscPage ? window.__ffguiDiscPage.isRunning() : false;
    const cdRunning = window.__ffguiCdPage ? window.__ffguiCdPage.isRunning() : false;
    if (discRunning || cdRunning) {
      hint.textContent = t('disc.logBackRunning');
      return;
    }
    window.location.href = 'index.html';
  });

  // 初始：两组功能区全部隐藏，提示先选类型（初始 class 与 HTML 一致，这里再收紧一次）
  applyPanels(null);
  hint.textContent = t('disc.typeHintNone');

  // 语言切换后重刷提示（卡片标题/描述是 data-i18n 静态标注，由 i18n.js 自动刷新）
  if (window.i18n && typeof window.i18n.onChange === 'function') {
    window.i18n.onChange(() => {
      if (!currentType) hint.textContent = t('disc.typeHintNone');
    });
  }
})();
