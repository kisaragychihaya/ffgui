// 图片格式互转页逻辑
// 队列支持多选、拖拽添加与单项移除；转换事件由主进程逐文件广播
(function () {
  const t = window.i18n.t;

  // 与主进程图片选择对话框保持一致的图片扩展名
  const IMAGE_EXTS = new Set(['webp', 'jpg', 'jpeg', 'png', 'ico', 'bmp', 'gif', 'tif', 'tiff', 'tga']);
  // 仅这两个有损格式支持质量档
  const QUALITY_FORMATS = new Set(['jpg', 'webp']);

  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    filePanel: $('file-panel'),
    addFiles: $('btn-add-files'),
    clearFiles: $('btn-clear-files'),
    fileList: $('file-list'),
    format: $('sel-format'),
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
    files: [],        // 源图片路径列表
    outputDir: null,  // null 表示与源图片相同
    running: false,
    // 最近一次动态状态文案的键与插值参数，语言切换时按新词典重刷
    statusKey: null,
    statusVars: null,
    statusRow: null,   // 当前处理中的文件序号与文件名，语言切换时保留
    doneCount: 0,      // 任务内已完成的文件数，用于推进整体进度条
  };

  // ---------- 工具 ----------
  function baseName(p) {
    return (p || '').split(/[\\/]/).pop();
  }

  function setProgress(done) {
    els.progressBar.style.width = `${Math.min(100, Math.round(done / state.files.length * 100))}%`;
  }

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

  function renderFileList() {
    els.fileList.innerHTML = '';
    if (state.files.length === 0) {
      const li = document.createElement('li');
      li.className = 'file-list-empty';
      li.textContent = t('imgconv.fileEmpty');
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
        remove.title = t('convert.btnRemoveFile');
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

  // 已生成的日志行不回溯翻译
  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  // 状态文本也走词典：记录键与参数，语言切换时可按新词典重刷
  function setStatus(key, vars) {
    state.statusKey = key;
    state.statusVars = vars || null;
    state.statusRow = null;
    els.status.textContent = t(key, state.statusVars);
  }

  // 队列行号与文件名不含译文，语言切换时只需原样恢复这一行状态
  function setFileStart(index, input) {
    state.statusKey = null;
    state.statusVars = null;
    state.statusRow = { index, input };
    setFileStatus(index, t('convert.statusConverting'), 'running');
    els.status.textContent = `(${index + 1}/${state.files.length}) ${baseName(input)}`;
  }

  function renderStatus() {
    if (state.statusKey) {
      els.status.textContent = t(state.statusKey, state.statusVars);
    } else if (state.statusRow) {
      els.status.textContent = `(${state.statusRow.index + 1}/${state.files.length}) ${baseName(state.statusRow.input)}`;
    }
  }

  function onFormatChange() {
    els.quality.disabled = !QUALITY_FORMATS.has(els.format.value);
  }

  // ---------- 转换流程 ----------
  function setRunning(running) {
    state.running = running;
    els.start.classList.toggle('hidden', running);
    els.cancel.classList.toggle('hidden', !running);
    els.addFiles.disabled = running;
    els.clearFiles.disabled = running;
    els.format.disabled = running;
    els.quality.disabled = running || !QUALITY_FORMATS.has(els.format.value);
    els.pickDir.disabled = running;
    renderFileList();
  }

  async function startConvert() {
    if (state.running || state.files.length === 0) return;
    const job = {
      inputs: state.files.slice(),
      format: els.format.value,
      quality: els.quality.value,
      outputDir: state.outputDir,
    };

    setRunning(true);
    state.doneCount = 0;
    state.statusKey = null;
    state.statusVars = null;
    state.statusRow = null;
    els.progressBar.style.width = '0%';
    els.log.classList.add('hidden');
    els.log.textContent = '';

    const off = window.ffgui.onImgConvertEvent((evt) => {
      if (evt.type === 'file-start') {
        setFileStart(evt.index, evt.input);
      } else if (evt.type === 'progress') {
        // 图片任务没有时长，百分比恒为 0；按已完成文件数推进整体进度
        setProgress(state.doneCount);
      } else if (evt.type === 'file-done') {
        state.doneCount++;
        setProgress(state.doneCount);
        setFileStatus(evt.index, t('convert.statusDone'), 'done');
        log(`✔ ${baseName(evt.input)} → ${evt.output}`);
      } else if (evt.type === 'file-error') {
        setFileStatus(evt.index, t('convert.statusFailed'), 'error');
        log(`✘ ${baseName(evt.input)}：${evt.error}`);
      }
    });

    try {
      const result = await window.ffgui.imgConvert(job);
      setProgress(result.done);
      setStatus(result.cancelled ? 'convert.statusCancelled' : 'convert.statusAllDone',
        { done: result.done, total: result.total });
    } catch (err) {
      log(t('convert.logConvertFailed', { error: String(err && err.message || err) }));
      setStatus('convert.statusConvertFailed');
    } finally {
      off();
      setRunning(false);
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => { window.location.href = 'index.html'; });

  els.addFiles.addEventListener('click', async () => {
    if (state.running) return;
    addFiles(await window.ffgui.pickImageFiles());
  });
  els.clearFiles.addEventListener('click', () => {
    if (state.running) return;
    state.files = [];
    renderFileList();
  });
  els.pickDir.addEventListener('click', async () => {
    if (state.running) return;
    const dir = await window.ffgui.pickDirectory();
    if (dir) {
      state.outputDir = dir;
      els.outdir.value = dir;
    }
  });
  els.format.addEventListener('change', onFormatChange);
  els.start.addEventListener('click', startConvert);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cancelImgConvert();
    setStatus('convert.statusCancelling');
  });

  // ---------- 拖拽添加图片 ----------
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
      if (!IMAGE_EXTS.has(ext)) {
        skipped++;
        continue;
      }
      const p = window.ffgui.getPathForFile(file);
      if (p) paths.push(p);
    }
    const added = addFiles(paths);
    if (skipped > 0) {
      log(t('convert.logSkipped', { count: skipped }));
    }
    if (added > 0) {
      setStatus('convert.statusAdded', { count: added });
    }
  });

  // 语言切换：静态文案由 data-i18n 自动刷新；空态、状态文本和移除按钮标题需重刷
  window.i18n.onChange(() => {
    // 运行中不重建文件列表：会丢掉各图片的实时状态（进度/完成/失败）
    if (!state.running) {
      renderFileList();
    } else {
      els.fileList.querySelectorAll('li[data-index]').forEach((li) => {
        const status = li.querySelector('[data-role="status"]');
        const index = Number(li.dataset.index);
        if (status.classList.contains('running')) {
        setFileStatus(index, t('convert.statusConverting'), 'running');
      } else if (status.classList.contains('done') || status.classList.contains('error')) {
          setFileStatus(index,
            status.classList.contains('done') ? t('convert.statusDone') : t('convert.statusFailed'),
            status.classList.contains('done') ? 'done' : 'error');
        }
      });
      els.fileList.querySelectorAll('.file-remove').forEach((btn) => {
        btn.title = t('convert.btnRemoveFile');
      });
    }
    renderStatus();
  });

  onFormatChange();
  renderFileList();
})();
