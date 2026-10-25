// 光盘页·音乐 CD 侧逻辑（原 cd.js 整体迁移，由 disc.type.js 选择类型后展示）
// 来源：物理光驱（cdListDrives 复用光盘侧车枚举，设备名按平台归一为
// libcdio 可接受的盘符 / /dev/rdiskN / /dev/srN）。
// 流程：读取光盘（cdProbe 读 TOC，不读音频）→ 可选 MusicBrainz 查询填标签 →
// 勾选曲目并编辑曲名 / 演唱者 → 填写专辑信息 → cdStart 逐轨抓取为 FLAC。
// 安全约束：盘上不可信字符串（DiscID、曲名、专辑名）一律用 textContent 写入，
// 绝不拼接 HTML；渲染层只传设备名与轨号这类数据，FFmpeg 命令行由主进程拼装。
(function () {
  // ---------- 纯逻辑开始（node:test 按标记整段提取，此段不得引用 DOM） ----------
  const t = (key, vars) => (typeof window !== 'undefined' && window.i18n ? window.i18n.t(key, vars) : key);
  // 上面这行必须是段首（测试按段首断言），且自包含：测试在 Node 里注入 window.i18n 后
  // 本段即可直接求值，缺少注入时回退键名，不会抛 ReferenceError。

  // FLAC 压缩级别档位（主进程 COMPRESSION_LEVELS 白名单内）
  const COMPRESSION_LEVELS = [5, 8, 12];
  // cdparanoia 纠错模式（与主进程 PARANOIA_MODES 一致）
  const PARANOIA_MODES = ['disable', 'verify', 'overlap', 'neverskip', 'full'];

  function isValidCompression(level) {
    return COMPRESSION_LEVELS.includes(Number(level));
  }

  function isValidParanoia(mode) {
    return PARANOIA_MODES.includes(String(mode));
  }

  // 时长（秒）-> mm:ss；CD 单轨通常不足一小时，超一小时才显示 h:mm:ss
  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // 磁盘上取回的轨条目归一化：只保留本页需要的字段，类型不符一律拒绝
  function normalizeTrack(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const number = Number(raw.number);
    if (!Number.isSafeInteger(number) || number < 1 || number > 99) return null;
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null;
    return {
      number,
      start,
      end,
      duration: end - start,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
    };
  }

  function normalizeTracks(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normalizeTrack).filter((track) => track !== null)
      .sort((a, b) => a.number - b.number);
  }

  // MusicBrainz 候选发行归一化（只取界面需要的字段）
  function normalizeReleases(list) {
    if (!Array.isArray(list)) return [];
    return list.map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      return {
        id: typeof raw.id === 'string' ? raw.id : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        artist: typeof raw.artist === 'string' ? raw.artist : '',
        date: typeof raw.date === 'string' ? raw.date : '',
        country: typeof raw.country === 'string' ? raw.country : '',
        barcode: typeof raw.barcode === 'string' ? raw.barcode : '',
        trackCount: Number.isFinite(Number(raw.trackCount)) ? Number(raw.trackCount) : 0,
      };
    }).filter((entry) => entry !== null && entry.id !== '');
  }

  // 把 release 的逐曲信息按轨号覆盖到本地曲目状态（长度不匹配时按序号能对齐多少算多少）
  function applyReleaseTracks(tracks, mbTracks) {
    if (!Array.isArray(tracks) || !Array.isArray(mbTracks)) return tracks;
    const byPosition = new Map();
    for (const entry of mbTracks) {
      if (!entry || typeof entry !== 'object') continue;
      const position = Number(entry.position);
      if (!Number.isSafeInteger(position) || position < 1) continue;
      byPosition.set(position, {
        title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : '',
        artist: typeof entry.artist === 'string' ? entry.artist.slice(0, 300) : '',
      });
    }
    if (byPosition.size === 0) return tracks;
    return tracks.map((track) => {
      const hit = byPosition.get(track.number);
      return hit ? { ...track, title: hit.title, mbArtist: hit.artist } : track;
    });
  }

  // 提交前的整体校验：返回当前语言的错误列表，空数组表示可以开始
  function validateCdJob(job) {
    const errors = [];
    if (!job || typeof job !== 'object') return [t('cd.logic.errJobInvalid')];
    if (!job.device) errors.push(t('cd.logic.errNoDevice'));
    if (!job.outputDir) errors.push(t('cd.logic.errNoOutputDir'));
    if (!Array.isArray(job.tracks) || job.tracks.length === 0) {
      errors.push(t('cd.logic.errNoTracks'));
    }
    if (!isValidCompression(job.compression)) errors.push(t('cd.logic.errCompression'));
    if (!isValidParanoia(job.paranoiaMode)) errors.push(t('cd.logic.errParanoia'));
    for (const track of job.tracks || []) {
      if (!track || !Number.isSafeInteger(Number(track.number)) || Number(track.number) < 1) {
        errors.push(t('cd.logic.errTrackNumber'));
        continue;
      }
      if (!Number.isFinite(Number(track.start)) || !Number.isFinite(Number(track.end))
          || Number(track.end) <= Number(track.start)) {
        errors.push(t('cd.logic.errTrackRange', { track: track.number }));
      }
    }
    return errors;
  }

  // 构造提交给主进程的任务（只含数据，不含任何命令片段）
  function buildCdJob(options) {
    return {
      id: options.id || null,
      device: options.device,
      outputDir: options.outputDir,
      compression: Number(options.compression),
      paranoiaMode: options.paranoiaMode,
      metadata: options.metadata || null,
      tracks: (options.tracks || []).filter((track) => track && track.selected).map((track) => ({
        number: track.number,
        start: track.start,
        end: track.end,
        title: typeof track.title === 'string' ? track.title : '',
      })),
    };
  }

  // 由曲目状态与专辑表单构造 metadata（每轨覆盖优先于专辑默认值）
  function buildMetadata(tracks, form) {
    const perTrack = {};
    for (const track of tracks) {
      if (!track || !track.selected) continue;
      const entry = {};
      if (track.title) entry.title = track.title;
      if (track.mbArtist) entry.artist = track.mbArtist;
      if (Object.keys(entry).length > 0) perTrack[String(track.number)] = entry;
    }
    return {
      album: form.album || '',
      albumArtist: form.albumArtist || '',
      artist: form.artist || '',
      date: form.date || '',
      genre: form.genre || '',
      tracks: perTrack,
    };
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '--';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }

  // DiscID 与设备名等长串的缩短显示（完整值放在 title 属性里）
  function shortId(value, max = 28) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  // ---------- 纯逻辑结束 ----------

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    selDrive: $('cd-sel-drive'),
    refreshDrives: $('cd-btn-refresh-drives'),
    driveHint: $('cd-drive-hint'),
    probe: $('cd-btn-probe'),
    tracksPanel: $('tracks-panel'),
    cdMeta: $('cd-meta'),
    mbResult: $('mb-result'),
    lookup: $('btn-lookup'),
    trackList: $('track-list'),
    metaPanel: $('meta-panel'),
    album: $('input-album'),
    albumArtist: $('input-album-artist'),
    artist: $('input-artist'),
    date: $('input-date'),
    genre: $('input-genre'),
    compression: $('sel-compression'),
    outputPanel: $('cd-output-panel'),
    paranoia: $('sel-paranoia'),
    outdir: $('cd-input-outdir'),
    pickDir: $('cd-btn-pick-dir'),
    actionPanel: $('cd-action-panel'),
    start: $('cd-btn-start'),
    cancel: $('cd-btn-cancel'),
    status: $('cd-status-text'),
    startHint: $('cd-start-hint'),
    progressBar: $('cd-progress-bar'),
    log: $('cd-log-area'),
  };

  const state = {
    drives: [],
    drivesSupported: false,
    drivesLoaded: false,
    driveError: null,
    device: null,
    disc: null,        // cdProbe 结果
    tracks: [],        // { number, start, end, duration, title, mbArtist, selected, row }
    releases: [],      // MusicBrainz 候选
    outputDir: null,
    probing: false,
    running: false,
    jobId: null,
    loadTicket: 0,     // 探测序号：忽略过期回调
  };

  // 主进程错误码 -> 白话文案；映射不中就原样显示（错误码本身不翻译）
  const CD_ERROR_KEYS = {
    FFGUI_CD_BUSY: 'cd.errBusy',
    FFGUI_CD_OUTPUT_DIR: 'cd.errOutputDir',
    FFGUI_CD_INVALID_JOB: 'cd.errInvalidJob',
    FFGUI_CD_NO_DISC: 'cd.errNoDisc',
    FFGUI_CD_NO_TRACKS: 'cd.errNoTracks',
    FFGUI_CD_RIP_FAILED: 'cd.errRipFailed',
    FFGUI_CD_MB_HTTP: 'cd.errMbHttp',
    FFGUI_CD_MB_NETWORK: 'cd.errMbNetwork',
    FFGUI_CD_MB_TIMEOUT: 'cd.errMbTimeout',
    FFGUI_DISC_SIDECAR_NOT_FOUND: 'cd.errSidecarMissing',
  };

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += `${text}\n`;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function errText(err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (CD_ERROR_KEYS[code]) return t(CD_ERROR_KEYS[code]);
    const message = String((err && err.message) || err);
    for (const known of Object.keys(CD_ERROR_KEYS)) {
      if (message.includes(known)) return t(CD_ERROR_KEYS[known]);
    }
    return message;
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  // ---------- 光驱 ----------
  function updateDriveHint() {
    if (state.driveError) {
      els.driveHint.textContent = t('cd.driveEnumFailed', { error: state.driveError });
      return;
    }
    if (!state.drivesLoaded) {
      els.driveHint.textContent = t('cd.hintEnumerating');
      return;
    }
    if (!state.drivesSupported) {
      els.driveHint.textContent = t('cd.driveUnsupported');
      return;
    }
    if (state.drives.length === 0) {
      els.driveHint.textContent = t('cd.driveNone');
      return;
    }
    els.driveHint.textContent = t('cd.driveHintSelect');
  }

  async function refreshDrives() {
    els.refreshDrives.disabled = true;
    els.driveHint.textContent = t('cd.hintEnumerating');
    els.selDrive.disabled = true;
    els.selDrive.textContent = '';
    state.driveError = null;
    try {
      const res = await window.ffgui.cdListDrives();
      state.drives = Array.isArray(res && res.drives) ? res.drives : [];
      state.drivesSupported = !(res && res.code);
      state.drivesLoaded = true;
      updateDriveHint();
      if (!state.drivesSupported || state.drives.length === 0) return;
      els.selDrive.disabled = false;
      for (const drive of state.drives) {
        const opt = document.createElement('option');
        opt.value = String(drive.device);
        // 型号/厂商标签来自盘上不可信元数据，只写文本节点
        const label = drive.label && drive.label !== drive.device
          ? t('cd.driveOptionValue', { label: String(drive.label), device: String(drive.device) })
          : String(drive.device);
        opt.textContent = label;
        els.selDrive.appendChild(opt);
      }
    } catch (err) {
      state.drivesSupported = false;
      state.drives = [];
      state.drivesLoaded = true;
      state.driveError = errText(err);
      updateDriveHint();
    } finally {
      els.refreshDrives.disabled = false;
      updateButtons();
    }
  }

  function currentDevice() {
    return els.selDrive.value ? String(els.selDrive.value) : null;
  }

  function resetDisc() {
    state.disc = null;
    state.tracks = [];
    state.releases = [];
    els.trackList.textContent = '';
    els.cdMeta.textContent = '';
    els.mbResult.classList.add('hidden');
    els.mbResult.textContent = '';
    els.tracksPanel.classList.add('hidden');
    els.metaPanel.classList.add('hidden');
    els.outputPanel.classList.add('hidden');
    els.actionPanel.classList.add('hidden');
    els.progressBar.style.setProperty('--progress-width', '0%');
    setStatus('');
    els.startHint.textContent = '';
    updateButtons();
  }

  // ---------- 探测 ----------
  async function probeDisc() {
    if (state.probing) return;
    const device = currentDevice();
    if (!device) {
      setStatus(t('cd.statusPickDrive'));
      return;
    }
    if (state.disc && !window.confirm(t('cd.confirmDiscard'))) return;
    const ticket = ++state.loadTicket;
    state.probing = true;
    updateButtons();
    setStatus(t('cd.statusProbing'));
    log(t('cd.logProbeStart', { device }));

    try {
      const disc = await window.ffgui.cdProbe(device);
      if (ticket !== state.loadTicket) return;
      const tracks = normalizeTracks(disc && disc.tracks);
      if (tracks.length === 0) throw new Error(t('cd.errProbeNoTracks'));
      state.disc = disc;
      state.device = device;
      state.tracks = tracks.map((track) => ({ ...track, selected: true, mbArtist: '' }));
      renderDisc();
      els.tracksPanel.classList.remove('hidden');
      els.metaPanel.classList.remove('hidden');
      els.outputPanel.classList.remove('hidden');
      els.actionPanel.classList.remove('hidden');
      setStatus(t('cd.statusProbeDone', { count: tracks.length }));
      log(t('cd.logProbeDone', { count: tracks.length }));
    } catch (err) {
      if (ticket !== state.loadTicket) return;
      resetDisc();
      setStatus(t('cd.statusProbeFailed'));
      log(t('cd.logProbeFailed', { error: errText(err) }));
    } finally {
      if (ticket === state.loadTicket) {
        state.probing = false;
        updateButtons();
      }
    }
  }

  function renderDisc() {
    renderDiscMeta();
    els.trackList.textContent = '';
    state.tracks.forEach((entry, index) => {
      entry.row = createTrackRow(entry, index);
      els.trackList.appendChild(entry.row.root);
    });
    updateButtons();
  }

  function renderDiscMeta() {
    const disc = state.disc || {};
    els.cdMeta.textContent = '';
    const addTag = (text) => {
      const tag = document.createElement('span');
      tag.className = 'cd-meta-tag';
      tag.textContent = text;
      els.cdMeta.appendChild(tag);
    };
    addTag(t('cd.metaTrackCount', { count: state.tracks.length }));
    if (Number.isFinite(Number(disc.durationSecs))) {
      addTag(t('cd.metaDuration', { duration: formatDuration(Number(disc.durationSecs)) }));
    }
    if (disc.discId) {
      const tag = document.createElement('span');
      tag.className = 'cd-meta-tag';
      tag.textContent = t('cd.metaDiscId', { id: shortId(disc.discId) });
      tag.title = String(disc.discId);
      els.cdMeta.appendChild(tag);
    }
    if (state.device) addTag(t('cd.metaDevice', { device: state.device }));
  }

  function createTrackRow(entry, index) {
    const root = document.createElement('li');
    root.className = 'cd-track';

    const head = document.createElement('label');
    head.className = 'cd-track-head';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = entry.selected;

    const number = document.createElement('span');
    number.className = 'cd-track-number';
    const renderNumber = () => {
      number.textContent = String(entry.number).padStart(2, '0');
    };

    const duration = document.createElement('span');
    duration.className = 'cd-track-duration';
    const renderDuration = () => {
      duration.textContent = formatDuration(entry.duration);
    };

    const stateEl = document.createElement('span');
    stateEl.className = 'cd-track-state';
    stateEl.textContent = '';

    renderNumber();
    renderDuration();
    head.append(box, number, duration, stateEl);
    root.appendChild(head);

    const fields = document.createElement('div');
    fields.className = 'cd-track-fields';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.maxLength = 300;
    titleInput.value = entry.title || '';
    titleInput.placeholder = t('cd.phTrackTitle');
    const artistInput = document.createElement('input');
    artistInput.type = 'text';
    artistInput.maxLength = 300;
    artistInput.value = entry.mbArtist || '';
    artistInput.placeholder = t('cd.phTrackArtist');
    fields.append(titleInput, artistInput);
    root.appendChild(fields);

    titleInput.addEventListener('input', () => { entry.title = titleInput.value; });
    artistInput.addEventListener('input', () => { entry.mbArtist = artistInput.value; });
    box.addEventListener('change', () => {
      if (state.running) { box.checked = entry.selected; return; }
      entry.selected = box.checked;
      titleInput.disabled = !entry.selected;
      artistInput.disabled = !entry.selected;
      updateButtons();
    });

    return {
      root, box, stateEl,
      // 语言切换后重刷本行生成的文案（不动输入内容）
      refresh() {
        renderNumber();
        renderDuration();
        titleInput.placeholder = t('cd.phTrackTitle');
        artistInput.placeholder = t('cd.phTrackArtist');
      },
    };
  }

  function setTrackState(entry, text, cls) {
    entry.row.stateEl.textContent = text;
    entry.row.stateEl.classList.remove('running', 'done', 'error');
    if (cls) entry.row.stateEl.classList.add(cls);
  }

  // ---------- MusicBrainz ----------
  async function lookupAlbum() {
    if (!state.disc || !state.disc.toc) return;
    els.lookup.disabled = true;
    setStatus(t('cd.statusLookingUp'));
    log(t('cd.logLookupStart'));
    try {
      const res = await window.ffgui.cdLookup(state.disc.toc);
      const releases = normalizeReleases(res && res.releases);
      state.releases = releases;
      renderReleases(releases);
      if (releases.length === 0) {
        setStatus(t('cd.statusLookupNone'));
        log(t('cd.logLookupNone'));
      } else {
        setStatus(t('cd.statusLookupDone', { count: releases.length }));
        log(t('cd.logLookupDone', { count: releases.length }));
      }
    } catch (err) {
      // 联网失败不该阻塞抓轨：保留手动填写路径，只把原因写进日志
      setStatus(t('cd.statusLookupFailed'));
      log(t('cd.logLookupFailed', { error: errText(err) }));
    } finally {
      els.lookup.disabled = false;
      updateButtons();
    }
  }

  function renderReleases(releases) {
    els.mbResult.textContent = '';
    els.mbResult.classList.remove('hidden');
    const title = document.createElement('div');
    title.className = 'cd-mb-title';
    title.textContent = releases.length > 0
      ? t('cd.mbPickTitle')
      : t('cd.mbNoneTitle');
    els.mbResult.appendChild(title);
    if (releases.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'cd-mb-list';
    for (const release of releases) {
      const item = document.createElement('li');
      item.className = 'cd-mb-item';

      const head = document.createElement('div');
      head.className = 'cd-mb-item-head';
      const name = document.createElement('span');
      name.className = 'cd-mb-item-name';
      name.textContent = release.title || t('cd.mbUnknownTitle');
      const meta = document.createElement('span');
      meta.className = 'cd-mb-item-meta';
      const bits = [];
      if (release.artist) bits.push(release.artist);
      if (release.date) bits.push(release.date);
      if (release.country) bits.push(release.country);
      meta.textContent = bits.join(' · ');
      head.append(name, meta);

      const detail = document.createElement('div');
      detail.className = 'cd-mb-item-detail';
      const details = [];
      if (release.trackCount) details.push(t('cd.mbTrackCount', { count: release.trackCount }));
      if (release.barcode) details.push(t('cd.mbBarcode', { barcode: release.barcode }));
      detail.textContent = details.join('  ');

      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn';
      use.textContent = t('cd.btnUseRelease');
      use.addEventListener('click', () => { useRelease(release); });

      item.append(head, detail, use);
      list.appendChild(item);
    }
    els.mbResult.appendChild(list);
  }

  async function useRelease(release) {
    els.lookup.disabled = true;
    setStatus(t('cd.statusFetchingRelease'));
    try {
      const detail = await window.ffgui.cdReleaseTracks(release.id);
      els.album.value = detail.title || '';
      els.albumArtist.value = detail.artist || '';
      els.artist.value = detail.artist || '';
      els.date.value = detail.date || '';
      const tracks = applyReleaseTracks(state.tracks, detail.tracks);
      // applyReleaseTracks 返回新数组，但行上的输入框需要同步刷新
      tracks.forEach((track, index) => {
        const entry = state.tracks[index];
        if (!entry) return;
        entry.title = track.title;
        entry.mbArtist = track.mbArtist;
        if (entry.row && entry.row.refreshInputs) entry.row.refreshInputs();
      });
      setStatus(t('cd.statusReleaseApplied', { title: detail.title || release.id }));
      log(t('cd.logReleaseApplied', { title: detail.title || release.id }));
      updateButtons();
    } catch (err) {
      setStatus(t('cd.statusReleaseFailed'));
      log(t('cd.logReleaseFailed', { error: errText(err) }));
    } finally {
      els.lookup.disabled = false;
      updateButtons();
    }
  }

  // ---------- 校验与按钮 ----------
  function selectedTracks() {
    return state.tracks.filter((track) => track.selected);
  }

  function currentForm() {
    return {
      album: els.album.value.trim(),
      albumArtist: els.albumArtist.value.trim(),
      artist: els.artist.value.trim(),
      date: els.date.value.trim(),
      genre: els.genre.value.trim(),
    };
  }

  function currentJob() {
    return buildCdJob({
      id: state.jobId,
      device: state.device,
      outputDir: state.outputDir,
      compression: els.compression.value,
      paranoiaMode: els.paranoia.value,
      metadata: buildMetadata(state.tracks, currentForm()),
      tracks: selectedTracks(),
    });
  }

  function jobErrors() {
    return validateCdJob(currentJob());
  }

  function canStart() {
    return jobErrors().length === 0;
  }

  function updateStartHint() {
    if (state.running) {
      els.startHint.textContent = t('cd.hintRunning');
      return;
    }
    const errors = jobErrors();
    if (errors.length > 0) {
      els.startHint.textContent = errors[0];
      return;
    }
    els.startHint.textContent = t('cd.hintPlan', { count: selectedTracks().length });
  }

  function updateButtons() {
    els.probe.disabled = state.probing || state.running || !currentDevice();
    els.refreshDrives.disabled = state.probing || state.running;
    els.selDrive.disabled = state.probing || state.running
      || !state.drivesSupported || state.drives.length === 0;
    els.lookup.disabled = state.running || state.probing || !state.disc;
    els.compression.disabled = state.running;
    els.paranoia.disabled = state.running;
    els.pickDir.disabled = state.running;
    for (const input of [els.album, els.albumArtist, els.artist, els.date, els.genre]) {
      input.disabled = state.running;
    }
    for (const entry of state.tracks) {
      if (!entry.row) continue;
      entry.row.box.disabled = state.running;
      const inputs = entry.row.root.querySelectorAll('.cd-track-fields input');
      for (const input of inputs) input.disabled = state.running || !entry.selected;
    }
    els.start.disabled = state.running || state.probing || !canStart();
    els.cancel.classList.toggle('hidden', !state.running);
    updateStartHint();
  }

  // ---------- 任务 ----------
  async function startJob() {
    const tr = (key, vars) => (typeof t === 'function' ? t(key, vars) : key);
    if (state.running) return;
    const errors = jobErrors();
    if (errors.length > 0) {
      updateButtons();
      return;
    }
    const job = currentJob();
    state.running = true;
    state.jobId = `cd-${Date.now()}`;
    for (const entry of state.tracks) setTrackState(entry, '', null);
    els.log.classList.add('hidden');
    els.log.textContent = '';
    els.progressBar.style.setProperty('--progress-width', '0%');
    setStatus(tr('cd.statusSubmitting'));
    log(tr('cd.logStart', { count: job.tracks.length }));
    updateButtons();

    const off = window.ffgui.onCdEvent((evt) => handleCdEvent(evt));
    try {
      const result = await window.ffgui.cdStart({ ...job, id: state.jobId });
      const width = els.progressBar.style.getPropertyValue('--progress-width');
      els.progressBar.style.setProperty('--progress-width', result.done >= result.total ? '100%' : width);
      setStatus(result.cancelled
        ? tr('cd.statusCancelled')
        : (result.done >= result.total ? tr('cd.statusDone') : tr('cd.statusFailedWithLog')));
      if (!result.cancelled && result.errors && result.errors.length > 0) {
        log(tr('cd.logTracksFailed', { count: result.errors.length }));
      }
    } catch (err) {
      log(tr('cd.logFetchFailed', { error: errText(err) }));
      setStatus(tr('cd.statusFailed'));
    } finally {
      off();
      state.running = false;
      state.jobId = null;
      updateButtons();
    }
  }

  function handleCdEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    switch (evt.type) {
      case 'start':
        setStatus(t('cd.statusBegin', { count: evt.total }));
        break;
      case 'track-start': {
        const entry = state.tracks.find((track) => track.number === evt.trackId);
        if (entry) setTrackState(entry, t('cd.stateRipping'), 'running');
        setStatus(t('cd.statusTrackPhase', {
          id: evt.trackId, index: Number(evt.index) + 1, total: evt.total,
        }));
        break;
      }
      case 'progress': {
        const entry = state.tracks.find((track) => track.number === evt.trackId);
        let percent = Number(evt.percent);
        if (!Number.isFinite(percent)) percent = 0;
        percent = Math.max(0, Math.min(100, Math.round(percent)));
        if (entry) entry.row.stateEl.textContent = `${percent}%`;
        els.progressBar.style.setProperty('--progress-width', `${percent}%`);
        setStatus(t('cd.statusProgress', { id: evt.trackId, percent }));
        break;
      }
      case 'track-done': {
        const entry = state.tracks.find((track) => track.number === evt.trackId);
        if (entry) setTrackState(entry, t('cd.stateDone'), 'done');
        if (evt.output) log(t('cd.logTrackDone', { id: evt.trackId, output: evt.output }));
        break;
      }
      case 'track-error': {
        const entry = state.tracks.find((track) => track.number === evt.trackId);
        if (entry) setTrackState(entry, t('cd.stateFailed'), 'error');
        log(t('cd.logTrackError', {
          id: evt.trackId,
          code: evt.code,
          params: evt.params ? ` ${JSON.stringify(evt.params)}` : '',
        }));
        break;
      }
      case 'log':
        if (evt.message) log(String(evt.message));
        break;
      case 'done':
        log(t('cd.logJobEnd', {
          done: evt.done,
          total: evt.total,
          cancelled: evt.cancelled ? t('cd.logJobEndCancelled') : '',
        }));
        break;
      default:
        break;
    }
  }

  // ---------- 事件绑定 ----------
  els.refreshDrives.addEventListener('click', refreshDrives);
  els.selDrive.addEventListener('change', () => {
    if (state.running || state.probing) return;
    resetDisc();
  });
  els.probe.addEventListener('click', probeDisc);
  els.lookup.addEventListener('click', lookupAlbum);
  els.compression.addEventListener('change', updateButtons);
  els.paranoia.addEventListener('change', updateButtons);
  els.pickDir.addEventListener('click', async () => {
    if (state.running) return;
    const dir = await window.ffgui.pickDirectory();
    if (dir) {
      state.outputDir = dir;
      els.outdir.value = dir;
      updateButtons();
    }
  });
  els.start.addEventListener('click', startJob);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cdCancel(state.jobId);
    setStatus(t('cd.statusCancelling'));
    log(t('cd.logCancelRequested'));
  });

  // 任务进行中阻止离开页面（beforeunload 无对话框，仅拦截卸载）
  window.addEventListener('beforeunload', (e) => {
    if (state.running) {
      e.preventDefault();
      e.returnValue = false;
      setStatus(t('cd.statusLeaveRunning'));
    }
  });

  // 语言切换后重刷本页生成的文案：光驱提示、光盘信息、曲目行、查询结果。
  // 已写入日志区的内容与当前状态行保持生成时语言（不回改）。
  if (window.i18n && typeof window.i18n.onChange === 'function') {
    window.i18n.onChange(() => {
      updateDriveHint();
      if (state.disc) renderDiscMeta();
      for (const entry of state.tracks) {
        if (entry.row && typeof entry.row.refresh === 'function') entry.row.refresh();
      }
      if (state.releases.length > 0) renderReleases(state.releases);
      updateButtons();
    });
  }

  // 类型切换控制器（disc.type.js）经此钩子查询运行状态、惰性枚举光驱；
  // 加载即刷新改由控制器在选择类型时触发，本侧不再自动枚举。
  window.__ffguiCdPage = {
    isRunning: () => !!state.running,
    refreshDrives: () => refreshDrives(),
  };
})();
