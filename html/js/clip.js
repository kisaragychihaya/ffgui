// 音视频截取页逻辑（无损切 + 抓帧截图）
// 播放用原生 <video>；浏览器放不了的格式由主进程转一份低码率预览副本兜底，
// 副本与原片时间轴 1:1 对齐，截取与截图始终作用于原文件
(function () {
  // 与主进程文件选择对话框保持一致的媒体扩展名
  const MEDIA_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v',
    'mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma']);

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
    playerBox: $('player-box'),
    video: $('video'),
    overlay: $('player-overlay'),
    play: $('btn-play'),
    timeCur: $('time-cur'),
    timeTotal: $('time-total'),
    seekBar: $('seek-bar'),
    volume: $('volume'),
    inputStart: $('input-start'),
    inputEnd: $('input-end'),
    setStart: $('btn-set-start'),
    setEnd: $('btn-set-end'),
    capture: $('btn-capture'),
    sliderStart: $('slider-start'),
    sliderEnd: $('slider-end'),
    sliders: $('clip-sliders'),
    actionPanel: $('action-panel'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    status: $('status-text'),
    progressBar: $('progress-bar'),
    log: $('log-area'),
  };

  const state = {
    file: null,        // 原文件路径（截取/截图对象）
    probe: null,       // { duration, hasVideo, hasAudio }
    duration: 0,
    playable: false,   // 视频元素已成功加载（含预览副本）
    usingPreview: false,
    busy: false,       // 截取中或生成预览中
    loading: 0,        // 加载序号：忽略过期文件的异步回调
  };

  // ---------- 工具 ----------
  function baseName(p) {
    return p.split(/[\\/]/).pop();
  }

  function formatTime(s) {
    if (!s || !isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  // 支持 h:mm:ss / m:ss / 秒数（可带小数）；无法识别返回 null
  function parseTime(str) {
    const t = (str || '').trim();
    if (!t) return null;
    let m = t.match(/^(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
    if (m) return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    m = t.match(/^\d+(?:\.\d+)?$/);
    if (m) return Number(t);
    return null;
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

  function setBusy(busy) {
    state.busy = busy;
    els.cancel.classList.toggle('hidden', !busy);
    els.pickFile.disabled = busy;
    els.capture.disabled = busy || !state.playable || !state.probe || !state.probe.hasVideo;
    updateStartButton();
  }

  function updateStartButton() {
    els.start.disabled = state.busy || !state.playable;
  }

  // ---------- 起止时间同步 ----------
  function setRange(start, end) {
    start = Math.max(0, Math.min(start, state.duration));
    end = Math.max(0, Math.min(end, state.duration));
    if (start > end) [start, end] = [end, start];
    els.sliderStart.value = start;
    els.sliderEnd.value = end;
    els.inputStart.value = formatTime(start);
    els.inputEnd.value = formatTime(end);
    els.inputStart.classList.remove('invalid');
    els.inputEnd.classList.remove('invalid');
    // 更新双滑块轨道上绿色区间的起止位置
    const d = state.duration || 1;
    els.sliders.style.setProperty('--range-a', start / d);
    els.sliders.style.setProperty('--range-b', end / d);
  }

  function getRange() {
    return { start: Number(els.sliderStart.value), end: Number(els.sliderEnd.value) };
  }

  // 滑块拖动：钳制在另一侧之内，并 seek 预览对应位置。
  // 两个滑块重叠时把刚拖动的那个提到上层，保证还能往回拖
  els.sliderStart.addEventListener('input', () => {
    const end = Number(els.sliderEnd.value);
    let v = Number(els.sliderStart.value);
    if (v > end) v = end;
    setRange(v, end);
    els.sliders.classList.toggle('start-on-top', v >= end);
    els.video.currentTime = v;
  });
  els.sliderEnd.addEventListener('input', () => {
    const start = Number(els.sliderStart.value);
    let v = Number(els.sliderEnd.value);
    if (v < start) v = start;
    setRange(start, v);
    els.sliders.classList.toggle('start-on-top', false);
    els.video.currentTime = v;
  });

  // 输入框手动修改（失焦或回车生效）
  function bindTimeInput(input, isStart) {
    const apply = () => {
      const v = parseTime(input.value);
      const r = getRange();
      if (v === null || v > state.duration) {
        input.classList.add('invalid');
        return;
      }
      if (isStart) setRange(Math.min(v, r.end), r.end);
      else setRange(r.start, Math.max(v, r.start));
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  }
  bindTimeInput(els.inputStart, true);
  bindTimeInput(els.inputEnd, false);

  els.setStart.addEventListener('click', () => {
    setRange(Math.min(Math.floor(els.video.currentTime), Number(els.sliderEnd.value)),
      Number(els.sliderEnd.value));
  });
  els.setEnd.addEventListener('click', () => {
    setRange(Number(els.sliderStart.value),
      Math.max(Math.ceil(els.video.currentTime), Number(els.sliderStart.value)));
  });

  // ---------- 播放控制 ----------
  function togglePlay() {
    if (!state.playable) return;
    if (els.video.paused) els.video.play();
    else els.video.pause();
  }

  els.play.addEventListener('click', togglePlay);
  els.video.addEventListener('click', togglePlay);
  els.video.addEventListener('play', () => { els.play.textContent = '暂停'; });
  els.video.addEventListener('pause', () => { els.play.textContent = '播放'; });
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
    updateStartButton();
    els.capture.disabled = state.busy || !state.probe.hasVideo;
  });
  els.seekBar.addEventListener('input', () => {
    els.video.currentTime = Number(els.seekBar.value);
  });
  els.volume.addEventListener('input', () => {
    els.video.volume = Number(els.volume.value);
  });

  // 步进寻址
  document.querySelectorAll('.clip-step-group .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.playable) return;
      const step = Number(btn.dataset.step);
      els.video.currentTime = Math.max(0, Math.min(state.duration, els.video.currentTime + step));
    });
  });

  // ---------- 时间轴初始化 ----------
  function initTimeline() {
    for (const s of [els.seekBar, els.sliderStart, els.sliderEnd]) {
      s.max = state.duration;
    }
    els.timeTotal.textContent = formatTime(state.duration);
    setRange(0, state.duration);
  }

  // ---------- 文件加载 ----------
  async function loadFile(filePath) {
    if (state.busy || !filePath) return;
    const ticket = ++state.loading;

    const probes = await window.ffgui.probeMedia([filePath]);
    if (ticket !== state.loading) return; // 期间又加载了别的文件
    const p = probes[0];
    if (!p || (!p.hasVideo && !p.hasAudio)) {
      log(`✘ 无法识别的文件（无音视频流）：${baseName(filePath)}`);
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
    els.previewTag.classList.add('hidden');
    els.fileDrop.classList.add('hidden');
    els.fileInfo.classList.remove('hidden');
    els.fileName.textContent = baseName(filePath);
    els.fileName.title = filePath;
    els.fileMeta.textContent = `[${formatTime(state.duration)}]`;
    els.playerPanel.classList.remove('hidden');
    els.actionPanel.classList.remove('hidden');
    els.playerBox.classList.toggle('audio-only', !p.hasVideo);
    els.capture.disabled = true;
    els.timeCur.textContent = '0:00:00';
    initTimeline();
    updateStartButton();
    els.status.textContent = '';

    els.video.src = window.ffgui.pathToFileUrl(filePath);
  }

  // 浏览器无法解码 → 让主进程转一份低码率预览副本再播
  els.video.addEventListener('error', () => {
    if (!state.file || state.busy || !els.video.getAttribute('src')) return;
    if (state.playable) return; // 播放中途的异常不重复触发
    if (state.usingPreview) {
      showOverlay('预览生成后仍无法播放该文件');
      return;
    }
    makePreview(state.loading);
  });

  async function makePreview(ticket) {
    setBusy(true);
    els.progressBar.style.setProperty('--progress-width', '0%');
    showOverlay('该格式浏览器无法直接播放，正在生成低画质预览…');
    els.status.textContent = '正在生成预览…';

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'progress') {
        els.progressBar.style.setProperty('--progress-width', `${evt.percent}%`);
        els.status.textContent = `正在生成预览… ${evt.percent}%`
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
        els.status.textContent = '预览已生成（低画质，不影响输出）';
        els.video.src = window.ffgui.pathToFileUrl(res.output);
      } else {
        showOverlay(res.cancelled ? '已取消预览生成' : '预览生成失败，该文件无法预览');
        els.status.textContent = res.cancelled ? '已取消' : '预览生成失败';
      }
    } catch (err) {
      showOverlay('预览生成失败，该文件无法预览');
      log(`✘ 预览生成失败：${String(err && err.message || err)}`);
    } finally {
      off();
      if (ticket === state.loading) setBusy(false);
    }
  }

  // ---------- 抓帧截图 ----------
  els.capture.addEventListener('click', async () => {
    if (!state.file || !state.probe.hasVideo) return;
    const t = els.video.currentTime || 0;
    const base = baseName(state.file).replace(/\.[^.]+$/, '');
    const defaultName = `${base}_${formatTime(t).replace(/:/g, '')}.png`;
    try {
      const saved = await window.ffgui.captureFrame({
        input: state.file, // 始终从原文件抓帧，保证原分辨率
        time: t,
        defaultName,
      });
      if (saved) log(`✔ 已保存截图 → ${saved}`);
    } catch (err) {
      log(`✘ 截图失败：${String(err && err.message || err)}`);
    }
  });

  // ---------- 截取流程 ----------
  async function startClip() {
    if (!state.file || !state.playable) return;
    const start = parseTime(els.inputStart.value);
    const end = parseTime(els.inputEnd.value);
    if (start === null || end === null || end <= start) {
      els.status.textContent = '起止时间无效（终点必须大于起点）';
      return;
    }

    setBusy(true);
    els.progressBar.style.setProperty('--progress-width', '0%');

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'progress') {
        els.progressBar.style.setProperty('--progress-width', `${evt.percent}%`);
        els.status.textContent = `截取中… ${evt.percent}%  ${formatTime(evt.time)}/${formatTime(evt.duration)}`
          + (evt.speed ? `  ${evt.speed}` : '');
      } else if (evt.type === 'file-done') {
        log(`✔ 截取完成 → ${evt.output}`);
      } else if (evt.type === 'file-error') {
        log(`✘ 截取失败：${evt.error}`);
      }
    });

    try {
      const result = await window.ffgui.clip({ input: state.file, start, end });
      const currentWidth = els.progressBar.style.getPropertyValue('--progress-width');
      els.progressBar.style.setProperty('--progress-width', result.done === result.total ? '100%' : currentWidth);
      els.status.textContent = result.cancelled
        ? '已取消'
        : (result.done === result.total ? '截取完成' : '截取失败，详见日志');
    } catch (err) {
      log(`✘ 截取失败：${String(err && err.message || err)}`);
      els.status.textContent = '截取失败';
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

  // 快捷键：空格=播放/暂停，A=设为起点，D=设为终点
  // 在文本输入框里或按了修饰键时不响应；空格始终拦截，避免触发聚焦按钮/滚动页面
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' && e.target.type === 'text';
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      if (typing || !state.playable || state.busy) return;
      e.preventDefault();
      togglePlay();
    } else if (!typing && key === 'a') {
      if (state.playable) els.setStart.click();
    } else if (!typing && key === 'd') {
      if (state.playable) els.setEnd.click();
    }
  });
  els.start.addEventListener('click', startClip);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cancelConvert();
    els.status.textContent = '正在取消…';
  });

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
    log('✘ 未找到可用的音视频文件');
  });
})();
