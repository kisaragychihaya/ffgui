// 音视频合并页逻辑
// 队列支持拖入文件与拖动排序；纯音频队列只拼音频，混合队列中音频段以黑屏画面并入视频
(function () {
  // 输出格式候选
  const VIDEO_FORMATS = [
    { value: 'mp4', label: 'MP4' },
    { value: 'mkv', label: 'MKV' },
  ];
  const AUDIO_FORMATS = [
    { value: 'mp3', label: 'MP3' },
    { value: 'm4a', label: 'M4A' },
    { value: 'flac', label: 'FLAC' },
    { value: 'wav', label: 'WAV' },
    { value: 'ogg', label: 'OGG' },
  ];

  // 与主进程文件选择对话框保持一致的媒体扩展名
  const MEDIA_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v',
    'mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma']);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    filePanel: $('file-panel'),
    addFiles: $('btn-add-files'),
    clearFiles: $('btn-clear-files'),
    fileList: $('file-list'),
    format: $('sel-format'),
    outdir: $('input-outdir'),
    pickDir: $('btn-pick-dir'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    status: $('status-text'),
    progressBar: $('progress-bar'),
    log: $('log-area'),
  };

  const state = {
    files: [],        // { path, duration, hasVideo, hasAudio, width, height }
    outputDir: null,
    running: false,
    dragIndex: -1,    // 正在拖动排序的项
  };

  // ---------- 工具 ----------
  function baseName(p) {
    return p.split(/[\\/]/).pop();
  }

  function formatSeconds(s) {
    if (!s || !isFinite(s)) return '--:--';
    s = Math.floor(s);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  function anyVideo() {
    return state.files.some((f) => f.hasVideo);
  }

  // ---------- 队列渲染 ----------
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
        li.className = 'file-item merge-item';
        li.dataset.index = i;
        li.draggable = !state.running;

        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.textContent = '⠿';
        handle.title = '拖动调整顺序';

        const badge = document.createElement('span');
        badge.className = `file-badge ${file.hasVideo ? 'badge-video' : 'badge-audio'}`;
        badge.textContent = file.hasVideo ? '视频' : '音频';

        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = baseName(file.path);
        name.title = file.path;

        const dur = document.createElement('span');
        dur.className = 'file-status';
        dur.textContent = formatSeconds(file.duration);

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

        // 拖动排序
        li.addEventListener('dragstart', (e) => {
          state.dragIndex = i;
          li.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        li.addEventListener('dragend', () => {
          state.dragIndex = -1;
          li.classList.remove('dragging');
          els.fileList.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
        });
        li.addEventListener('dragover', (e) => {
          if (state.dragIndex < 0) return; // 外部文件拖入不处理
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          li.classList.add('drop-target');
        });
        li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation(); // 不触发面板的文件拖入
          li.classList.remove('drop-target');
          const from = state.dragIndex;
          if (from < 0 || from === i) return;
          // 根据落点在目标的上半/下半决定插到前还是后
          const rect = li.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          const [moved] = state.files.splice(from, 1);
          let to = i + (after ? 1 : 0);
          if (from < to) to -= 1;
          state.files.splice(to, 0, moved);
          state.dragIndex = -1;
          renderFileList();
        });

        li.append(handle, badge, name, dur, remove);
        els.fileList.appendChild(li);
      });
    }
    updateFormatOptions();
    els.start.disabled = state.running || state.files.length < 2;
  }

  // 根据队列内容切换输出格式候选
  function updateFormatOptions() {
    const video = anyVideo();
    const items = state.files.length === 0 || video ? VIDEO_FORMATS : AUDIO_FORMATS;
    const current = els.format.value;
    els.format.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      els.format.appendChild(opt);
    }
    if (items.some((it) => it.value === current)) els.format.value = current;
  }

  // ---------- 添加文件（对话框 / 拖拽） ----------
  async function addFiles(paths) {
    const fresh = paths.filter((p) => p && !state.files.some((f) => f.path === p));
    if (fresh.length === 0) return;
    const probes = await window.ffgui.probeMedia(fresh);
    let skipped = 0;
    for (const p of probes) {
      if (!p.hasVideo && !p.hasAudio) {
        skipped++;
        continue;
      }
      state.files.push({ path: p.file, duration: p.duration, hasVideo: p.hasVideo, hasAudio: p.hasAudio });
    }
    if (skipped > 0) log(`已忽略 ${skipped} 个无法识别的文件（无音视频流）`);
    renderFileList();
  }

  // ---------- 合并流程 ----------
  function setRunning(running) {
    state.running = running;
    els.start.classList.toggle('hidden', running);
    els.cancel.classList.toggle('hidden', !running);
    els.addFiles.disabled = running;
    els.clearFiles.disabled = running;
    renderFileList();
  }

  async function startMerge() {
    if (state.files.length < 2) return;
    const job = {
      inputs: state.files.map((f) => f.path),
      outputDir: state.outputDir,
      format: els.format.value,
    };

    setRunning(true);
    els.progressBar.style.width = '0%';
    els.log.classList.add('hidden');
    els.log.textContent = '';

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'file-start') {
        els.status.textContent = evt.input;
      } else if (evt.type === 'progress') {
        els.progressBar.style.width = `${evt.percent}%`;
        els.status.textContent = `${evt.percent}%  ${formatSeconds(evt.time)}/${formatSeconds(evt.duration)}`
          + (evt.speed ? `  ${evt.speed}` : '');
      } else if (evt.type === 'file-done') {
        log(`✔ 合并完成 → ${evt.output}`);
      } else if (evt.type === 'file-error') {
        log(`✘ 合并失败：${evt.error}`);
      }
    });

    try {
      const result = await window.ffgui.merge(job);
      els.progressBar.style.width = result.done === result.total ? '100%' : els.progressBar.style.width;
      els.status.textContent = result.cancelled
        ? '已取消'
        : (result.done === result.total ? '合并完成' : '合并失败，详见日志');
    } catch (err) {
      log(`合并失败：${String(err && err.message || err)}`);
      els.status.textContent = '合并失败';
    } finally {
      off();
      setRunning(false);
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => { window.location.href = 'index.html'; });
  els.addFiles.addEventListener('click', async () => {
    await addFiles(await window.ffgui.pickMediaFiles());
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
  els.start.addEventListener('click', startMerge);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cancelConvert();
    els.status.textContent = '正在取消…';
  });

  // ---------- 拖拽添加文件 ----------
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  els.filePanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (state.dragIndex >= 0) return; // 队列内部排序中
    if (!state.running) els.filePanel.classList.add('drag-over');
  });
  els.filePanel.addEventListener('dragleave', (e) => {
    if (!els.filePanel.contains(e.relatedTarget)) {
      els.filePanel.classList.remove('drag-over');
    }
  });
  els.filePanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.filePanel.classList.remove('drag-over');
    if (state.running || state.dragIndex >= 0) return;

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
    if (skipped > 0) log(`已忽略 ${skipped} 个不支持的文件`);
    await addFiles(paths);
  });

  renderFileList();
})();
