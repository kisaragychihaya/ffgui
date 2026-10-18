// 屏幕录制页逻辑
// 来源选择：主进程 desktopCapturer 枚举屏幕/窗口（含缩略图）→ 弹窗选择 →
// prepareDesktopSource 登记 id → getDisplayMedia（主进程 handler 按登记授予
// 视频来源，系统声音用 'loopback' 回环，仅 Windows/Linux）；
// 编码在渲染进程 MediaRecorder（WebM），分块经 IPC 流式写入主进程
// （recordStart 显式建流，writeChunk 绝不事后新建，停止后的迟到分块会被拒绝，
// 杜绝截断已完成的文件）；录制结果可一键转 MP4（ffmpeg 视频流复制 +
// 音频转 AAC，进度复用 convert-event）
(function () {
  const t = window.i18n.t;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    pickSource: $('btn-pick-source'),
    sourceName: $('source-name'),
    sourceModal: $('source-modal'),
    sourceGrid: $('source-grid'),
    sourceClose: $('btn-source-close'),
    chkSysAudio: $('chk-sys-audio'),
    chkMic: $('chk-mic'),
    itemMicDevice: $('item-mic-device'),
    selMic: $('sel-mic'),
    preview: $('preview'),
    previewEmpty: $('preview-empty'),
    selQuality: $('sel-quality'),
    inputOutfile: $('input-outfile'),
    pickOutfile: $('btn-pick-outfile'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    remux: $('btn-remux'),
    recDot: $('rec-dot'),
    recTime: $('rec-time'),
    status: $('status-text'),
    progressTrack: $('progress-track'),
    progressBar: $('progress-bar'),
    log: $('log-area'),
  };

  // 画质档 -> MediaRecorder 视频码率（无 CRF 概念，只能控码率）
  const QUALITY_MAP = { high: 8000000, medium: 4000000, low: 2000000 };
  const MIME_CANDIDATES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
  ];

  const state = {
    captureStream: null,   // 采集到的原始流（可能含系统声音轨）
    sourceId: null,        // 已选来源 id（勾选系统声音后据此复用重采，免重开弹窗）
    sourceName: null,      // 已选来源名称
    micStream: null,       // 麦克风流
    mixCtx: null,          // 系统声音 + 麦克风双路混音的 AudioContext
    recording: false,
    recorder: null,
    outFile: null,         // 本次录制输出路径
    lastSaved: null,       // 最近一次成功保存的路径（转 MP4 用）
    writeChain: Promise.resolve(), // 分块写盘串行队列，保证顺序
    bytesWritten: 0,
    writeError: null,
    recordError: null,
    recTimer: null,
    busyRemux: false,
    starting: false,       // 开始流程进行中（防双击重复进入）
    stopping: false,       // 停止流程进行中（防重复停止）
    acceptChunks: false,   // 是否接收分块：停止流程发起后拒绝迟到分块
  };

  // ---------- 工具 ----------
  function formatTime(s) {
    if (!s || !isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  function errText(err) {
    return String((err && (err.message || err.name)) || err);
  }

  function pickMimeType() {
    for (const m of MIME_CANDIDATES) {
      if (window.MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  // 来源名：未选择时显示占位文案，已选择时显示来源名称
  function renderSourceName() {
    els.sourceName.textContent = state.sourceName || t('record.sourceNone');
  }

  function updateUI() {
    const rec = state.recording;
    els.start.textContent = rec ? t('record.btnStop') : t('record.btnStart');
    els.start.disabled = state.starting || state.stopping
      || (!rec && (!state.captureStream || state.busyRemux));
    els.cancel.classList.toggle('hidden', !rec);
    els.pickSource.disabled = rec || state.starting || state.busyRemux;
    els.pickOutfile.disabled = rec || state.starting || state.busyRemux;
    els.selQuality.disabled = rec || state.starting || state.busyRemux;
    els.chkSysAudio.disabled = rec;
    els.chkMic.disabled = rec;
    els.selMic.disabled = rec || !els.chkMic.checked;
    els.recDot.classList.toggle('hidden', !rec);
    els.recTime.classList.toggle('hidden', !rec);
  }

  // ---------- 来源选择 ----------
  function setCapture(stream, sourceName) {
    if (state.captureStream) {
      state.captureStream.getTracks().forEach((t) => t.stop());
    }
    state.captureStream = stream;
    els.preview.srcObject = stream;
    // muted + autoplay 仍需显式 play（部分环境 autoplay 属性不生效）
    const p = els.preview.play();
    if (p && p.catch) p.catch(() => {});
    els.previewEmpty.classList.add('hidden');
    els.sourceName.textContent = sourceName || t('record.sourceSelected');
    const audioTracks = stream.getAudioTracks();
    log(t('record.logSource', {
      name: els.sourceName.textContent,
      video: stream.getVideoTracks().length,
      audio: audioTracks.length,
    }) + (audioTracks.length
      ? t('record.logSourceAudio', { label: audioTracks[0].label, state: audioTracks[0].readyState })
      : ''));
    if (els.chkSysAudio.checked && audioTracks.length === 0) {
      els.status.textContent = t('record.errNoSysAudio')
        + (window.ffgui.platform === 'darwin'
          ? t('record.errNoSysAudioMac')
          : t('record.errNoSysAudioHint'));
    }
    updateUI();
  }

  // 来源网格里的提示行：建元素 + textContent，绝不把译文拼进 innerHTML
  function showSourceMessage(key) {
    els.sourceGrid.textContent = '';
    const p = document.createElement('p');
    p.className = 'record-source-empty';
    p.textContent = t(key);
    els.sourceGrid.appendChild(p);
  }

  async function openSourcePicker() {
    if (state.recording || state.starting || state.busyRemux) return;
    showSourceMessage('record.sourceEnumerating');
    els.sourceModal.classList.remove('hidden');
    let sources;
    try {
      sources = await window.ffgui.getDesktopSources();
    } catch (err) {
      els.sourceModal.classList.add('hidden');
      els.status.textContent = t('record.errEnumerate', { err: errText(err) });
      log(t('record.logEnumerateFailed', { err: errText(err) }));
      return;
    }
    if (!sources.length) {
      showSourceMessage('record.sourceEmpty');
      return;
    }
    els.sourceGrid.textContent = '';
    for (const s of sources) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'record-source-item';
      item.title = s.name;
      if (s.thumb) {
        const img = document.createElement('img');
        img.src = s.thumb;
        img.alt = s.name;
        item.appendChild(img);
      }
      const name = document.createElement('span');
      name.textContent = s.name;
      item.appendChild(name);
      item.addEventListener('click', () => chooseSource(s));
      els.sourceGrid.appendChild(item);
    }
  }

  async function chooseSource(s) {
    els.sourceModal.classList.add('hidden');
    els.status.textContent = t('record.statusStartingCapture');
    try {
      // 先登记来源，getDisplayMedia 时主进程 handler 按此授予
      await window.ffgui.prepareDesktopSource(s.id);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: els.chkSysAudio.checked,
      });
      setCapture(stream, s.name);
      state.sourceId = s.id;
      state.sourceName = s.name;
      els.status.textContent = t('record.statusSourceReady');
    } catch (err) {
      els.status.textContent = t('record.errCapture', { err: errText(err) });
      log(t('record.logCaptureFailed', { err: errText(err) }));
    }
  }

  // 勾选系统声音后按已选来源重新采集（复用 sourceId，不重新弹选择窗）；
  // 来源已失效（如窗口已关闭）时才回退打开选择窗
  async function reacquireSource() {
    if (!state.sourceId) {
      openSourcePicker();
      return;
    }
    els.status.textContent = t('record.statusReacquiring');
    try {
      await window.ffgui.prepareDesktopSource(state.sourceId);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: els.chkSysAudio.checked,
      });
      setCapture(stream, state.sourceName);
      els.status.textContent = t('record.statusReacquired');
    } catch (err) {
      state.sourceId = null;
      els.status.textContent = t('record.errReacquire', { err: errText(err) });
      log(t('record.logReacquireFailed', { err: errText(err) }));
      openSourcePicker();
    }
  }

  // ---------- 麦克风 ----------
  async function acquireMic() {
    const deviceId = els.selMic.value;
    stopMicStream();
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  }

  function stopMicStream() {
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }
  }

  async function fillMicDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    els.selMic.innerHTML = '';
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || t('record.micFallback', { n: i + 1 });
      els.selMic.appendChild(opt);
    });
    if (mics.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('record.micDefault');
      els.selMic.appendChild(opt);
    }
  }

  // ---------- 录制 ----------
  // 组装最终 MediaStream：视频轨 + （系统声音 / 麦克风 / 两者混音）音轨
  function buildRecordStream() {
    const tracks = state.captureStream.getVideoTracks().slice();
    const sysTracks = state.captureStream.getAudioTracks();
    const micTracks = (els.chkMic.checked && state.micStream)
      ? state.micStream.getAudioTracks() : [];
    if (sysTracks.length && micTracks.length) {
      state.mixCtx = new AudioContext();
      const dest = state.mixCtx.createMediaStreamDestination();
      state.mixCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
      state.mixCtx.createMediaStreamSource(new MediaStream(micTracks)).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
    } else if (sysTracks.length) {
      tracks.push(sysTracks[0]);
    } else if (micTracks.length) {
      tracks.push(micTracks[0]);
    }
    return new MediaStream(tracks);
  }

  function startTimer() {
    const t0 = Date.now();
    els.recTime.textContent = '0:00:00';
    state.recTimer = setInterval(() => {
      els.recTime.textContent = formatTime((Date.now() - t0) / 1000);
      els.status.textContent = t('record.statusRecordingMb', {
        mb: (state.bytesWritten / 1048576).toFixed(1),
      });
    }, 500);
  }

  function stopTimer() {
    if (state.recTimer) {
      clearInterval(state.recTimer);
      state.recTimer = null;
    }
  }

  async function startRecording() {
    // 防重入：开始流程的异步窗口（保存对话框等）内再次点击直接忽略
    if (state.starting || state.stopping || state.recording || state.busyRemux
        || !state.captureStream) return;
    state.starting = true;
    updateUI();
    try {
      // 系统声音校验：勾选了但当前来源没有音轨（多半是勾选发生在选择来源之后），
      // 录制出无声文件不如明确拦截
      if (els.chkSysAudio.checked && state.captureStream.getAudioTracks().length === 0) {
        els.status.textContent = t('record.errSysAudioMissing');
        return;
      }
      // 按当前勾选项与所选设备取麦克风
      if (els.chkMic.checked) {
        try {
          await acquireMic();
        } catch (err) {
          els.status.textContent = t('record.errMicUnavailable', { err: errText(err) });
          return;
        }
      } else {
        stopMicStream();
      }

      // 输出位置：未预选则弹保存对话框
      let outPath = state.outFile;
      if (!outPath) {
        try {
          outPath = await window.ffgui.recordPickOutput();
        } catch {
          outPath = null;
        }
        if (!outPath) {
          els.status.textContent = t('record.errNoOutput');
          return;
        }
        state.outFile = outPath;
        els.inputOutfile.value = outPath;
      }

      // 主进程显式创建输出流；同路径已在录制会报错（配合防重入杜绝并发写同一文件）
      try {
        await window.ffgui.recordStart(outPath);
      } catch (err) {
        els.status.textContent = t('record.errStartWrite', { err: errText(err) });
        return;
      }

      const stream = buildRecordStream();
      const options = {
        videoBitsPerSecond: QUALITY_MAP[els.selQuality.value] || QUALITY_MAP.medium,
        audioBitsPerSecond: 128000,
      };
      const mime = pickMimeType();
      if (mime) options.mimeType = mime;
      let recorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch {
        // 个别环境不支持码率选项时退化为默认参数
        try {
          recorder = new MediaRecorder(stream);
        } catch (err) {
          els.status.textContent = t('record.errRecorder', { err: errText(err) });
          try { await window.ffgui.recordDiscard(outPath); } catch { /* 忽略 */ }
          return;
        }
      }

      state.recorder = recorder;
      state.writeChain = Promise.resolve();
      state.bytesWritten = 0;
      state.writeError = null;
      state.recordError = null;
      state.acceptChunks = true;

      // 分块串行写入主进程；写盘失败时终止录制。
      // 注意：录制停止后迟到的分块会被主进程拒绝（流已关闭），这里先按 acceptChunks 丢弃
      recorder.ondataavailable = (e) => {
        if (!state.acceptChunks) return;
        if (!e.data || e.data.size === 0) return;
        state.writeChain = state.writeChain.then(async () => {
          const buf = await e.data.arrayBuffer();
          await window.ffgui.recordWriteChunk(outPath, buf);
          state.bytesWritten += buf.byteLength;
        }).catch((err) => {
          state.writeError = err;
          try { recorder.stop(); } catch { /* 已在停止 */ }
        });
      };
      recorder.onerror = (e) => {
        state.recordError = e.error || new Error(t('record.errRecorderMessage'));
      };
      recorder.start(1000);

      state.recording = true;
      els.remux.classList.add('hidden');
      els.status.textContent = t('record.statusRecording');
      startTimer();
    } finally {
      state.starting = false;
      updateUI();
    }
  }

  function waitRecorderStopped() {
    return new Promise((resolve) => {
      if (!state.recorder || state.recorder.state === 'inactive') {
        resolve();
        return;
      }
      state.recorder.addEventListener('stop', () => resolve(), { once: true });
    });
  }

  // save=true 停止并保存；save=false 取消并丢弃半成品
  async function stopRecording(save) {
    if (state.stopping) return;
    const recorder = state.recorder;
    if (!recorder) return;
    state.stopping = true;
    // 先关闭分块接收窗口，停止流程中迟到的 dataavailable 直接忽略
    state.acceptChunks = false;
    updateUI();

    const outPath = state.outFile;
    stopTimer();
    try {
      recorder.stop();
    } catch {
      // 可能已停止
    }
    await waitRecorderStopped();
    // 等最后一个分块写完
    try { await state.writeChain; } catch { /* 错误已记录在 state.writeError */ }
    if (state.mixCtx) {
      state.mixCtx.close().catch(() => {});
      state.mixCtx = null;
    }

    const failed = state.writeError || state.recordError;
    if (!save || failed) {
      try { await window.ffgui.recordDiscard(outPath); } catch { /* 忽略 */ }
      if (save) {
        els.status.textContent = t('record.errRecordFailed', { err: errText(failed) });
        log(t('record.logRecordFailed', { err: errText(failed) }));
      } else {
        els.status.textContent = t('record.statusCancelledCleaned');
      }
    } else {
      try {
        const res = await window.ffgui.recordFinish(outPath);
        if (res.ok) {
          state.lastSaved = res.path;
          const mb = (res.size / 1048576).toFixed(1);
          els.status.textContent = t('record.statusDone', { mb });
          log(t('record.logDone', { path: res.path, mb }));
          els.remux.classList.remove('hidden');
          // 下次录制重新询问保存位置
          state.outFile = null;
          els.inputOutfile.value = '';
        } else {
          els.status.textContent = t('record.errSave');
          log(t('record.logSaveFailed'));
        }
      } catch (err) {
        els.status.textContent = t('record.errSaveWith', { err: errText(err) });
        log(t('record.logSaveFailedWith', { err: errText(err) }));
      }
    }

    state.recording = false;
    state.recorder = null;
    state.writeError = null;
    state.recordError = null;
    state.stopping = false;
    updateUI();
  }

  // ---------- 录制结果转 MP4 ----------
  async function remuxToMp4() {
    if (!state.lastSaved || state.busyRemux) return;
    state.busyRemux = true;
    els.progressTrack.classList.remove('hidden');
    els.progressBar.style.setProperty('--progress-width', '0%');
    els.status.textContent = t('record.statusRemuxing');

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'progress') {
        els.progressBar.style.setProperty('--progress-width', `${evt.percent}%`);
        els.status.textContent = t('record.statusRemuxingProgress', { percent: evt.percent });
      } else if (evt.type === 'file-done') {
        log(t('record.logRemuxDone', { output: evt.output }));
      } else if (evt.type === 'file-error') {
        log(t('record.logRemuxFailed', { err: evt.error }));
      }
    });

    try {
      const res = await window.ffgui.recordRemux(state.lastSaved);
      els.progressBar.style.setProperty('--progress-width', res.done ? '100%' : '0%');
      els.status.textContent = res.done
        ? t('record.statusRemuxDone', { output: res.output })
        : (res.cancelled ? t('record.statusCancelled') : t('record.statusRemuxFailedSeeLog'));
    } catch (err) {
      log(t('record.logRemuxFailed', { err: errText(err) }));
      els.status.textContent = t('record.statusRemuxFailed');
    } finally {
      off();
      state.busyRemux = false;
      updateUI();
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => { window.location.href = 'index.html'; });
  // 录制中阻止离开页面（beforeunload 无对话框，仅拦截卸载）
  window.addEventListener('beforeunload', (e) => {
    if (state.recording) {
      e.preventDefault();
      e.returnValue = false;
      els.status.textContent = t('record.errLeaveWhileRecording');
    }
  });
  window.addEventListener('unload', () => {
    if (state.captureStream) state.captureStream.getTracks().forEach((t) => t.stop());
    stopMicStream();
  });

  els.pickSource.addEventListener('click', openSourcePicker);
  els.sourceClose.addEventListener('click', () => els.sourceModal.classList.add('hidden'));
  els.sourceModal.addEventListener('click', (e) => {
    if (e.target === els.sourceModal) els.sourceModal.classList.add('hidden');
  });
  els.start.addEventListener('click', async () => {
    if (state.recording || state.stopping) {
      await stopRecording(true);
    } else {
      await startRecording();
    }
  });
  els.cancel.addEventListener('click', async () => {
    if (state.recording) await stopRecording(false);
  });
  els.remux.addEventListener('click', remuxToMp4);

  els.pickOutfile.addEventListener('click', async () => {
    try {
      const p = await window.ffgui.recordPickOutput();
      if (p) {
        state.outFile = p;
        els.inputOutfile.value = p;
      }
    } catch (err) {
      els.status.textContent = t('record.errPickOutput', { err: errText(err) });
    }
  });

  // 勾选麦克风时申请授权并枚举设备（labels 需授权后才可见）
  els.chkMic.addEventListener('change', async () => {
    if (els.chkMic.checked) {
      try {
        await acquireMic();
        await fillMicDevices();
        els.itemMicDevice.classList.remove('hidden');
      } catch (err) {
        els.chkMic.checked = false;
        els.status.textContent = t('record.errMicDenied', { err: errText(err) });
      }
    } else {
      stopMicStream();
      els.itemMicDevice.classList.add('hidden');
    }
    updateUI();
  });

  // 勾选系统声音时若已选过来源但流里没有音轨，按原来源自动重新采集（复用 sourceId）
  els.chkSysAudio.addEventListener('change', () => {
    if (els.chkSysAudio.checked && state.captureStream
        && state.captureStream.getAudioTracks().length === 0) {
      reacquireSource();
    }
  });

  // ---------- 语言切换：重刷本页生成的动态文案 ----------
  // 静态标注由 i18n.js 的 applyStatic 处理；来源名（applyStatic 会写回占位文案）与
  // 开始/停止按钮标签需要按当前状态重刷。麦克风设备列表要异步枚举，不在此重刷。
  window.i18n.onChange(() => {
    updateUI();
    renderSourceName();
  });

  renderSourceName();
  updateUI();
})();
