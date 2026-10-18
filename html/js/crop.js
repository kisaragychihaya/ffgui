// 画面裁剪页逻辑
// 单文件流程：选择视频 → 原生 <video> 播放并暂停在某帧 → 在视频实际显示画面上拖拽画框
// → 以归一化矩形 {x, y, w, h}（相对画面，0~1）交给主进程转码
// 浏览器放不了的格式会先生成一份低画质预览副本用于播放与画框，
// 预览副本与原片时间轴 1:1 对齐，最终转换始终使用原文件
(function () {
  const t = window.i18n.t;

  // 与主进程文件选择对话框保持一致的媒体扩展名
  const MEDIA_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v',
    'mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma']);

  // 选框最小边（归一化）：过小的框视为误触，直接判无效
  const MIN_CROP_SIZE = 0.01;
  // 归一化边界的钳制余量，仅吸收 0.1+0.2 这类浮点误差
  const EPS = 1e-6;
  // 画面矩形与元素矩形的重合容差（像素）：小于该值视为尚未布局完成
  const LAYOUT_EPS = 0.5;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    filePanel: $('file-panel'),
    pickFile: $('btn-pick-file'),
    fileDrop: $('file-drop'),
    fileInfo: $('file-info'),
    fileName: $('file-name'),
    fileMeta: $('file-meta'),
    previewTag: $('preview-tag'),
    playerPanel: $('player-panel'),
    outputPanel: $('output-panel'),
    actionPanel: $('action-panel'),
    stage: $('crop-stage'),
    video: $('video'),
    canvas: $('crop-canvas'),
    hint: $('crop-hint'),
    overlay: $('player-overlay'),
    play: $('btn-play'),
    timeCur: $('time-cur'),
    timeTotal: $('time-total'),
    seekBar: $('seek-bar'),
    volume: $('volume'),
    draw: $('btn-draw'),
    clearCrop: $('btn-clear-crop'),
    readout: $('crop-readout'),
    quality: $('sel-quality'),
    outdir: $('input-outdir'),
    pickDir: $('btn-pick-dir'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    status: $('status-text'),
    progressBar: $('progress-bar'),
    log: $('log-area'),
  };

  const state = {
    file: null,        // 原文件路径（转换对象，始终用原文件）
    probe: null,       // { duration, hasVideo, hasAudio, width, height, ... }
    duration: 0,
    playable: false,   // 视频元素已成功加载（含预览副本）
    usingPreview: false,
    busy: false,       // 生成预览中或转换中
    loading: 0,        // 加载序号：忽略过期文件的异步回调
    outputDir: null,   // null 表示与源文件相同
    drawing: false,    // 是否处于画框模式
    dragging: false,   // 指针是否正在拖动画框
    crop: null,        // 归一化选框 { x, y, w, h }；null 表示无有效选框
    drag: null,        // 拖拽起点（归一化）{ x, y }
  };

  // ---------- 工具 ----------
  function baseName(p) {
    return (p || '').split(/[\\/]/).pop();
  }

  function formatTime(s) {
    if (!s || !isFinite(s) || s < 0) s = 0;
    const millis = Math.round(s * 1000);
    s = Math.floor(millis / 1000);
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}.${String(millis % 1000).padStart(3, '0')}`;
  }

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  function showOverlay(text) {
    els.overlay.textContent = text;
    els.overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    els.overlay.classList.add('hidden');
  }

  // ---------- 画面几何：canvas 精确覆盖 <video> 的实际显示帧 ----------
  // 视频元素用 object-fit: contain，元素矩形内可能出现 letterbox 黑边；
  // 按内在宽高比算出真正的显示帧矩形（相对元素的 CSS 像素），
  // canvas 的 CSS 尺寸/位置与该矩形一致。命中换算与绘制都走归一化坐标，
  // 因此黑边不会算进坐标，窗口 resize 后选框也不漂移。
  function frameGeometry() {
    const v = els.video;
    const rect = v.getBoundingClientRect();
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh || rect.width < 1 || rect.height < 1) return null;
    const ar = vw / vh;
    let w = rect.width;
    let h = rect.height;
    if (rect.width / rect.height > ar) w = rect.height * ar; // 元素偏宽：左右黑边
    else h = rect.width / ar;                                // 元素偏高：上下黑边
    return { w, h, left: (rect.width - w) / 2, top: (rect.height - h) / 2 };
  }

  function syncCanvasGeometry() {
    const g = frameGeometry();
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    els.canvas.style.left = `${g.left}px`;
    els.canvas.style.top = `${g.top}px`;
    els.canvas.style.width = `${g.w}px`;
    els.canvas.style.height = `${g.h}px`;
    const bw = Math.max(1, Math.round(g.w * dpr));
    const bh = Math.max(1, Math.round(g.h * dpr));
    if (els.canvas.width !== bw) els.canvas.width = bw;
    if (els.canvas.height !== bh) els.canvas.height = bh;
    drawCrop();
  }

  // 指针坐标 → 归一化画面坐标（canvas 矩形即显示帧矩形，天然排除黑边）
  function pointerToNorm(e) {
    const rect = els.canvas.getBoundingClientRect();
    if (rect.width < LAYOUT_EPS || rect.height < LAYOUT_EPS) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  }

  // 归一化矩形 → canvas 的 CSS 像素矩形
  function normToPixels(r) {
    return {
      x: r.x * els.canvas.clientWidth,
      y: r.y * els.canvas.clientHeight,
      w: r.w * els.canvas.clientWidth,
      h: r.h * els.canvas.clientHeight,
    };
  }

  function drawCrop() {
    const ctx = els.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = els.canvas.clientWidth;
    const h = els.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!state.crop) return;

    const r = normToPixels(state.crop);
    // 选框之外压暗
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, w, r.y);
    ctx.fillRect(0, r.y + r.h, w, h - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, w - r.x - r.w, r.h);

    // 选框描边（内外双线，深色底 + 亮色边，任何画面都清晰）
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  // ---------- 选框状态 ----------
  function setCrop(crop) {
    // 归一化并吸收浮点误差，保证 x/y >= 0、x+w/y+h <= 1
    if (!crop) {
      state.crop = null;
    } else {
      const x = Math.min(1 - EPS, Math.max(0, crop.x));
      const y = Math.min(1 - EPS, Math.max(0, crop.y));
      const w = Math.min(1 - x, Math.max(0, crop.w));
      const h = Math.min(1 - y, Math.max(0, crop.h));
      state.crop = (w > 0 && h > 0) ? { x, y, w, h } : null;
    }
    drawCrop();
    updateReadout();
    updateStartButton();
  }

  function clearCrop() {
    setCrop(null);
    if (state.drawing) setDrawing(false);
  }

  function updateReadout() {
    const c = state.crop;
    if (!c) {
      els.readout.textContent = t('crop.readoutEmpty');
      els.clearCrop.disabled = true;
      return;
    }
    els.clearCrop.disabled = state.busy;
    // 只显示相对画面的百分比：probe 的宽高是 coded 尺寸，
    // 旋转 90° 或 SAR 非 1 时会与实际显示画面不符，像素估算会误导
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    els.readout.textContent = t('crop.readoutFmt', {
      x: pct(c.x), y: pct(c.y), w: pct(c.w), h: pct(c.h),
    });
  }

  function updateDrawLabel() {
    els.draw.textContent = state.drawing ? t('crop.btnStopDraw') : t('crop.btnDraw');
  }

  function updatePlayLabel() {
    els.play.textContent = els.video.paused ? t('crop.btnPlay') : t('crop.btnPause');
  }

  function setDrawing(on) {
    state.drawing = on;
    els.draw.classList.toggle('btn-active', on);
    updateDrawLabel();
    els.hint.classList.toggle('hidden', !on || !!state.crop);
    els.canvas.classList.toggle('drawing', on);
    // 画框模式下播放控件交给画面，暂停后才允许画框
    els.canvas.style.pointerEvents = on ? 'auto' : 'none';
    if (on) els.canvas.focus({ preventScroll: true });
  }

  // ---------- 控件可用性 ----------
  // canvas 覆盖视频实际显示帧：初始带 hidden，未加载/切换文件时保持隐藏；
  // 视频可播放（可画框）、正在绘制或已有选框时必须显示，
  // 退出绘制模式后仍保留选框（canvas 继续显示，选框不消失）。
  // 非绘制模式下 CSS 令 canvas pointer-events:none，不影响点击视频播放/暂停。
  // 注意 .hidden 是 display:none，会令 clientWidth 变 0，
  // 所以必须先取消隐藏再同步几何尺寸
  function updateCanvasVisibility() {
    els.canvas.classList.toggle('hidden', !state.playable);
  }

  function setBusy(busy) {
    state.busy = busy;
    els.cancel.classList.toggle('hidden', !busy);
    els.pickFile.disabled = busy;
    els.pickDir.disabled = busy;
    els.quality.disabled = busy;
    els.play.disabled = busy || !state.playable;
    els.seekBar.disabled = busy || !state.playable;
    els.volume.disabled = busy || !state.playable;
    els.clearCrop.disabled = busy || !state.crop;
    updateDrawButton();
    updateStartButton();
  }

  function updateDrawButton() {
    // 只有成功加载（含预览副本）、已暂停、没有任务在跑时才能画框
    els.draw.disabled = state.busy || !state.playable || !els.video.paused;
  }

  function updateStartButton() {
    // 有效选框拖完即自动退出绘制模式，因此这里只需挡住「拖拽中」与无效状态
    els.start.disabled = state.busy || !state.playable || !state.crop
      || state.dragging || state.drawing;
  }

  // ---------- 播放控制 ----------
  function togglePlay() {
    if (!state.playable) return;
    if (els.video.paused) els.video.play();
    else els.video.pause();
  }

  els.play.addEventListener('click', togglePlay);
  els.video.addEventListener('click', () => {
    // 画框模式下点击画面不再触发播放/暂停
    if (state.drawing || state.dragging) return;
    togglePlay();
  });
  els.video.addEventListener('play', () => {
    updatePlayLabel();
    // 播放中不允许画框：自动退出绘制模式并保留已有选框
    if (state.drawing) setDrawing(false);
    updateDrawButton();
  });
  els.video.addEventListener('pause', () => {
    updatePlayLabel();
    updateDrawButton();
  });
  els.video.addEventListener('timeupdate', () => {
    els.timeCur.textContent = formatTime(els.video.currentTime);
    if (document.activeElement !== els.seekBar) els.seekBar.value = els.video.currentTime;
  });
  els.video.addEventListener('loadedmetadata', () => {
    state.playable = true;
    hideOverlay();
    // 探测时长缺失时以媒体元素为准
    if (!state.duration && els.video.duration && isFinite(els.video.duration)) {
      state.duration = els.video.duration;
      initTimeline();
    }
    updateCanvasVisibility();   // 先取消 hidden，再同步几何（display:none 时 clientWidth 为 0）
    updateReadout();
    setBusy(state.busy);
    syncCanvasGeometry();
  });
  els.video.addEventListener('loadeddata', syncCanvasGeometry);
  els.video.addEventListener('resize', syncCanvasGeometry);
  els.seekBar.addEventListener('input', () => {
    els.video.currentTime = Number(els.seekBar.value);
  });
  els.volume.addEventListener('input', () => {
    els.video.volume = Number(els.volume.value);
  });

  // ---------- 时间轴初始化 ----------
  function initTimeline() {
    els.seekBar.max = state.duration;
    els.timeTotal.textContent = formatTime(state.duration);
  }

  // ---------- 画框交互（Pointer Events） ----------
  els.draw.addEventListener('click', () => {
    if (state.busy || !state.playable || !els.video.paused) return;
    if (state.drawing) {
      setDrawing(false);
    } else {
      // 重画：清除旧选框，从零开始拖拽
      setCrop(null);
      setDrawing(true);
    }
    updateStartButton();
  });

  els.clearCrop.addEventListener('click', clearCrop);

  els.canvas.addEventListener('pointerdown', (e) => {
    if (!state.drawing || state.busy || !els.video.paused) return;
    const p = pointerToNorm(e);
    if (!p) return;
    e.preventDefault();
    els.canvas.setPointerCapture(e.pointerId);
    state.dragging = true;
    state.drag = p;
    setCrop({ x: p.x, y: p.y, w: 0, h: 0 });
    els.hint.classList.add('hidden');
    updateStartButton();
  });

  els.canvas.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    const p = pointerToNorm(e);
    if (!p) return;
    const a = state.drag;
    // 任意方向拖拽：归一化为左上角 + 正宽高
    const x = Math.min(a.x, p.x);
    const y = Math.min(a.y, p.y);
    const w = Math.abs(p.x - a.x);
    const h = Math.abs(p.y - a.y);
    if (w < MIN_CROP_SIZE || h < MIN_CROP_SIZE) {
      // 过小的框直接无效，避免误触留下一个点的选框
      state.crop = null;
      drawCrop();
      updateReadout();
      updateStartButton();
      return;
    }
    setCrop({ x, y, w, h });
  });

  function endDrag(e, cancelled) {
    if (!state.dragging) return;
    state.dragging = false;
    if (e && e.pointerId !== undefined && els.canvas.hasPointerCapture(e.pointerId)) {
      els.canvas.releasePointerCapture(e.pointerId);
    }
    // 有效选框拖完即退出绘制模式：开始按钮立即可用，选框继续显示在画面上；
    // pointercancel 视为拖拽中断，保留绘制模式让用户重画
    if (!cancelled && state.crop) setDrawing(false);
    updateStartButton();
  }
  els.canvas.addEventListener('pointerup', (e) => endDrag(e, false));
  els.canvas.addEventListener('pointercancel', (e) => endDrag(e, true));

  // ---------- 文件加载 ----------
  function resetCrop() {
    state.crop = null;
    state.dragging = false;
    state.drag = null;
    if (state.drawing) setDrawing(false);
    updateReadout();
    updateStartButton();
  }

  async function loadFile(filePath) {
    if (state.busy || !filePath) return;
    const ticket = ++state.loading;

    const probes = await window.ffgui.probeMedia([filePath]);
    if (ticket !== state.loading) return; // 期间又加载了别的文件
    const p = probes[0];
    if (!p || (!p.hasVideo && !p.hasAudio)) {
      log(t('crop.logUnrecognized', { name: baseName(filePath) }));
      return;
    }
    if (!p.hasVideo) {
      log(t('crop.logNoVideo', { name: baseName(filePath) }));
      return;
    }

    state.file = filePath;
    state.probe = p;
    state.duration = p.duration || 0;
    state.playable = false;
    state.usingPreview = false;

    // 重置界面
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
    hideOverlay();
    resetCrop();
    updateCanvasVisibility();   // 切换文件：先隐藏 canvas，等新视频元数据就绪再显示
    els.previewTag.classList.add('hidden');
    els.fileDrop.classList.add('hidden');
    els.fileInfo.classList.remove('hidden');
    els.fileName.textContent = baseName(filePath);
    els.fileName.title = filePath;
    const size = p.width && p.height ? `${p.width}×${p.height}` : t('crop.unknownResolution');
    els.fileMeta.textContent = `[${formatTime(state.duration)} · ${size}]`;
    els.playerPanel.classList.remove('hidden');
    els.outputPanel.classList.remove('hidden');
    els.actionPanel.classList.remove('hidden');
    els.timeCur.textContent = '0:00:00';
    initTimeline();
    setBusy(false);
    els.status.textContent = '';

    els.video.src = window.ffgui.pathToFileUrl(filePath);
  }

  // 浏览器无法解码 → 让主进程转一份低码率预览副本再播
  els.video.addEventListener('error', () => {
    if (!state.file || state.busy || !els.video.getAttribute('src')) return;
    if (state.playable) return; // 播放中途的异常不重复触发
    if (state.usingPreview) {
      showOverlay(t('crop.overlayPreviewUnplayable'));
      return;
    }
    makePreview(state.loading);
  });

  async function makePreview(ticket) {
    setBusy(true);
    els.progressBar.style.setProperty('--progress-width', '0%');
    showOverlay(t('crop.overlayPreviewGenerating'));
    els.status.textContent = t('crop.statusPreview');

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'progress') {
        els.progressBar.style.setProperty('--progress-width', `${evt.percent}%`);
        els.status.textContent = t('crop.statusPreviewProgress', { percent: evt.percent })
          + (evt.speed ? `  ${evt.speed}` : '');
      }
    });

    try {
      const res = await window.ffgui.makePreview({
        input: state.file,
        hasVideo: state.probe.hasVideo,
        hasAudio: state.probe.hasAudio,
        duration: state.duration,
      });
      if (ticket !== state.loading) return;
      if (res.ok && res.output) {
        state.usingPreview = true;
        els.previewTag.classList.remove('hidden');
        els.progressBar.style.setProperty('--progress-width', '100%');
        els.status.textContent = t('crop.statusPreviewDone');
        els.video.src = window.ffgui.pathToFileUrl(res.output);
      } else {
        showOverlay(res.cancelled ? t('crop.overlayPreviewCancelled') : t('crop.overlayPreviewFailed'));
        els.status.textContent = res.cancelled ? t('crop.statusCancelled') : t('crop.statusPreviewFailed');
      }
    } catch (err) {
      showOverlay(t('crop.overlayPreviewFailed'));
      log(t('crop.logPreviewFailed', { err: String(err && err.message || err) }));
    } finally {
      off();
      if (ticket === state.loading) setBusy(false);
    }
  }

  // ---------- 转换流程 ----------
  async function startConvert() {
    // 契约：必须有原文件、可播放、有效选框，且没有任务在跑、没有正在绘制/拖拽
    if (state.busy || !state.file || !state.playable || !state.crop) return;
    if (state.dragging || state.drawing) return;

    setBusy(true);
    els.progressBar.style.setProperty('--progress-width', '0%');
    els.log.classList.add('hidden');
    els.log.textContent = '';

    // 归一化选框：x/y >= 0，w/h > 0，x+w/y+h <= 1（浮点误差已在 setCrop 中吸收）。
    // 保存的是相对画面的比例，预览副本上选的框按原视频实际分辨率等比例换算
    const crop = {
      x: state.crop.x,
      y: state.crop.y,
      w: state.crop.w,
      h: state.crop.h,
    };

    const job = {
      inputs: [state.file],      // 单文件；预览副本只用于画框，转换始终用原文件
      outputDir: state.outputDir,
      format: 'mp4',
      vcodec: 'libx264',
      acodec: 'aac',
      pixFmt: 'yuv420p',
      quality: els.quality.value,
      crop,
      // 其余字段按现有转码页默认语义填写
      devicePreset: '',
      sampleOnly: false,
      h264Profile: '',
      h264Level: '',
      fps: '',
      channels: '',
      sampleRate: '',
      id3Version: '3',
      preserveMetadata: true,
      preserveCover: true,
      audioTrack: '',           // 留空保留全部音轨
      hwaccel: 'auto',
      hdr2sdr: false,
      vbitrate: 0,
      vrateMode: 'vbr',
      abitrate: 0,
      scale: null,
    };

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'file-start') {
        els.status.textContent = `(${evt.index + 1}/1) ${baseName(evt.input)}`;
      } else if (evt.type === 'progress') {
        els.progressBar.style.setProperty('--progress-width', `${evt.percent}%`);
        els.status.textContent = t('crop.statusConverting', {
          percent: evt.percent,
          time: formatTime(evt.time),
          duration: formatTime(evt.duration),
        }) + (evt.speed ? `  ${evt.speed}` : '');
      } else if (evt.type === 'file-done') {
        log(t('crop.logDone', { output: evt.output }));
      } else if (evt.type === 'file-warning') {
        log(t('crop.logWarning', { name: baseName(evt.input), text: evt.warning }));
      } else if (evt.type === 'file-error') {
        log(t('crop.logError', { name: baseName(evt.input), text: evt.error }));
      }
    });

    try {
      const result = await window.ffgui.convert(job);
      const current = els.progressBar.style.getPropertyValue('--progress-width');
      els.progressBar.style.setProperty('--progress-width', result.done === result.total ? '100%' : current);
      els.status.textContent = result.cancelled
        ? t('crop.statusCancelled')
        : (result.done === result.total ? t('crop.statusDone') : t('crop.statusFailedSeeLog'));
    } catch (err) {
      log(t('crop.logFailed', { err: String(err && err.message || err) }));
      els.status.textContent = t('crop.statusFailed');
    } finally {
      off();
      setBusy(false);
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => { window.location.href = 'index.html'; });
  els.pickFile.addEventListener('click', async () => {
    const paths = await window.ffgui.pickMediaFiles();
    if (paths.length > 0) loadFile(paths[0]);
  });
  els.pickDir.addEventListener('click', async () => {
    const dir = await window.ffgui.pickDirectory();
    if (dir) {
      state.outputDir = dir;
      els.outdir.value = dir;
    }
  });
  els.start.addEventListener('click', startConvert);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cancelConvert();
    els.status.textContent = t('crop.statusCancelling');
  });

  // 快捷键：空格=播放/暂停，Esc=清除选框
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' && e.target.type === 'text';
    if (e.key === ' ') {
      if (typing || !state.playable || state.busy) return;
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'Escape' && !typing) {
      if (state.crop || state.drawing) clearCrop();
    }
  });

  // ---------- 画布尺寸：devicePixelRatio 与窗口 resize ----------
  // resize 时选框按归一化坐标重绘，位置与比例不漂移
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(syncCanvasGeometry);
  });
  if (window.ResizeObserver) {
    new ResizeObserver(syncCanvasGeometry).observe(els.stage);
  }
  syncCanvasGeometry();

  // ---------- 拖拽加载文件 ----------
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  els.filePanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!state.busy) els.filePanel.classList.add('drag-over');
  });
  els.filePanel.addEventListener('dragleave', (e) => {
    if (!els.filePanel.contains(e.relatedTarget)) {
      els.filePanel.classList.remove('drag-over');
    }
  });
  els.filePanel.addEventListener('drop', (e) => {
    e.preventDefault();
    els.filePanel.classList.remove('drag-over');
    if (state.busy) return;
    for (const file of e.dataTransfer.files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!MEDIA_EXTS.has(ext)) continue;
      const p = window.ffgui.getPathForFile(file);
      if (p) {
        loadFile(p);
        return; // 只取第一个可用文件
      }
    }
    log(t('crop.logNoMediaFile'));
  });

  // ---------- 语言切换：重刷本页生成的动态文案 ----------
  // 静态标注由 i18n.js 的 applyStatic 处理；这里补画框读数、按钮标签与播放态
  window.i18n.onChange(() => {
    updateReadout();
    updateDrawLabel();
    updatePlayLabel();
  });

  // 初始文案（结构上等同 HTML 里的中文默认值，仅随语言变化）
  updateReadout();
  updateDrawLabel();
  updatePlayLabel();
})();
