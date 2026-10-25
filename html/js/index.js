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
    if (feature === 'cdrip') {
      window.location.href = 'cdrip.html';
      return;
    }
    if (feature === 'dub') {
      window.location.href = 'dub.html';
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
