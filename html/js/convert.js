// 音视频转码页逻辑
// 可选项（格式 / 编码器 / 硬件加速）全部基于主进程探测到的 ffmpeg 真实能力动态生成
(function () {
  const t = window.i18n.t;

  // ---------- 候选清单（value 与 ffmpeg 参数对应，muxer 用于校验封装格式支持） ----------
  // 需要翻译的标签用 labelKey 走词典；纯技术名保留 label 字面量
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
    { value: 'gif', labelKey: 'convert.formatGif', muxer: 'gif' },
    { value: 'mp3', labelKey: 'convert.formatMp3', muxer: 'mp3' },
    { value: 'm4a', labelKey: 'convert.formatM4a', muxer: 'ipod' },
    { value: 'flac', labelKey: 'convert.formatFlac', muxer: 'flac' },
    { value: 'wav', labelKey: 'convert.formatWav', muxer: 'wav' },
    { value: 'ogg', labelKey: 'convert.formatOgg', muxer: 'ogg' },
    { value: 'opus', labelKey: 'convert.formatOpus', muxer: 'opus' },
  ];
  const AUDIO_ONLY = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus']);
  // 无音频轨的格式（隐藏音频编码选项，主进程会加 -an）
  const VIDEO_ONLY = new Set(['gif']);

  const VCODECS = [
    { value: 'auto', labelKey: 'convert.vcodecAuto' },
    { value: 'copy', labelKey: 'convert.vcodecCopy' },
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
    { value: 'libsvtav1', labelKey: 'convert.vcodecSvtAv1' },
    { value: 'libxvid', label: 'MPEG-4 (Xvid)' },
    { value: 'wmv2', label: 'WMV2 (Windows Media Video 8)' },
    { value: 'mpeg2video', labelKey: 'convert.vcodecMpeg2' },
    { value: 'prores_ks', labelKey: 'convert.vcodecProres' },
    { value: 'prores_videotoolbox', label: 'ProRes (VideoToolbox)' },
    { value: 'mpeg4', label: 'MPEG-4' },
    { value: 'none', labelKey: 'convert.vcodecNone' },
  ];

  const ACODECS = [
    { value: 'auto', labelKey: 'convert.acodecAuto' },
    { value: 'copy', labelKey: 'convert.acodecCopy' },
    { value: 'aac', label: 'AAC' },
    { value: 'aac_at', labelKey: 'convert.acodecAacAt' },
    { value: 'libmp3lame', label: 'MP3 (LAME)' },
    { value: 'libopus', label: 'Opus' },
    { value: 'libvorbis', label: 'Vorbis' },
    { value: 'flac', label: 'FLAC' },
    { value: 'alac', labelKey: 'convert.acodecAlac' },
    { value: 'ac3', label: 'AC-3' },
    { value: 'eac3', label: 'E-AC-3' },
    { value: 'wmav2', label: 'WMA v2' },
    { value: 'pcm_s16le', labelKey: 'convert.acodecPcm' },
    { value: 'none', labelKey: 'convert.acodecNone' },
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
    devicePreset: $('sel-device-preset'),
    presetTip: $('preset-tip'),
    sampleOnly: $('chk-sample-only'),
    pixFmt: $('sel-pix-fmt'),
    h264Profile: $('sel-h264-profile'),
    h264Level: $('sel-h264-level'),
    fps: $('sel-fps'),
    channels: $('sel-channels'),
    sampleRate: $('sel-sample-rate'),
    id3Version: $('sel-id3-version'),
    preserveMetadata: $('chk-preserve-metadata'),
    preserveCover: $('chk-preserve-cover'),
    format: $('sel-format'),
    vcodec: $('sel-vcodec'),
    acodec: $('sel-acodec'),
    audioTrack: $('input-audio-track'),
    audioTrackLabel: $('audio-track-label'),
    fpsLabel: $('fps-label'),
    itemAudioTrack: $('item-audio-track'),
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
    const raw = (text || '').trim().toLowerCase();
    if (!raw || raw === '100' || raw === '100%') return null;
    let m = raw.match(/^(\d+)\s*[x×*]\s*(\d+)$/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
    m = raw.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (m) return { percent: Number(m[1]) };
    return 'invalid';
  }

  // 帧率解析：返回规范化的数字字符串；null=保持源帧率（默认）；'invalid'=无法识别
  function parseFps(text) {
    const raw = (text || '').trim();
    if (!raw) return null;
    if (!/^\d+(\.\d+)?$/.test(raw)) return 'invalid';
    const fps = Number(raw);
    if (!isFinite(fps) || fps <= 0 || fps > 240) return 'invalid';
    return raw;
  }

  function fillSelect(select, items) {
    select.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.labelKey ? t(item.labelKey) : item.label;
      select.appendChild(opt);
    }
  }

  // 重建下拉后恢复原选择（语言切换会重填选项）
  function restoreSelect(select, value) {
    if (value && Array.from(select.options).some((opt) => opt.value === value)) select.value = value;
  }

  function baseName(p) {
    return (p || '').split(/[\\/]/).pop();
  }

  function renderFileList() {
    els.fileList.innerHTML = '';
    if (state.files.length === 0) {
      const li = document.createElement('li');
      li.className = 'file-list-empty';
      li.textContent = t('convert.fileEmpty');
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

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ---------- 能力加载与选项生成 ----------
  let capsMeta = null; // 探测结果（语言切换时重建下拉与提示用）
  let capsError = null; // 探测失败信息（语言切换时重刷提示）

  function renderCapsError() {
    // 保留 <p> 结构，译文只走 textContent
    const p = document.createElement('p');
    p.textContent = t('convert.capsFailed', { error: capsError });
    els.capsLoading.replaceChildren(p);
  }

  // 按探测结果重建格式 / 编码器 / 硬件加速下拉，并保留当前选择
  function renderCapabilityOptions() {
    if (!capsMeta) return;
    const { caps, muxerNames, videoEnc, audioEnc, brokenEnc } = capsMeta;
    const keep = {
      format: els.format.value,
      vcodec: els.vcodec.value,
      acodec: els.acodec.value,
      hwaccel: els.hwaccel.value,
    };
    // 只展示 ffmpeg 实际支持的选项（auto/copy/none 不依赖编码器，始终可用）
    const builtin = new Set(['auto', 'copy', 'none']);
    fillSelect(els.format, FORMATS.filter((f) => muxerNames.has(f.muxer)));
    fillSelect(els.vcodec, VCODECS.filter((c) =>
      builtin.has(c.value) || (videoEnc.has(c.value) && !brokenEnc.has(c.value))));
    fillSelect(els.acodec, ACODECS.filter((c) => builtin.has(c.value) || audioEnc.has(c.value)));

    const hwItems = [{ value: '', labelKey: 'convert.hwaccelNone' },
      { value: 'auto', labelKey: 'convert.hwaccelAuto' }];
    for (const name of caps.hwaccels) {
      if (name !== 'auto') hwItems.push({ value: name, label: name });
    }
    fillSelect(els.hwaccel, hwItems);

    restoreSelect(els.format, keep.format);
    restoreSelect(els.vcodec, keep.vcodec);
    restoreSelect(els.acodec, keep.acodec);
    restoreSelect(els.hwaccel, keep.hwaccel);

    els.capsInfo.textContent = t('convert.capsInfo', {
      version: caps.version,
      hw: caps.hwaccels.length,
      venc: caps.encoders.video.length,
      aenc: caps.encoders.audio.length,
    }) + (brokenEnc.size > 0 ? t('convert.capsInfoBroken', { broken: brokenEnc.size }) : '');
  }

  async function initCapabilities() {
    let caps;
    try {
      caps = await window.ffgui.getCapabilities();
    } catch (err) {
      capsError = String(err && err.message || err);
      renderCapsError();
      return;
    }

    capsMeta = {
      caps,
      muxerNames: new Set(caps.muxers.map((m) => m.name)),
      videoEnc: new Set(caps.encoders.video.map((e) => e.name)),
      // 试编码实测不可用的硬件编码器（驱动过旧等原因），不下拉展示
      brokenEnc: new Set(caps.encoders.video.filter((e) => e.broken).map((e) => e.name)),
      audioEnc: new Set(caps.encoders.audio.map((e) => e.name)),
    };
    const { muxerNames, videoEnc, audioEnc } = capsMeta;
    renderCapabilityOptions();
    els.hwaccel.value = 'auto'; // 硬件加速（解码）默认 auto

    els.capsLoading.classList.add('hidden');
    els.body.classList.remove('hidden');
    // 预设不能静默退回不存在的编码器。
    const legacyAvailable = muxerNames.has('mp4') && videoEnc.has('libx264') && audioEnc.has('aac');
    for (const option of els.devicePreset.options) if (option.value) option.disabled = !legacyAvailable;
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
    els.itemAudioTrack.classList.toggle('hidden', videoOnly);
    onVcodecChange();
  }

  function onVcodecChange() {
    const v = els.vcodec.value;
    const showQuality = !els.devicePreset.value && !['auto', 'copy', 'none'].includes(v) && !AUDIO_ONLY.has(els.format.value);
    els.itemQuality.classList.toggle('hidden', !showQuality);
    const video = !AUDIO_ONLY.has(els.format.value) && v !== 'none';
    for (const key of ['vbitrate', 'vrateMode', 'scale', 'pixFmt', 'h264Profile', 'h264Level', 'fps']) {
      els[key].closest('label').classList.toggle('hidden', !video);
    }
    const audio = !VIDEO_ONLY.has(els.format.value);
    for (const key of ['abitrate', 'channels', 'sampleRate']) {
      els[key].closest('label').classList.toggle('hidden', !audio);
    }
    els.id3Version.closest('label').classList.toggle('hidden', els.format.value !== 'mp3');

  }

  // 预设表（与主进程 main/ffmpeg.js 的 DEVICE_PRESETS 同名表同步维护）：
  // 选中预设时按表锁定并填写表单；tipKey 指向词典（显示在预设下方），maxFps 用于帧率标签文案。
  const PRESET_BASE = { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', fps: '', vrateMode: 'vbr', channels: '2' };
  const DEVICE_PRESETS = {
    'ipod4-540': { ...PRESET_BASE, h264Profile: 'main', h264Level: '3.1', sampleRate: '48000',
      vbitrate: '2000', abitrate: '128', scale: '960x540', maxFps: 30, tipKey: 'convert.tipIpod' },
    'ipod4-720': { ...PRESET_BASE, h264Profile: 'main', h264Level: '3.1', sampleRate: '48000',
      vbitrate: '2000', abitrate: '128', scale: '1280x720', maxFps: 30, tipKey: 'convert.tipIpod' },
    'bili-1080p': { ...PRESET_BASE, h264Profile: 'high', h264Level: '4.2', sampleRate: '48000',
      vbitrate: '6000', abitrate: '320', scale: '1920x1080', maxFps: 60, tipKey: 'convert.tipBili1080' },
    'bili-720p': { ...PRESET_BASE, h264Profile: 'high', h264Level: '3.1', sampleRate: '48000',
      vbitrate: '3000', abitrate: '192', scale: '1280x720', maxFps: 30, tipKey: 'convert.tipBili720' },
    'douyin-1080p': { ...PRESET_BASE, h264Profile: 'high', h264Level: '4.2', sampleRate: '48000',
      vbitrate: '6000', abitrate: '192', scale: '1920x1080', maxFps: 60, tipKey: 'convert.tipDouyin1080' },
    'wechat-1080p': { ...PRESET_BASE, h264Profile: 'high', h264Level: '4.0', sampleRate: '48000',
      vbitrate: '4000', abitrate: '128', scale: '1920x1080', maxFps: 30, tipKey: 'convert.tipWechat1080' },
    'youtube-1080p': { ...PRESET_BASE, h264Profile: 'high', h264Level: '4.2', sampleRate: '48000',
      vbitrate: '8000', abitrate: '384', scale: '1920x1080', maxFps: 60, tipKey: 'convert.tipYoutube1080' },
    'iphone4s': { ...PRESET_BASE, h264Profile: 'high', h264Level: '4.0', sampleRate: '48000',
      vbitrate: '4000', abitrate: '160', scale: '1920x1080', maxFps: 30, tipKey: 'convert.tipIphone4s' },
    'psp': { ...PRESET_BASE, h264Profile: 'main', h264Level: '2.2', sampleRate: '48000',
      vbitrate: '1000', abitrate: '128', scale: '480x272', maxFps: 30, tipKey: 'convert.tipPsp' },
    'android-legacy': { ...PRESET_BASE, h264Profile: 'baseline', h264Level: '2.1', sampleRate: '44100',
      vbitrate: '1000', abitrate: '128', scale: '800x480', maxFps: 30, tipKey: 'convert.tipAndroidLegacy' },
    'web-safe': { ...PRESET_BASE, h264Profile: 'baseline', h264Level: '3.0', sampleRate: '44100',
      vbitrate: '2500', abitrate: '128', scale: '1280x720', maxFps: 30, tipKey: 'convert.tipWebSafe' },
    'tv-4k': { ...PRESET_BASE, h264Profile: 'high', h264Level: '5.1', sampleRate: '48000',
      vbitrate: '20000', abitrate: '192', scale: '3840x2160', maxFps: 30, tipKey: 'convert.tipTv4k' },
  };

  // 切换回自定义时恢复原设置，避免把预设参数误用于纯音频任务。
  const presetFields = ['format', 'vcodec', 'acodec', 'hwaccel', 'pixFmt', 'h264Profile',
    'h264Level', 'fps', 'channels', 'sampleRate', 'vbitrate', 'vrateMode', 'abitrate', 'scale'];
  let customValues = null;

  // 预设提示、帧率与音轨标签：预设态与自定义态文案不同，语言切换时也要重刷
  function renderPresetLabels() {
    const preset = els.devicePreset.value;
    if (preset) {
      const conf = DEVICE_PRESETS[preset];
      els.presetTip.textContent = t(conf.tipKey);
      els.fpsLabel.textContent = t('convert.labelFpsPreset', { fps: conf.maxFps });
    } else {
      els.presetTip.textContent = t('convert.presetTipDefault');
      els.fpsLabel.textContent = t('convert.labelFps');
    }
    els.audioTrackLabel.textContent = preset ? t('convert.labelAudioTrackPreset') : t('convert.labelAudioTrack');
  }

  function onPresetChange() {
    const preset = els.devicePreset.value;
    if (preset) {
      if (!customValues) customValues = Object.fromEntries(presetFields.map((key) => [key, els[key].value]));
      const conf = DEVICE_PRESETS[preset];
      presetFields.forEach((key) => { els[key].value = conf[key]; els[key].disabled = true; });
    } else {
      presetFields.forEach((key) => {
        if (customValues) els[key].value = customValues[key];
        els[key].disabled = false;
      });
      customValues = null;
    }
    els.presetTip.classList.toggle('hidden', !preset);
    renderPresetLabels();
    onFormatChange();
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
    if (state.running || state.files.length === 0) return;
    if (!els.audioTrack.checkValidity()) {
      els.audioTrack.reportValidity();
      return;
    }
    const scaleVal = AUDIO_ONLY.has(els.format.value) || els.vcodec.value === 'none' ? null : parseScale(els.scale.value);
    if (scaleVal === 'invalid') {
      els.advancedModal.classList.remove('hidden');
      els.scale.focus();
      log(t('convert.logBadScale'));
      return;
    }
    const video = !AUDIO_ONLY.has(els.format.value) && els.vcodec.value !== 'none';
    const audio = !VIDEO_ONLY.has(els.format.value) && els.acodec.value !== 'none';
    const fpsVal = video ? parseFps(els.fps.value) : null;
    if (fpsVal === 'invalid') {
      els.advancedModal.classList.remove('hidden');
      els.fps.focus();
      log(t('convert.logBadFps'));
      return;
    }
    const job = {
      devicePreset: els.devicePreset.value,
      sampleOnly: els.sampleOnly.checked,
      pixFmt: video ? els.pixFmt.value : '',
      h264Profile: video ? els.h264Profile.value : '',
      h264Level: video ? els.h264Level.value : '',
      fps: video ? (fpsVal || '') : '',
      channels: audio ? els.channels.value : '',
      sampleRate: audio ? els.sampleRate.value : '',
      id3Version: els.id3Version.value,
      preserveMetadata: els.preserveMetadata.checked,
      preserveCover: els.preserveCover.checked,
      inputs: state.files.slice(),
      outputDir: state.outputDir,
      format: els.format.value,
      vcodec: AUDIO_ONLY.has(els.format.value) ? 'none' : els.vcodec.value,
      acodec: VIDEO_ONLY.has(els.format.value) ? 'none' : els.acodec.value,
      audioTrack: els.audioTrack.value,
      hwaccel: els.hwaccel.value,
      quality: els.quality.value,
      hdr2sdr: els.hdr2sdr.checked,
      // 高级参数：0/空 表示不传入，由 ffmpeg 使用默认值
      vbitrate: Math.floor(Number(els.vbitrate.value)) || 0,
      vrateMode: els.vrateMode.value,
      abitrate: Math.floor(Number(els.abitrate.value)) || 0,
      // 分辨率：已在提交前校验
      scale: scaleVal,
    };

    setRunning(true);
    els.progressBar.style.width = '0%';
    els.log.classList.add('hidden');
    els.log.textContent = '';

    const off = window.ffgui.onConvertEvent((evt) => {
      if (evt.type === 'file-start') {
        setFileStatus(evt.index, t('convert.statusConverting'), 'running');
        els.status.textContent = `(${evt.index + 1}/${state.files.length}) ${baseName(evt.input)}`;
      } else if (evt.type === 'progress') {
        els.progressBar.style.width = `${evt.percent}%`;
        // 队列中每个文件显示自己的实时百分比
        setFileStatus(evt.index, `${evt.percent}%`, 'running');
        els.status.textContent = `(${evt.index + 1}/${state.files.length}) ${baseName(evt.input || job.inputs[evt.index])}`
          + ` — ${evt.percent}%  ${formatSeconds(evt.time)}/${formatSeconds(evt.duration)}`
          + (evt.speed ? `  ${evt.speed}` : '');
      } else if (evt.type === 'file-done') {
        setFileStatus(evt.index, t('convert.statusDone'), 'done');
        log(`✔ ${baseName(evt.input)} → ${evt.output}`);
      } else if (evt.type === 'file-warning') {
        log(`⚠ ${baseName(evt.input)}：${evt.warning}`);
      } else if (evt.type === 'file-error') {
        setFileStatus(evt.index, t('convert.statusFailed'), 'error');
        log(`✘ ${baseName(evt.input)}：${evt.error}`);
      }
    });

    try {
      const result = await window.ffgui.convert(job);
      els.progressBar.style.width = result.done === result.total ? '100%' : els.progressBar.style.width;
      els.status.textContent = result.cancelled
        ? t('convert.statusCancelled', { done: result.done, total: result.total })
        : t('convert.statusAllDone', { done: result.done, total: result.total });
    } catch (err) {
      log(t('convert.logConvertFailed', { error: String(err && err.message || err) }));
      els.status.textContent = t('convert.statusConvertFailed');
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
  // 分辨率输入即时校验：无法识别的输入标红，提交时阻止执行
  els.scale.addEventListener('input', () => {
    els.scale.classList.toggle('invalid', parseScale(els.scale.value) === 'invalid');
  });
  // 帧率输入即时校验：只接受 1–240 之间的数字，留空保持源帧率
  els.fps.addEventListener('input', () => {
    els.fps.classList.toggle('invalid', parseFps(els.fps.value) === 'invalid');
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
  els.devicePreset.addEventListener('change', onPresetChange);
  els.format.addEventListener('change', onFormatChange);
  els.vcodec.addEventListener('change', onVcodecChange);
  els.start.addEventListener('click', startConvert);
  els.cancel.addEventListener('click', () => {
    window.ffgui.cancelConvert();
    els.status.textContent = t('convert.statusCancelling');
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
      log(t('convert.logSkipped', { count: skipped }));
    }
    if (added > 0) {
      els.status.textContent = t('convert.statusAdded', { count: added });
    }
  });

  // 语言切换：静态文案由 data-i18n 自动刷新；下拉选项、能力提示、预设提示与文件列表
  // 都是脚本生成的，需要按新词典重建（保留用户当前选择）
  window.i18n.onChange(() => {
    if (capsError) {
      renderCapsError();
      return;
    }
    renderCapabilityOptions();
    renderPresetLabels();
    // 运行中不重建文件列表：会丢掉各文件的实时状态（进度/完成/失败）
    if (!state.running) renderFileList();
  });

  initCapabilities();
})();
