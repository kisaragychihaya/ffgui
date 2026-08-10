// 音视频转码页逻辑
// 可选项（格式 / 编码器 / 硬件加速）全部基于主进程探测到的 ffmpeg 真实能力动态生成
(function () {
  // ---------- 候选清单（value 与 ffmpeg 参数对应，muxer 用于校验封装格式支持） ----------
  const FORMATS = [
    { value: 'mp4', label: 'MP4', muxer: 'mp4' },
    { value: 'mkv', label: 'MKV', muxer: 'matroska' },
    { value: 'avi', label: 'AVI', muxer: 'avi' },
    { value: 'mov', label: 'MOV', muxer: 'mov' },
    { value: 'flv', label: 'FLV', muxer: 'flv' },
    { value: 'webm', label: 'WebM', muxer: 'webm' },
    { value: 'ts', label: 'TS', muxer: 'mpegts' },
    { value: 'wmv', label: 'WMV', muxer: 'asf' },
    { value: '3gp', label: '3GP', muxer: '3gp' },
    { value: 'gif', label: 'GIF（动图，无音频）', muxer: 'gif' },
    { value: 'mp3', label: 'MP3（纯音频）', muxer: 'mp3' },
    { value: 'm4a', label: 'M4A（纯音频）', muxer: 'ipod' },
    { value: 'flac', label: 'FLAC（纯音频）', muxer: 'flac' },
    { value: 'wav', label: 'WAV（纯音频）', muxer: 'wav' },
    { value: 'ogg', label: 'OGG（纯音频）', muxer: 'ogg' },
    { value: 'opus', label: 'OPUS（纯音频）', muxer: 'opus' },
  ];
  const AUDIO_ONLY = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus']);
  // 无音频轨的格式（隐藏音频编码选项，主进程会加 -an）
  const VIDEO_ONLY = new Set(['gif']);

  const VCODECS = [
    { value: 'auto', label: '自动（按容器默认）' },
    { value: 'copy', label: '直接复制（不重编码）' },
    { value: 'libx264', label: 'H.264 (libx264)' },
    { value: 'libx265', label: 'H.265/HEVC (libx265)' },
    { value: 'libopenh264', label: 'H.264 (OpenH264)' },
    { value: 'libkvazaar', label: 'H.265/HEVC (kvazaar)' },
    { value: 'h264_nvenc', label: 'H.264 (NVIDIA NVENC)' },
    { value: 'hevc_nvenc', label: 'H.265 (NVIDIA NVENC)' },
    { value: 'h264_qsv', label: 'H.264 (Intel QSV)' },
    { value: 'hevc_qsv', label: 'H.265 (Intel QSV)' },
    { value: 'h264_amf', label: 'H.264 (AMD AMF)' },
    { value: 'hevc_amf', label: 'H.265 (AMD AMF)' },
    { value: 'h264_mf', label: 'H.264 (MediaFoundation)' },
    { value: 'hevc_mf', label: 'H.265 (MediaFoundation)' },
    { value: 'h264_videotoolbox', label: 'H.264 (VideoToolbox)' },
    { value: 'hevc_videotoolbox', label: 'H.265 (VideoToolbox)' },
    { value: 'av1_nvenc', label: 'AV1 (NVIDIA NVENC)' },
    { value: 'av1_qsv', label: 'AV1 (Intel QSV)' },
    { value: 'av1_amf', label: 'AV1 (AMD AMF)' },
    { value: 'av1_mf', label: 'AV1 (MediaFoundation)' },
    { value: 'libvpx-vp9', label: 'VP9 (libvpx)' },
    { value: 'vp9_qsv', label: 'VP9 (Intel QSV)' },
    { value: 'libaom-av1', label: 'AV1 (libaom)' },
    { value: 'libsvtav1', label: 'AV1 (SVT-AV1，软件快速)' },
    { value: 'libxvid', label: 'MPEG-4 (Xvid)' },
    { value: 'wmv2', label: 'WMV2 (Windows Media Video 8)' },
    { value: 'mpeg2video', label: 'MPEG-2（DVD）' },
    { value: 'prores_ks', label: 'ProRes（剪辑用）' },
    { value: 'prores_videotoolbox', label: 'ProRes (VideoToolbox)' },
    { value: 'mpeg4', label: 'MPEG-4' },
    { value: 'none', label: '无视频（提取音频）' },
  ];

  const ACODECS = [
    { value: 'auto', label: '自动（按容器默认）' },
    { value: 'copy', label: '直接复制（不重编码）' },
    { value: 'aac', label: 'AAC' },
    { value: 'aac_at', label: 'AAC (AudioToolbox，Mac 硬件)' },
    { value: 'libmp3lame', label: 'MP3 (LAME)' },
    { value: 'libopus', label: 'Opus' },
    { value: 'libvorbis', label: 'Vorbis' },
    { value: 'flac', label: 'FLAC' },
    { value: 'alac', label: 'ALAC（Apple 无损）' },
    { value: 'ac3', label: 'AC-3' },
    { value: 'eac3', label: 'E-AC-3' },
    { value: 'wmav2', label: 'WMA v2' },
    { value: 'pcm_s16le', label: 'PCM（无损）' },
    { value: 'none', label: '无音频' },
  ];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    capsLoading: $('caps-loading'),
    body: $('convert-body'),
    filePanel: $('file-panel'),
    addFiles: $('btn-add-files'),
    clearFiles: $('btn-clear-files'),
    fileList: $('file-list'),
    format: $('sel-format'),
    vcodec: $('sel-vcodec'),
    acodec: $('sel-acodec'),
    itemAcodec: $('item-acodec'),
    hwaccel: $('sel-hwaccel'),
    quality: $('sel-quality'),
    itemVcodec: $('item-vcodec'),
    itemQuality: $('item-quality'),
    itemHdr2sdr: $('item-hdr2sdr'),
    hdr2sdr: $('chk-hdr2sdr'),
    outdir: $('input-outdir'),
    pickDir: $('btn-pick-dir'),
    capsInfo: $('caps-info'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    status: $('status-text'),
    progressBar: $('progress-bar'),
    log: $('log-area'),
    // 高级参数弹窗
    btnAdvanced: $('btn-advanced'),
    advancedModal: $('advanced-modal'),
    advancedClose: $('btn-advanced-close'),
    advancedOk: $('btn-advanced-ok'),
    vbitrate: $('input-vbitrate'),
    vrateMode: $('sel-vratemode'),
    abitrate: $('input-abitrate'),
    scale: $('input-scale'),
  };

  const state = {
    files: [],        // 源文件路径列表
    outputDir: null,  // null 表示与源文件相同
    running: false,
  };

  // ---------- 工具 ----------
  // 与主进程文件选择对话框保持一致的媒体扩展名
  const MEDIA_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v',
    'mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma']);

  function addFiles(paths) {
    let added = 0;
    for (const p of paths) {
      if (p && !state.files.includes(p)) {
        state.files.push(p);
        added++;
      }
    }
    if (added) renderFileList();
    return added;
  }

  // 分辨率解析：返回 {w,h} 或 {percent}；null=不缩放（默认）；'invalid'=无法识别
  function parseScale(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t || t === '100' || t === '100%') return null;
    let m = t.match(/^(\d+)\s*[x×*]\s*(\d+)$/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
    m = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (m) return { percent: Number(m[1]) };
    return 'invalid';
  }

  function fillSelect(select, items) {
    select.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
  }

  function baseName(p) {
    return p.split(/[\\/]/).pop();
  }

  function renderFileList() {
    els.fileList.innerHTML = '';
    if (state.files.length === 0) {
      const li = document.createElement('li');
      li.className = 'file-list-empty';
      li.textContent = '尚未添加文件，点击「添加文件」或将音视频文件拖拽到此处';
      els.fileList.appendChild(li);
    } else {
      state.files.forEach((file, i) => {
        const li = document.createElement('li');
        li.className = 'file-item';
        li.dataset.index = i;

        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = baseName(file);
        name.title = file;

        const status = document.createElement('span');
        status.className = 'file-status';
        status.dataset.role = 'status';

        const remove = document.createElement('button');
        remove.className = 'file-remove';
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = '移除';
        remove.addEventListener('click', () => {
          if (state.running) return;
          state.files.splice(i, 1);
          renderFileList();
        });

        li.append(name, status, remove);
        els.fileList.appendChild(li);
      });
    }
    els.start.disabled = state.running || state.files.length === 0;
  }

  function setFileStatus(index, text, cls) {
    const li = els.fileList.querySelector(`li[data-index="${index}"]`);
    if (!li) return;
    const status = li.querySelector('[data-role="status"]');
    status.textContent = text;
    status.className = `file-status ${cls || ''}`;
  }

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ---------- 能力加载与选项生成 ----------
  async function initCapabilities() {
    let caps;
    try {
      caps = await window.ffgui.getCapabilities();
    } catch (err) {
      els.capsLoading.innerHTML = `<p>ffmpeg 能力检测失败：${String(err && err.message || err)}</p>`;
      return;
    }

    const muxerNames = new Set(caps.muxers.map((m) => m.name));
    const videoEnc = new Set(caps.encoders.video.map((e) => e.name));
    // 试编码实测不可用的硬件编码器（驱动过旧等原因），不下拉展示
    const brokenEnc = new Set(caps.encoders.video.filter((e) => e.broken).map((e) => e.name));
    const audioEnc = new Set(caps.encoders.audio.map((e) => e.name));

    // 只展示 ffmpeg 实际支持的选项（auto/copy/none 不依赖编码器，始终可用）
    const builtin = new Set(['auto', 'copy', 'none']);
    fillSelect(els.format, FORMATS.filter((f) => muxerNames.has(f.muxer)));
    fillSelect(els.vcodec, VCODECS.filter((c) =>
      builtin.has(c.value) || (videoEnc.has(c.value) && !brokenEnc.has(c.value))));
    fillSelect(els.acodec, ACODECS.filter((c) => builtin.has(c.value) || audioEnc.has(c.value)));

    const hwItems = [{ value: '', label: '不使用' }, { value: 'auto', label: 'auto（自动选择）' }];
    for (const name of caps.hwaccels) {
      if (name !== 'auto') hwItems.push({ value: name, label: name });
    }
    fillSelect(els.hwaccel, hwItems);
    els.hwaccel.value = 'auto'; // 硬件加速（解码）默认 auto

    els.capsInfo.textContent = `ffmpeg ${caps.version} ｜ 检测到 ${caps.hwaccels.length} 种硬件加速、`
      + `${caps.encoders.video.length} 个视频编码器、${caps.encoders.audio.length} 个音频编码器`
      + (brokenEnc.size > 0 ? ` ｜ 已剔除 ${brokenEnc.size} 个实测不可用的硬件编码器` : '');

    els.capsLoading.classList.add('hidden');
    els.body.classList.remove('hidden');
    onFormatChange();
    renderFileList();
  }

  // ---------- 表单联动 ----------
  function onFormatChange() {
    const audioOnly = AUDIO_ONLY.has(els.format.value);
    const videoOnly = VIDEO_ONLY.has(els.format.value);
    els.itemVcodec.classList.toggle('hidden', audioOnly);
    els.itemQuality.classList.toggle('hidden', audioOnly);
    els.itemHdr2sdr.classList.toggle('hidden', audioOnly);
    els.itemAcodec.classList.toggle('hidden', videoOnly);
    onVcodecChange();
  }

  function onVcodecChange() {
    const v = els.vcodec.value;
    const showQuality = !['auto', 'copy', 'none'].includes(v) && !AUDIO_ONLY.has(els.format.value);
    els.itemQuality.classList.toggle('hidden', !showQuality);
  }

  // ---------- 转换流程 ----------
  function setRunning(running) {
    state.running = running;
    els.start.classList.toggle('hidden', running);
    els.cancel.classList.toggle('hidden', !running);
    els.addFiles.disabled = running;
    els.clearFiles.disabled = running;
    renderFileList();
  }

  function formatSeconds(s) {
    if (!s || !isFinite(s)) return '--:--';
    s = Math.floor(s);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  async function startConvert() {
    if (state.files.length === 0) return;
    const scaleVal = parseScale(els.scale.value);
    const job = {
      inputs: state.files.slice(),
      outputDir: state.outputDir,
      format: els.format.value,
      vcodec: AUDIO_ONLY.has(els.format.value) ? 'none' : els.vcodec.value,
      acodec: VIDEO_ONLY.has(els.format.value) ? 'none' : els.acodec.value,
      hwaccel: els.hwaccel.value,
      quality: els.quality.value,
      hdr2sdr: els.hdr2sdr.checked,
      // 高级参数：0/空 表示不传入，由 ffmpeg 使用默认值
      vbitrate: Math.floor(Number(els.vbitrate.value)) || 0,
      vrateMode: els.vrateMode.value,
      abitrate: Math.floor(Number(els.abitrate.value)) || 0,
      // 分辨率：非法输入按未填写处理（不传入）
      scale: scaleVal === 'invalid' ? null : scaleVal,
    };

    setRunning(true);
    els.progressBar.style.width = '0%';
    els.log.classList.add('hidden');
    els.log.textContent = '';

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'file-start') {
        setFileStatus(evt.index, '转换中…', 'running');
        els.status.textContent = `(${evt.index + 1}/${state.files.length}) ${baseName(evt.input)}`;
      } else if (evt.type === 'progress') {
        els.progressBar.style.width = `${evt.percent}%`;
        // 队列中每个文件显示自己的实时百分比
        setFileStatus(evt.index, `${evt.percent}%`, 'running');
        els.status.textContent = `(${evt.index + 1}/${state.files.length}) ${baseName(evt.input)}`
          + ` — ${evt.percent}%  ${formatSeconds(evt.time)}/${formatSeconds(evt.duration)}`
          + (evt.speed ? `  ${evt.speed}` : '');
      } else if (evt.type === 'file-done') {
        setFileStatus(evt.index, '完成', 'done');
        log(`✔ ${baseName(evt.input)} → ${evt.output}`);
      } else if (evt.type === 'file-error') {
        setFileStatus(evt.index, '失败', 'error');
        log(`✘ ${baseName(evt.input)}：${evt.error}`);
      }
    });

    try {
      const result = await window.ffgui.convert(job);
      els.progressBar.style.width = result.done === result.total ? '100%' : els.progressBar.style.width;
      els.status.textContent = result.cancelled
        ? `已取消（完成 ${result.done}/${result.total}）`
        : `全部结束：成功 ${result.done}/${result.total}`;
    } catch (err) {
      log(`转换失败：${String(err && err.message || err)}`);
      els.status.textContent = '转换失败';
    } finally {
      off();
      setRunning(false);
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => { window.location.href = 'index.html'; });

  // 高级参数弹窗：打开 / 关闭（点遮罩或按钮均可关闭）
  els.btnAdvanced.addEventListener('click', () => {
    els.advancedModal.classList.remove('hidden');
  });
  const closeAdvanced = () => els.advancedModal.classList.add('hidden');
  els.advancedClose.addEventListener('click', closeAdvanced);
  els.advancedOk.addEventListener('click', closeAdvanced);
  els.advancedModal.addEventListener('click', (e) => {
    if (e.target === els.advancedModal) closeAdvanced();
  });
  // 分辨率输入即时校验：无法识别的输入标红提示（不会传给 ffmpeg）
  els.scale.addEventListener('input', () => {
    els.scale.classList.toggle('invalid', parseScale(els.scale.value) === 'invalid');
  });

  els.addFiles.addEventListener('click', async () => {
    addFiles(await window.ffgui.pickMediaFiles());
  });
  els.clearFiles.addEventListener('click', () => {
    state.files = [];
    renderFileList();
  });
  els.pickDir.addEventListener('click', async () => {
    const dir = await window.ffgui.pickDirectory();
    if (dir) {
      state.outputDir = dir;
      els.outdir.value = dir;
    }
  });
  els.format.addEventListener('change', onFormatChange);
  els.vcodec.addEventListener('change', onVcodecChange);
  els.start.addEventListener('click', startConvert);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cancelConvert();
    els.status.textContent = '正在取消…';
  });

  // ---------- 拖拽添加文件 ----------
  // 阻止默认行为，避免文件拖到窗口其他位置时被直接打开
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  els.filePanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!state.running) els.filePanel.classList.add('drag-over');
  });
  els.filePanel.addEventListener('dragleave', (e) => {
    // 子元素间移动也会触发 dragleave，仅在真正离开面板时移除高亮
    if (!els.filePanel.contains(e.relatedTarget)) {
      els.filePanel.classList.remove('drag-over');
    }
  });
  els.filePanel.addEventListener('drop', (e) => {
    e.preventDefault();
    els.filePanel.classList.remove('drag-over');
    if (state.running) return;

    const paths = [];
    let skipped = 0;
    for (const file of e.dataTransfer.files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!MEDIA_EXTS.has(ext)) {
        skipped++;
        continue;
      }
      const p = window.ffgui.getPathForFile(file);
      if (p) paths.push(p);
    }
    const added = addFiles(paths);
    if (skipped > 0) {
      log(`已忽略 ${skipped} 个不支持的文件`);
    }
    if (added > 0) {
      els.status.textContent = `已添加 ${added} 个文件`;
    }
  });

  initCapabilities();
})();
