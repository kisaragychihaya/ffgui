// 字幕配音页逻辑
// 流程：选视频 + 选字幕（dubParseSubtitle 解析成台词）→ 检查引擎与模型
// （dubStatus；缺模型时经 dubDownloadModel 下载）→ 选发音语言 / 说话人 / 推理后端 /
// 输出容器 → dubStart 合成配音并混流，进度与日志经 onDubEvent 推送。混流结构由
// 「混音输出」决定：不勾选时追加一条配音轨（原音轨保留）；勾选后原声与配音按配音
// 音量（-30 ~ +12 dB，只调配音侧）合成唯一一条音轨。
// 安全约束：字幕文本、文件路径这些来路不可信的字符串一律用 textContent 写入，
// 绝不拼接 HTML；渲染层只传路径与选项这类数据，命令行与引擎调用由主进程负责。
(function () {
  // ---------- 纯逻辑开始（本段不引用 DOM，便于在 Node 里单独求值） ----------
  const t = (key, vars) => (typeof window !== 'undefined' && window.i18n ? window.i18n.t(key, vars) : key);

  // 字幕扩展名白名单（与合并页一致）
  const SUBTITLE_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa']);
  // 视频扩展名：只用于拖拽分流，真正的校验由主进程做
  const VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'ts', 'm4v', 'mpg', 'mpeg']);

  // 模型变体 / 下载源 / 推理后端 / 输出容器：与主进程白名单一一对应
  const VARIANTS = ['Q8_0', 'Q4_K_M'];
  // 下载源与 main/dub.js 的 MIRROR_MODES 一一对应（ModelScope 缺 Q4_K_M 时主进程
  // 自动回退 hf-mirror，渲染层不必区分）
  const MIRRORS = ['official', 'hfmirror', 'modelscope'];
  const BACKENDS = ['auto', 'vulkan', 'cpu'];
  const CONTAINERS = ['same', 'mp4', 'mkv'];
  // 混音模式的配音音量上下限（dB），与 main/dub.js 的 MIX_VOLUME_* 保持一致
  const MIX_VOLUME_MIN_DB = -30;
  const MIX_VOLUME_MAX_DB = 12;

  // 说话人：customvoice 模型的固定音色，与 main/dub.js 的 DEFAULT_SPEAKERS 一一对应。
  // 显示名就是值（上游说话人本就是英文名，不翻译）；正常由 status().speakers 下发，
  // 接口不可用时用这份兜底。主进程对白名单外的值一律回默认，这里不会让任务失败。
  const SPEAKERS = [
    'Vivian', 'Alex', 'Ann', 'Davis', 'Jackson',
    'Jeff', 'Rachel', 'Ethan', 'Quinn', 'Charlotte',
  ];
  const DEFAULT_SPEAKER = 'Vivian';

  // 引擎支持的语言：正常由 dubLanguages() 下发（id 为小写，含 auto），接口不可用时
  // 用这份兜底。语言名取 dub.lang.<id>，词典缺词时 t() 回退键名，不阻塞使用。
  const DEFAULT_LANGUAGES = [
    'auto', 'chinese', 'english', 'german', 'italian', 'portuguese',
    'spanish', 'japanese', 'korean', 'french', 'russian',
  ];
  const LANG_DICT_KEYS = {
    auto: 'dub.lang.auto',
    chinese: 'dub.lang.chinese',
    english: 'dub.lang.english',
    german: 'dub.lang.german',
    italian: 'dub.lang.italian',
    portuguese: 'dub.lang.portuguese',
    spanish: 'dub.lang.spanish',
    japanese: 'dub.lang.japanese',
    korean: 'dub.lang.korean',
    french: 'dub.lang.french',
    russian: 'dub.lang.russian',
  };

  // 字幕预览条数
  const PREVIEW_CUES = 5;

  function extOf(filePath) {
    const name = String(filePath || '');
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
  }

  function baseName(filePath) {
    const text = String(filePath || '');
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || text;
  }

  function isSubtitlePath(filePath) {
    return SUBTITLE_EXTS.has(extOf(filePath));
  }

  function isVideoPath(filePath) {
    return VIDEO_EXTS.has(extOf(filePath));
  }

  // 毫秒 -> mm:ss（超过一小时才显示 h:mm:ss），与字幕时间戳的阅读习惯一致
  function formatMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '--:--';
    const total = Math.floor(value / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '--';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = value / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }

  function percentOf(received, total) {
    const got = Number(received);
    const all = Number(total);
    if (!Number.isFinite(got) || !Number.isFinite(all) || all <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((got / all) * 100)));
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  // 配音音量（dB）：空输入/非法值回 0，越界钳到 [-30, +12]（与主进程
  // normalizeMixVolumeDb 同一套规则，界面先把值钳好，提交的结构永远在范围内）
  function clampMixVolumeDb(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(MIX_VOLUME_MAX_DB, Math.max(MIX_VOLUME_MIN_DB, num));
  }

  // 音量是否落在合法区间（只有数值才算合法，字符串 "3" 不行）
  function inMixVolumeRange(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    return value >= MIX_VOLUME_MIN_DB && value <= MIX_VOLUME_MAX_DB;
  }

  // 主进程返回的台词归一化：字段类型不符一律丢弃，按起始时间排序
  function normalizeCues(list) {
    if (!Array.isArray(list)) return [];
    const cues = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const start = Number(raw.startMs);
      const end = Number(raw.endMs);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (!text) continue;
      cues.push({
        index: Number.isSafeInteger(Number(raw.index)) ? Number(raw.index) : cues.length,
        startMs: start,
        endMs: end,
        text: text.slice(0, 500),
      });
    }
    cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return cues;
  }

  // 提交前的整体校验：返回当前语言的错误列表，空数组表示可以开始。
  // speakers 可选：页面把 status().speakers 传进来，避免主进程白名单变了之后
  // 渲染层的兜底常量过期导致「选得到的值被判非法」
  function validateDubJob(job, speakers) {
    if (!job || typeof job !== 'object') return [t('dub.logic.errJob')];
    const errors = [];
    const allowedSpeakers = Array.isArray(speakers) && speakers.length > 0 ? speakers : SPEAKERS;
    if (typeof job.video !== 'string' || job.video === '') errors.push(t('dub.logic.errVideo'));
    if (typeof job.subtitle !== 'string' || job.subtitle === '') errors.push(t('dub.logic.errSubtitle'));
    if (typeof job.language !== 'string' || job.language === '') errors.push(t('dub.logic.errLanguage'));
    if (!BACKENDS.includes(job.backend)) errors.push(t('dub.logic.errBackend'));
    if (!CONTAINERS.includes(job.container)) errors.push(t('dub.logic.errContainer'));
    if (!VARIANTS.includes(job.variant)) errors.push(t('dub.logic.errVariant'));
    if (!allowedSpeakers.includes(job.speaker)) errors.push(t('dub.logic.errSpeaker'));
    // 混音选项：mix 必须是布尔（读复选框得到，非布尔说明调用方传错类型），
    // 只有勾选混音时音量才有意义、才校验区间（主进程另有归一，这里拦在提交前）
    if (typeof job.mix !== 'boolean') {
      errors.push(t('dub.logic.errMix'));
    } else if (job.mix && !inMixVolumeRange(job.mixVolumeDb)) {
      errors.push(t('dub.logic.errMixVolume', {
        min: MIX_VOLUME_MIN_DB,
        max: MIX_VOLUME_MAX_DB,
      }));
    }
    return errors;
  }

  // 构造提交给主进程的任务（只含数据，不含任何命令片段）
  function buildDubJob(options) {
    return {
      id: options.id || null,
      video: options.video,
      subtitle: options.subtitle,
      language: options.language,
      speaker: options.speaker,
      backend: options.backend,
      container: options.container,
      variant: options.variant,
      mix: options.mix === true,
      mixVolumeDb: clampMixVolumeDb(options.mixVolumeDb),
    };
  }

  // 语言名：优先用主进程下发的 dictKey，其次按 id 查兜底表，最后拼 dub.lang.<id>
  function langLabel(entry) {
    const id = entry && typeof entry === 'object' ? String(entry.id || '') : String(entry || '');
    if (id === '') return '';
    const dictKey = (entry && typeof entry === 'object' && typeof entry.dictKey === 'string' && entry.dictKey)
      ? entry.dictKey
      : (LANG_DICT_KEYS[id] || `dub.lang.${id}`);
    return t(dictKey);
  }
  // ---------- 纯逻辑结束 ----------

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    sourcePanel: $('source-panel'),
    sourceDrop: $('source-drop'),
    pickVideo: $('btn-pick-video'),
    pickSubtitle: $('btn-pick-subtitle'),
    videoPath: $('video-path'),
    subtitlePath: $('subtitle-path'),
    sourceMeta: $('source-meta'),
    cueBox: $('cue-box'),
    cueTitle: $('cue-title'),
    cueList: $('cue-list'),
    engineStatus: $('engine-status'),
    engineWarning: $('engine-warning'),
    modelBox: $('model-box'),
    variant: $('sel-variant'),
    mirror: $('sel-mirror'),
    download: $('btn-download'),
    cancelDownload: $('btn-cancel-download'),
    downloadStatus: $('download-status'),
    downloadTrack: $('download-track'),
    downloadBar: $('download-bar'),
    language: $('sel-language'),
    speaker: $('sel-speaker'),
    backend: $('sel-backend'),
    container: $('sel-container'),
    mix: $('chk-mix'),
    mixVolume: $('num-mix-volume'),
    optionsHint: $('options-hint'),
    mixHint: $('mix-hint'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    status: $('status-text'),
    startHint: $('start-hint'),
    progressBar: $('progress-bar'),
    outputLine: $('output-line'),
    log: $('log-area'),
  };

  const state = {
    video: null,
    subtitle: null,
    cues: [],
    subtitleDurationMs: 0,
    status: null,          // dubStatus() 结果
    statusLoaded: false,
    statusError: null,
    languages: [],         // [{ id, dictKey }]
    downloading: null,     // { file, receivedBytes, totalBytes }
    downloadMsg: null,     // { key, vars }
    running: false,
    busy: false,           // 解析字幕等短操作
    jobId: null,
    lastJobId: null,       // 最近一次提交的 jobId：任务收尾后仍要收下迟到的 done 事件
    errorLogged: false,    // 本次任务是否已记过错误日志（避免事件与返回值重复记）
    phase: null,           // 'synthesize' | 'assemble' | 'mux'
    percent: 0,
    output: null,
    statusKey: null,       // 当前状态行（供语言切换重刷）
    statusVars: null,
  };

  // 主进程错误码 -> 白话文案（与 main/dub.js 的 dubError code 一一对应）；
  // 没列出的 code 直接显示主进程已翻译的 message，映射不中就原样显示
  const DUB_ERROR_KEYS = {
    FFGUI_DUB_BUSY: 'dub.errBusy',
    FFGUI_DUB_NO_ENGINE: 'dub.errEngineMissing',
    FFGUI_DUB_NO_MODEL: 'dub.errNoModel',
    FFGUI_DUB_NO_CUES: 'dub.errNoCues',
    FFGUI_DUB_TOO_MANY_CUES: 'dub.errTooManyCues',
    FFGUI_DUB_SUBTITLE_FORMAT: 'dub.errSubtitleFormat',
    FFGUI_DUB_VIDEO: 'dub.errVideo',
    FFGUI_DUB_DOWNLOAD: 'dub.errDownload',
    FFGUI_DUB_INVALID_JOB: 'dub.errInvalidJob',
  };

  const PHASE_KEYS = {
    synthesize: 'dub.phaseSynthesize',
    assemble: 'dub.phaseAssemble',
    mux: 'dub.phaseMux',
  };

  function phaseLabel(phase) {
    const key = PHASE_KEYS[phase];
    return key ? t(key) : String(phase || '');
  }

  function errText(err) {
    // 自定义 code 可能随 IPC 丢失，两种形态都尝试匹配
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (DUB_ERROR_KEYS[code]) return t(DUB_ERROR_KEYS[code]);
    const message = String((err && err.message) || err);
    for (const known of Object.keys(DUB_ERROR_KEYS)) {
      if (message.includes(known)) return t(DUB_ERROR_KEYS[known]);
    }
    return message;
  }

  // 日志逐行追加：错误行单独着色，文本一律 textContent（不拼 HTML）
  function log(text, level) {
    els.log.classList.remove('hidden');
    const line = document.createElement('div');
    line.className = 'dub-log-line';
    if (level === 'error') line.classList.add('error');
    line.textContent = String(text);
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
  }

  // 状态行存「键 + 变量」，语言切换时按新词典重刷
  function setStatus(key, vars) {
    state.statusKey = key || null;
    state.statusVars = vars || null;
    renderStatus();
  }

  function renderStatus() {
    els.status.textContent = state.statusKey ? t(state.statusKey, state.statusVars) : '';
  }

  function setPercent(percent) {
    state.percent = clampPercent(percent);
    els.progressBar.style.setProperty('--progress-width', `${state.percent}%`);
  }

  function renderOutput() {
    if (!state.output) {
      els.outputLine.textContent = '';
      els.outputLine.classList.add('hidden');
      els.outputLine.removeAttribute('title');
      return;
    }
    els.outputLine.textContent = t('dub.outputPath', { output: state.output });
    els.outputLine.title = state.output;
    els.outputLine.classList.remove('hidden');
  }

  // ---------- 源文件 ----------
  function renderSource() {
    renderFiles();
    renderMeta();
  }

  function renderFiles() {
    if (state.video) {
      els.videoPath.textContent = baseName(state.video);
      els.videoPath.title = state.video;
      els.videoPath.classList.remove('empty');
    } else {
      els.videoPath.textContent = t('dub.phNoVideo');
      els.videoPath.removeAttribute('title');
      els.videoPath.classList.add('empty');
    }
    if (state.subtitle) {
      els.subtitlePath.textContent = baseName(state.subtitle);
      els.subtitlePath.title = state.subtitle;
      els.subtitlePath.classList.remove('empty');
    } else {
      els.subtitlePath.textContent = t('dub.phNoSubtitle');
      els.subtitlePath.removeAttribute('title');
      els.subtitlePath.classList.add('empty');
    }
  }

  function renderMeta() {
    els.sourceMeta.textContent = '';
    if (!state.subtitle) {
      els.cueBox.classList.add('hidden');
      els.cueList.textContent = '';
      els.cueTitle.textContent = '';
      return;
    }
    if (state.cues.length === 0) {
      els.cueBox.classList.add('hidden');
      els.cueList.textContent = '';
      els.cueTitle.textContent = '';
      return;
    }
    const addTag = (text) => {
      const tag = document.createElement('span');
      tag.className = 'dub-meta-tag';
      tag.textContent = text;
      els.sourceMeta.appendChild(tag);
    };
    addTag(t('dub.metaCueCount', { count: state.cues.length }));
    if (state.subtitleDurationMs > 0) {
      addTag(t('dub.metaSubtitleDuration', { duration: formatMs(state.subtitleDurationMs) }));
    }
    renderCuePreview();
  }

  function renderCuePreview() {
    const shown = state.cues.slice(0, PREVIEW_CUES);
    els.cueBox.classList.remove('hidden');
    els.cueList.textContent = '';
    if (shown.length === 0) {
      els.cueTitle.textContent = '';
      return;
    }
    els.cueTitle.textContent = t('dub.cuePreviewTitle', { count: shown.length });
    for (const cue of shown) {
      const item = document.createElement('li');
      item.className = 'dub-cue-item';
      const time = document.createElement('span');
      time.className = 'dub-cue-time';
      time.textContent = formatMs(cue.startMs);
      const text = document.createElement('span');
      text.className = 'dub-cue-text';
      // 字幕文本来自文件，可能含 HTML/控制字符：只写文本节点
      text.textContent = cue.text;
      item.append(time, text);
      els.cueList.appendChild(item);
    }
  }

  function setVideo(filePath) {
    state.video = filePath ? String(filePath) : null;
    renderSource();
    updateButtons();
  }

  async function setSubtitle(filePath) {
    if (!filePath) return;
    state.subtitle = String(filePath);
    state.cues = [];
    state.subtitleDurationMs = 0;
    state.busy = true;
    renderSource();
    setStatus('dub.statusParsing');
    updateButtons();
    try {
      const res = await window.ffgui.dubParseSubtitle(state.subtitle);
      state.cues = normalizeCues(res && res.cues);
      state.subtitleDurationMs = Number.isFinite(Number(res && res.durationMs))
        ? Number(res.durationMs)
        : 0;
      if (state.cues.length === 0) {
        setStatus('dub.errNoCues');
        log(t('dub.logParseEmpty', { file: baseName(state.subtitle) }), 'error');
      } else {
        setStatus('dub.statusParsed', { count: state.cues.length });
        log(t('dub.logParseDone', {
          count: state.cues.length,
          duration: formatMs(state.subtitleDurationMs),
        }));
      }
    } catch (err) {
      state.cues = [];
      state.subtitleDurationMs = 0;
      setStatus('dub.statusParseFailed');
      log(t('dub.logParseFailed', { error: errText(err) }), 'error');
    } finally {
      state.busy = false;
      renderSource();
      updateButtons();
    }
  }

  // ---------- 引擎与模型 ----------
  async function loadStatus() {
    try {
      const res = await window.ffgui.dubStatus();
      state.status = res && typeof res === 'object' ? res : {};
      state.statusError = null;
      const dl = state.status.downloading;
      if (dl && typeof dl === 'object') {
        state.downloading = {
          file: String(dl.file || ''),
          receivedBytes: Number(dl.receivedBytes) || 0,
          totalBytes: Number(dl.totalBytes) || 0,
        };
      }
    } catch (err) {
      state.status = null;
      state.statusError = errText(err);
    } finally {
      state.statusLoaded = true;
      renderEngine();
      // 说话人列表随状态下发，状态到了（或变了）再重绘一次下拉
      renderSpeakers();
      updateButtons();
    }
  }

  function renderEngine() {
    els.engineStatus.textContent = '';
    els.engineWarning.textContent = '';
    if (!state.statusLoaded) {
      els.engineStatus.textContent = t('dub.engineLoading');
      els.engineWarning.classList.add('hidden');
      els.modelBox.classList.add('hidden');
      return;
    }
    if (state.statusError) {
      els.engineWarning.textContent = t('dub.errStatus', { error: state.statusError });
      els.engineWarning.classList.remove('hidden');
      els.modelBox.classList.add('hidden');
      return;
    }
    const status = state.status || {};
    const engine = status.engine && typeof status.engine === 'object' ? status.engine : {};
    const models = status.models && typeof status.models === 'object' ? status.models : {};

    if (status.state === 'missing-engine') {
      els.engineWarning.textContent = t('dub.warnMissingEngine');
      els.engineWarning.classList.remove('hidden');
      els.modelBox.classList.add('hidden');
    } else if (status.state === 'no-model') {
      els.engineWarning.classList.add('hidden');
      els.modelBox.classList.remove('hidden');
      els.engineStatus.textContent = t('dub.warnNoModel');
    } else {
      els.engineWarning.classList.add('hidden');
      els.modelBox.classList.add('hidden');
      const parts = [engine.running ? t('dub.engineRunning') : t('dub.engineInstalled')];
      if (engine.version) parts.push(t('dub.engineVersion', { version: String(engine.version) }));
      if (engine.backend) parts.push(t('dub.engineBackend', { backend: String(engine.backend) }));
      if (models.variant) parts.push(t('dub.engineModel', { variant: String(models.variant) }));
      els.engineStatus.textContent = parts.join(' · ');
    }
    renderDownload();
  }

  function renderDownload() {
    const dl = state.downloading;
    els.downloadTrack.classList.toggle('hidden', !dl);
    els.cancelDownload.classList.toggle('hidden', !dl);
    if (dl) {
      const percent = percentOf(dl.receivedBytes, dl.totalBytes);
      els.downloadBar.style.setProperty('--progress-width', `${percent}%`);
      els.downloadStatus.textContent = dl.totalBytes > 0
        ? t('dub.downloadProgress', {
          file: baseName(dl.file),
          received: formatBytes(dl.receivedBytes),
          total: formatBytes(dl.totalBytes),
          percent,
        })
        : t('dub.downloadProgressUnknown', {
          file: baseName(dl.file),
          received: formatBytes(dl.receivedBytes),
        });
      return;
    }
    els.downloadBar.style.setProperty('--progress-width', '0%');
    els.downloadStatus.textContent = state.downloadMsg
      ? t(state.downloadMsg.key, state.downloadMsg.vars)
      : '';
  }

  function setDownloadMsg(key, vars) {
    state.downloadMsg = key ? { key, vars: vars || null } : null;
    renderDownload();
  }

  async function loadLanguages() {
    let list = null;
    try {
      list = await window.ffgui.dubLanguages();
    } catch {
      list = null;
    }
    if (!Array.isArray(list) || list.length === 0) {
      const fallback = state.status && Array.isArray(state.status.languages) ? state.status.languages : [];
      list = fallback.length > 0 ? fallback : DEFAULT_LANGUAGES;
    }
    state.languages = list
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          const id = typeof entry === 'string' ? entry : '';
          return id ? { id, dictKey: LANG_DICT_KEYS[id] || '' } : null;
        }
        const id = typeof entry.id === 'string' ? entry.id : '';
        if (!id) return null;
        return { id, dictKey: typeof entry.dictKey === 'string' ? entry.dictKey : '' };
      })
      .filter((entry) => entry !== null);
    if (state.languages.length === 0) {
      state.languages = DEFAULT_LANGUAGES.map((id) => ({ id, dictKey: LANG_DICT_KEYS[id] || '' }));
    }
    renderLanguages();
    updateButtons();
  }

  function renderLanguages() {
    const current = els.language.value;
    els.language.textContent = '';
    for (const entry of state.languages) {
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = langLabel(entry);
      els.language.appendChild(opt);
    }
    if (current && state.languages.some((entry) => entry.id === current)) {
      els.language.value = current;
    }
  }

  // 说话人列表：优先用主进程 status().speakers（与 main/dub.js 同一份白名单），
  // 拿不到时用本文件的兜底常量
  function speakerList() {
    const fromStatus = state.status && Array.isArray(state.status.speakers) ? state.status.speakers : null;
    const list = (fromStatus || []).map((name) => String(name || '')).filter((name) => name !== '');
    return list.length > 0 ? list : SPEAKERS;
  }

  // 显示名即值（英文名不翻译），重绘时尽量保住用户已选的说话人
  function renderSpeakers() {
    const list = speakerList();
    const current = els.speaker.value;
    els.speaker.textContent = '';
    for (const name of list) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      els.speaker.appendChild(opt);
    }
    if (current && list.includes(current)) els.speaker.value = current;
    else els.speaker.value = list.includes(DEFAULT_SPEAKER) ? DEFAULT_SPEAKER : list[0];
  }

  // ---------- 校验与按钮 ----------
  function currentLanguage() {
    return els.language.value ? String(els.language.value) : '';
  }

  function currentSpeaker() {
    const value = String(els.speaker.value || '');
    const list = speakerList();
    return list.includes(value) ? value : (list[0] || DEFAULT_SPEAKER);
  }

  function currentVariant() {
    const value = String(els.variant.value || '');
    return VARIANTS.includes(value) ? value : VARIANTS[0];
  }

  function currentMirror() {
    const value = String(els.mirror.value || '');
    return MIRRORS.includes(value) ? value : MIRRORS[0];
  }

  function currentMix() {
    return els.mix.checked === true;
  }

  // 数字输入读出来可能是空串或乱填的内容，统一钳到 [-30, +12]
  function currentMixVolume() {
    return clampMixVolumeDb(els.mixVolume.value);
  }

  function currentJob() {
    return buildDubJob({
      id: state.jobId,
      video: state.video,
      subtitle: state.subtitle,
      language: currentLanguage(),
      speaker: currentSpeaker(),
      backend: els.backend.value,
      container: els.container.value,
      variant: currentVariant(),
      mix: currentMix(),
      mixVolumeDb: currentMixVolume(),
    });
  }

  function jobErrors() {
    const errors = validateDubJob(currentJob(), speakerList());
    if (state.subtitle && state.cues.length === 0 && !state.busy) {
      errors.unshift(t('dub.logic.errNoCues'));
    }
    return errors;
  }

  function engineReady() {
    return !!(state.statusLoaded && !state.statusError && state.status && state.status.state === 'ok');
  }

  function canStart() {
    return engineReady() && jobErrors().length === 0;
  }

  function updateStartHint() {
    if (state.running) {
      els.startHint.textContent = t('dub.hintRunning');
      return;
    }
    if (state.busy) {
      els.startHint.textContent = t('dub.statusParsing');
      return;
    }
    if (!state.statusLoaded) {
      els.startHint.textContent = t('dub.engineLoading');
      return;
    }
    if (state.statusError) {
      els.startHint.textContent = t('dub.errStatus', { error: state.statusError });
      return;
    }
    const status = state.status || {};
    if (status.state === 'missing-engine') {
      els.startHint.textContent = t('dub.hintEngineMissing');
      return;
    }
    if (status.state === 'no-model') {
      els.startHint.textContent = t('dub.hintNoModel');
      return;
    }
    const errors = jobErrors();
    if (errors.length > 0) {
      els.startHint.textContent = errors[0];
      return;
    }
    els.startHint.textContent = t('dub.hintPlan', { count: state.cues.length });
  }

  // 混音模式的两个控件联动：未勾选混音时音量输入禁用；提示行只显示当前模式对应的
  // 一段（多轨「原音轨保留」与混音「只有一条音轨」互相矛盾，不能同时出现）
  function renderMix() {
    const mix = currentMix();
    els.mixVolume.disabled = state.running || state.busy || !mix;
    els.optionsHint.classList.toggle('hidden', mix);
    els.mixHint.classList.toggle('hidden', !mix);
  }

  function updateButtons() {
    const status = state.status || {};
    const busy = state.running || state.busy;
    const downloading = !!state.downloading;
    els.pickVideo.disabled = busy;
    els.pickSubtitle.disabled = busy || downloading;
    els.variant.disabled = busy || downloading;
    els.mirror.disabled = busy || downloading;
    els.language.disabled = busy;
    // 说话人由已下载的模型决定：引擎未就绪（没装引擎 / 模型还没下载完）时没有可用的
    // 音色列表，先禁用；任务进行中也锁住，避免中途改动与实际合成不一致
    els.speaker.disabled = busy || !engineReady();
    els.backend.disabled = busy;
    els.container.disabled = busy;
    els.mix.disabled = busy;
    els.download.disabled = busy || downloading || status.state !== 'no-model';
    els.cancelDownload.disabled = busy;
    els.start.disabled = busy || downloading || !canStart();
    els.cancel.classList.toggle('hidden', !state.running);
    renderMix();
    updateStartHint();
  }

  // ---------- 任务 ----------
  async function startJob() {
    if (state.running) return;
    const errors = jobErrors();
    if (errors.length > 0) {
      updateButtons();
      return;
    }
    const job = currentJob();
    state.running = true;
    state.jobId = `dub-${Date.now()}`;
    state.lastJobId = state.jobId;
    state.errorLogged = false;
    state.output = null;
    state.phase = null;
    els.log.classList.add('hidden');
    els.log.textContent = '';
    setPercent(0);
    renderOutput();
    setStatus('dub.statusSubmitting');
    log(t('dub.logJobStart', { count: state.cues.length }));
    updateButtons();

    try {
      const result = await window.ffgui.dubStart({ ...job, id: state.jobId });
      if (result && typeof result === 'object') {
        if (result.output) {
          state.output = String(result.output);
          renderOutput();
        }
        if (result.cancelled) {
          setStatus('dub.statusCancelled');
        } else if (result.error) {
          // 主进程还会发 file-error 事件，已经记过日志就不再重复
          if (!state.errorLogged) log(t('dub.logFailed', { error: errText(result.error) }), 'error');
          setStatus('dub.statusFailed');
        } else {
          setStatus(state.output ? 'dub.statusDone' : 'dub.statusDoneNoOutput');
        }
      } else {
        // 主进程只以事件形式回报结果时，状态已由 done 事件写好
        setStatus(state.statusKey || 'dub.statusDone');
      }
    } catch (err) {
      log(t('dub.logFailed', { error: errText(err) }), 'error');
      setStatus('dub.statusFailed');
    } finally {
      state.running = false;
      state.jobId = null;
      state.phase = null;
      updateButtons();
    }
  }

  function handleDownloadEvent(evt) {
    switch (evt.type) {
      case 'download-start':
        state.downloading = {
          file: String(evt.file || ''),
          receivedBytes: Number(evt.receivedBytes) || 0,
          totalBytes: Number(evt.totalBytes) || 0,
        };
        state.downloadMsg = null;
        renderDownload();
        updateButtons();
        break;
      case 'download-progress':
        state.downloading = {
          file: String(evt.file || ''),
          receivedBytes: Number(evt.receivedBytes) || Number(state.downloading && state.downloading.receivedBytes) || 0,
          totalBytes: Number(evt.totalBytes) || Number(state.downloading && state.downloading.totalBytes) || 0,
        };
        renderDownload();
        break;
      case 'download-done':
        state.downloading = null;
        setDownloadMsg('dub.downloadDone');
        log(t('dub.logDownloadDone'));
        updateButtons();
        loadStatus();
        break;
      case 'download-error': {
        // 事件里的 error 是已翻译的文本，code 单独给出，两者都能用
        const reason = errText({ code: evt.code, message: evt.error });
        state.downloading = null;
        setDownloadMsg('dub.downloadError', { error: reason });
        log(t('dub.logDownloadFailed', { error: reason }), 'error');
        updateButtons();
        loadStatus();
        break;
      }
      default:
        break;
    }
  }

  function handleDubEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    // 下载事件不带 jobId，任务事件带（可能是别的窗口提交的任务，按 jobId 过滤）
    if (evt.type.startsWith('download-')) {
      handleDownloadEvent(evt);
      return;
    }
    // 任务收尾后仍可能收到迟到的 done 事件，故比对「当前或最近一次」的 jobId
    const expected = state.jobId || state.lastJobId;
    if (evt.jobId && expected && String(evt.jobId) !== String(expected)) return;
    switch (evt.type) {
      case 'start':
        setStatus('dub.statusBegin', { count: Number(evt.total) || state.cues.length });
        break;
      case 'phase':
        state.phase = typeof evt.phase === 'string' ? evt.phase : null;
        setStatus('dub.statusPhase', { phase: phaseLabel(state.phase) });
        break;
      case 'cue-start':
        // 主进程的 index 是 1 起的条目序号
        setStatus('dub.statusCue', {
          current: Number(evt.index) || 1,
          total: Number(evt.total) || state.cues.length,
        });
        break;
      case 'cue-done':
        log(t('dub.logCueDone', {
          current: Number(evt.index) || 1,
          total: Number(evt.total) || state.cues.length,
        }));
        break;
      case 'progress': {
        if (typeof evt.phase === 'string' && evt.phase) state.phase = evt.phase;
        setPercent(evt.percent);
        setStatus('dub.statusProgress', {
          phase: phaseLabel(state.phase),
          percent: state.percent,
        });
        break;
      }
      case 'file-done':
        if (evt.output) {
          state.output = String(evt.output);
          renderOutput();
          log(t('dub.logFileDone', { output: state.output }));
        }
        break;
      case 'file-error':
        state.errorLogged = true;
        log(t('dub.logFileError', { error: errText(evt.error) }), 'error');
        break;
      case 'log':
        if (evt.message) log(String(evt.message), evt.level === 'error' ? 'error' : null);
        break;
      case 'done':
        if (evt.output) {
          state.output = String(evt.output);
          renderOutput();
          setPercent(100);
        }
        setStatus(evt.cancelled ? 'dub.statusCancelled' : 'dub.statusDone');
        break;
      default:
        break;
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => {
    if (state.running) {
      log(t('dub.logBackRunning'));
      return;
    }
    window.location.href = 'index.html';
  });

  els.pickVideo.addEventListener('click', async () => {
    if (state.running) return;
    const filePath = await window.ffgui.dubPickVideo();
    if (filePath) setVideo(filePath);
  });
  els.pickSubtitle.addEventListener('click', async () => {
    if (state.running) return;
    const filePath = await window.ffgui.pickSubtitle();
    if (filePath) await setSubtitle(filePath);
  });

  els.download.addEventListener('click', async () => {
    if (state.running || state.downloading) return;
    els.download.disabled = true;
    setDownloadMsg('dub.downloadStarting');
    try {
      await window.ffgui.dubDownloadModel(currentVariant(), currentMirror());
    } catch (err) {
      setDownloadMsg('dub.downloadError', { error: errText(err) });
      log(t('dub.logDownloadFailed', { error: errText(err) }), 'error');
    } finally {
      updateButtons();
    }
  });
  els.cancelDownload.addEventListener('click', () => {
    els.cancelDownload.disabled = true;
    setDownloadMsg('dub.downloadCancelling');
    window.ffgui.dubCancelDownload();
  });

  els.start.addEventListener('click', startJob);
  els.cancel.addEventListener('click', () => {
    if (!state.jobId) return;
    window.ffgui.dubCancel(state.jobId);
    setStatus('dub.statusCancelling');
    log(t('dub.logCancelRequested'));
  });

  for (const el of [els.language, els.speaker, els.backend, els.container, els.variant]) {
    el.addEventListener('change', updateButtons);
  }

  // 混音开关与配音音量：开关决定音量输入是否可用；音量输入在键入时只刷新按钮与提示，
  // 失焦/回车（change）时才把钳制后的值写回输入框（填 99 会变成 12），不打断输入过程
  els.mix.addEventListener('change', updateButtons);
  els.mixVolume.addEventListener('input', updateButtons);
  els.mixVolume.addEventListener('change', () => {
    els.mixVolume.value = String(currentMixVolume());
    updateButtons();
  });

  // ---------- 拖拽添加 ----------
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  els.sourcePanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!state.running) els.sourcePanel.classList.add('drag-over');
  });
  els.sourcePanel.addEventListener('dragleave', (e) => {
    if (!els.sourcePanel.contains(e.relatedTarget)) {
      els.sourcePanel.classList.remove('drag-over');
    }
  });
  els.sourcePanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.sourcePanel.classList.remove('drag-over');
    if (state.running) return;
    let handled = false;
    for (const file of e.dataTransfer.files) {
      const filePath = window.ffgui.getPathForFile(file);
      if (!filePath) continue;
      if (isSubtitlePath(filePath)) {
        await setSubtitle(filePath);
        handled = true;
      } else if (isVideoPath(filePath)) {
        setVideo(filePath);
        handled = true;
      }
    }
    if (!handled) {
      log(t('dub.logDropUnsupported'), 'error');
    }
  });

  // 任务进行中阻止离开页面（beforeunload 无对话框，仅拦截卸载）
  window.addEventListener('beforeunload', (e) => {
    if (state.running) {
      e.preventDefault();
      e.returnValue = false;
      setStatus('dub.statusLeaveRunning');
    }
  });

  // 语言切换：重刷本页生成的所有动态文案（文件路径、引擎状态、下载进度、
  // 语言名、说话人列表、状态行、输出路径）。已写入日志区的内容保持生成时语言。
  // 说话人显示名是英文原文，重绘只为跟随 status 变化与选择状态。
  if (window.i18n && typeof window.i18n.onChange === 'function') {
    window.i18n.onChange(() => {
      renderFiles();
      renderMeta();
      renderEngine();
      renderDownload();
      renderLanguages();
      renderSpeakers();
      renderStatus();
      renderOutput();
      updateButtons();
    });
  }

  // ---------- 初始化 ----------
  if (window.ffgui && typeof window.ffgui.onDubEvent === 'function') {
    window.ffgui.onDubEvent(handleDubEvent);
  }
  renderSource();
  renderDownload();
  renderSpeakers();
  renderStatus();
  renderOutput();
  updateButtons();
  (async () => {
    await loadStatus();
    await loadLanguages();
  })();
})();
