// 功能导航：首页卡片 <-> 功能页占位 的视图切换
(function () {
  const t = window.i18n.t;
  // 功能名走词典，键与首页卡片标题一致
  const FEATURE_KEYS = {
    convert: 'home.cardConvertTitle',
    merge: 'home.cardMergeTitle',
    clip: 'home.cardClipTitle',
    crop: 'home.cardCropTitle',
    record: 'home.cardRecordTitle',
    disc: 'home.cardDiscTitle',
  };
  let currentFeature = null;

  const homeView = document.getElementById('home-view');
  const featureView = document.getElementById('feature-view');
  const featureTitle = document.getElementById('feature-title');
  const featureName = document.getElementById('feature-name');
  const btnBack = document.getElementById('btn-back');

  function openFeature(feature) {
    // 已实现的功能跳转到独立页面
    if (feature === 'convert') {
      window.location.href = 'convert.html';
      return;
    }
    if (feature === 'merge') {
      window.location.href = 'merge.html';
      return;
    }
    if (feature === 'clip') {
      window.location.href = 'clip.html';
      return;
    }
    if (feature === 'crop') {
      window.location.href = 'crop.html';
      return;
    }
    if (feature === 'record') {
      window.location.href = 'record.html';
      return;
    }
    if (feature === 'disc') {
      window.location.href = 'disc.html';
      return;
    }
    if (feature === 'dub') {
      window.location.href = 'dub.html';
      return;
    }
    if (feature === 'imgconv') {
      window.location.href = 'imgconv.html';
      return;
    }
    if (!FEATURE_KEYS[feature]) return;
    currentFeature = feature;
    renderFeatureName();
    homeView.classList.add('hidden');
    featureView.classList.remove('hidden');
  }

  function renderFeatureName() {
    if (!currentFeature) return;
    const name = t(FEATURE_KEYS[currentFeature]);
    featureTitle.textContent = name;
    featureName.textContent = name;
  }

  function goHome() {
    featureView.classList.add('hidden');
    homeView.classList.remove('hidden');
  }

  document.querySelectorAll('.feature-card').forEach((card) => {
    card.addEventListener('click', () => openFeature(card.dataset.feature));
  });

  btnBack.addEventListener('click', goHome);

  // 清除 ffmpeg 能力缓存（下次进入转码页时重新探测硬件）
  const btnClearCache = document.getElementById('btn-clear-cache');
  const CLEAR_TEXT_KEY = 'home.clearCache';
  btnClearCache.addEventListener('click', async () => {
    btnClearCache.disabled = true;
    try {
      await window.ffgui.clearCapsCache();
      btnClearCache.textContent = t('home.cacheCleared');
    } catch {
      btnClearCache.textContent = t('home.cacheClearFailed');
    }
    setTimeout(() => {
      btnClearCache.textContent = t(CLEAR_TEXT_KEY);
      btnClearCache.disabled = false;
    }, 2000);
  });

  // 语言切换：占位视图里动态写入的功能名需要重刷（静态文案由 data-i18n 自动刷新）
  window.i18n.onChange(renderFeatureName);
})();

// 自动更新横幅：主进程推送的状态驱动文案与按钮（点「稍后」本次启动不再提示）
(function initUpdateBanner() {
  const ffgui = window.ffgui;
  const banner = document.getElementById('update-banner');
  if (!banner || !ffgui || !ffgui.onUpdaterEvent) return;
  const t = window.i18n.t;
  const textEl = document.getElementById('update-banner-text');
  const btnApply = document.getElementById('update-banner-apply');
  const btnLater = document.getElementById('update-banner-later');
  const btnClose = document.getElementById('update-banner-close');

  // 已点「稍后」的版本：同一窗口会话内不再提示（下载好的包保留，重启后照常提示）
  const DISMISS_KEY = 'ffgui-updater-dismissed';
  let payload = null;
  let gotEvent = false;
  let dismissedVersion = readDismissed();

  function readDismissed() {
    try {
      return sessionStorage.getItem(DISMISS_KEY) || '';
    } catch {
      return '';
    }
  }

  function rememberDismissed(version) {
    dismissedVersion = version || '';
    try {
      if (dismissedVersion) sessionStorage.setItem(DISMISS_KEY, dismissedVersion);
      else sessionStorage.removeItem(DISMISS_KEY);
    } catch {
      // 会话存储不可用时只在当前页面内生效
    }
  }

  function setActions(mode) {
    btnApply.classList.toggle('hidden', mode !== 'apply');
    btnLater.classList.toggle('hidden', mode !== 'apply');
    btnClose.classList.toggle('hidden', mode !== 'close');
  }

  function hideBanner() {
    banner.classList.add('hidden');
    setActions('');
  }

  function render() {
    const state = payload && payload.state;
    if (!state || state === 'none'
      || (state === 'downloaded' && payload.version && payload.version === dismissedVersion)) {
      hideBanner();
      return;
    }

    let message = '';
    let mode = '';
    if (state === 'checking') {
      message = t('updater.checking');
    } else if (state === 'available' || state === 'downloading') {
      const percent = Math.round(Math.min(1, Math.max(0, Number(payload.progress) || 0)) * 100);
      message = payload.apply === 'full'
        ? t('updater.downloadingFull', { version: payload.version || '', percent })
        : t('updater.downloading', { version: payload.version || '', percent });
    } else if (state === 'downloaded') {
      message = t('updater.downloaded', { version: payload.version || '' });
      mode = 'apply';
    } else if (state === 'applying') {
      message = t('updater.applying');
    } else if (state === 'error') {
      // 错误码只进控制台，不展示给用户
      console.error('[ffgui] 更新失败:', payload.error);
      message = payload.error === 'FFGUI_UPDATE_BUSY' ? t('updater.errorBusy') : t('updater.error');
      mode = 'close';
    } else {
      hideBanner();
      return;
    }

    textEl.textContent = message;
    setActions(mode);
    banner.classList.remove('hidden');
  }

  btnApply.addEventListener('click', async () => {
    btnApply.disabled = true;
    try {
      const next = await ffgui.updaterApply();
      if (next) {
        payload = next;
        gotEvent = true;
        render();
      }
    } catch (err) {
      console.error('[ffgui] 安装更新失败:', err);
    } finally {
      btnApply.disabled = false;
    }
  });

  btnLater.addEventListener('click', () => {
    rememberDismissed(payload && payload.version ? payload.version : '');
    render();
  });

  btnClose.addEventListener('click', hideBanner);

  ffgui.onUpdaterEvent((next) => {
    gotEvent = true;
    payload = next || null;
    render();
  });

  // 页面加载时同步一次当前状态，防止窗口创建前推送的事件丢失。
  // 自动更新仅在 Windows 安装版生效，其他平台没有注册 IPC，直接跳过
  if (ffgui.platform === 'win32' && typeof ffgui.updaterState === 'function') {
    ffgui.updaterState().then((snapshot) => {
      if (gotEvent) return; // 已有更新的事件，快照可能更旧
      payload = snapshot || null;
      render();
    }).catch((err) => {
      // 开发模式（未打包）不启用自动更新，按无状态处理
      console.log('[ffgui] 未获取更新状态:', err && err.message ? err.message : err);
    });
  }

  // 语言切换：动态文案重新取词
  window.i18n.onChange(render);
})();
