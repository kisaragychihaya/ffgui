// 功能导航：首页卡片 <-> 功能页占位 的视图切换
(function () {
  const FEATURE_NAMES = {
    convert: '音视频转码',
    merge: '音视频合并',
    clip: '音视频截取',
  };

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
    const name = FEATURE_NAMES[feature];
    if (!name) return;
    featureTitle.textContent = name;
    featureName.textContent = name;
    homeView.classList.add('hidden');
    featureView.classList.remove('hidden');
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
  const CLEAR_TEXT = '清除硬件信息缓存';
  btnClearCache.addEventListener('click', async () => {
    btnClearCache.disabled = true;
    try {
      await window.ffgui.clearCapsCache();
      btnClearCache.textContent = '已清除，将重新检测';
    } catch {
      btnClearCache.textContent = '清除失败';
    }
    setTimeout(() => {
      btnClearCache.textContent = CLEAR_TEXT;
      btnClearCache.disabled = false;
    }, 2000);
  });
})();
