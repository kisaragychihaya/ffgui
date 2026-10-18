'use strict';

const fs = require('fs');
const path = require('path');
const {
  createDiscSidecar,
  DISC_SIDECAR_VERSION,
} = require('./disc-sidecar');
const { t } = require('./i18n');

const SOURCE_KINDS = new Set(['iso', 'folder', 'drive']);
const MODES = new Set(['copy', 'transcode']);
const FORMATS = new Set(['mkv', 'mp4']);
const QUALITIES = new Set(['high', 'medium', 'low']);
const AUDIO_CODECS = new Set(['copy', 'aac']);
const PARTIAL_SUFFIX = '.ffgui-partial';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function discError(code, message, params = {}) {
  const err = new Error(message);
  err.code = code;
  err.params = params;
  return err;
}

function invalid(field, message) {
  return discError('FFGUI_INVALID_JOB', message, { field });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) throw invalid(field, t('main.disc.errRequired', { field }));
  return value;
}

function normalizeSource(source) {
  if (!isPlainObject(source)) throw invalid('source', t('main.disc.errSourceObject'));
  if (!SOURCE_KINDS.has(source.kind)) throw invalid('source.kind', t('main.disc.errSourceKind'));
  return { kind: source.kind, path: requiredString(source.path, 'source.path') };
}

function normalizeTrackIds(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw invalid(field, t('main.disc.errTrackIds', { field }));
  const ids = [];
  for (const raw of value) {
    const id = requiredString(raw, field);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeFingerprint(value, titleId) {
  if (!isPlainObject(value)) {
    throw invalid('titles.titleFingerprint', t('main.disc.errFingerprintMissing', { titleId }));
  }
  const id = requiredString(value.id, 'titles.titleFingerprint.id');
  if (id !== titleId) {
    throw invalid('titles.titleFingerprint.id', t('main.disc.errFingerprintMismatch', { titleId }));
  }
  const integer = (v, field) => {
    if (!Number.isSafeInteger(v) || v < 0) throw invalid(field, t('main.disc.errFingerprintInteger'));
    return v;
  };
  const firstLba = value.firstLba === null ? null : integer(value.firstLba, 'titles.titleFingerprint.firstLba');
  const sectors = integer(value.sectors, 'titles.titleFingerprint.sectors');
  const sizeBytes = integer(value.sizeBytes, 'titles.titleFingerprint.sizeBytes');
  if (typeof value.durationSecs !== 'number' || !Number.isFinite(value.durationSecs) || value.durationSecs < 0) {
    throw invalid('titles.titleFingerprint.durationSecs', t('main.disc.errFingerprintDuration'));
  }
  return { id, firstLba, sectors, durationSecs: value.durationSecs, sizeBytes };
}

// 只构造协议允许的字段；来源 label 等界面字段不会进入侧车请求。
function validateDiscJob(job) {
  if (!isPlainObject(job)) throw invalid('job', t('main.disc.errJobObject'));
  const normalized = {
    id: requiredString(job.id, 'id'),
    source: normalizeSource(job.source),
    keydbPath: job.keydbPath === null || job.keydbPath === undefined
      ? null : requiredString(job.keydbPath, 'keydbPath'),
    outputDir: requiredString(job.outputDir, 'outputDir'),
    mode: job.mode,
    format: job.format,
    quality: job.quality,
    audioCodec: job.audioCodec,
    titles: [],
  };
  if (!MODES.has(job.mode)) throw invalid('mode', t('main.disc.errMode'));
  if (!FORMATS.has(job.format)) throw invalid('format', t('main.disc.errFormat'));
  if (!QUALITIES.has(job.quality)) throw invalid('quality', t('main.disc.errQuality'));
  if (!AUDIO_CODECS.has(job.audioCodec)) throw invalid('audioCodec', t('main.disc.errAudioCodec'));
  if (job.mode === 'copy' && (job.format !== 'mkv' || job.audioCodec !== 'copy')) {
    throw invalid('mode', t('main.disc.errCopyMode'));
  }
  if (job.mode === 'transcode' && job.format === 'mp4' && job.audioCodec !== 'aac') {
    throw invalid('audioCodec', t('main.disc.errMp4Aac'));
  }
  if (!Array.isArray(job.titles) || job.titles.length === 0) {
    throw invalid('titles', t('main.disc.errNoTitles'));
  }
  const titleIds = new Set();
  normalized.titles = job.titles.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`titles.${index}`, t('main.disc.errTitleObject'));
    const titleId = requiredString(entry.titleId, `titles.${index}.titleId`);
    if (titleIds.has(titleId)) throw invalid(`titles.${index}.titleId`, t('main.disc.errTitleDuplicate', { titleId }));
    titleIds.add(titleId);
    if (job.mode === 'transcode' && job.format === 'mp4'
      && (!Array.isArray(entry.subtitleTrackIds) || entry.subtitleTrackIds.length !== 0)) {
      throw invalid(`titles.${index}.subtitleTrackIds`, t('main.disc.errSubtitleExplicit', { titleId }));
    }
    return {
      titleId,
      titleFingerprint: normalizeFingerprint(entry.titleFingerprint, titleId),
      audioTrackIds: normalizeTrackIds(entry.audioTrackIds, `titles.${index}.audioTrackIds`),
      subtitleTrackIds: normalizeTrackIds(entry.subtitleTrackIds, `titles.${index}.subtitleTrackIds`),
    };
  });
  return normalized;
}

function resolveDiscSidecarPath(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const executableName = platform === 'win32' ? 'ffgui-disc.exe' : 'ffgui-disc';
  const notFound = (candidates) => discError('FFGUI_DISC_SIDECAR_NOT_FOUND',
    t('main.disc.errSidecarMissing', { candidates: candidates.join(t('main.disc.listSeparator')) }),
    { candidates });

  const override = env.FFGUI_DISC_SIDECAR;
  if (override) {
    if (fsImpl.existsSync(override)) return override;
    throw notFound([override]);
  }

  const app = options.app || require('electron').app;
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(options.resourcesPath || process.resourcesPath, 'disc', executableName));
  } else {
    const base = path.join(app.getAppPath(), 'native', 'ffgui-disc', 'target');
    candidates.push(path.join(base, 'release', executableName), path.join(base, 'debug', executableName));
  }
  for (const candidate of candidates) {
    if (fsImpl.existsSync(candidate)) return candidate;
  }
  throw notFound(candidates);
}

function safeFilePart(value, fallback) {
  let text = String(value || '')
    .replace(/[\x00-\x1f\x7f]+/g, '_')
    .replace(/[\\/<>:"|?*]+/g, '_')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!text) text = fallback;
  if (text.length > 120) text = text.slice(0, 120).replace(/[. ]+$/g, '');
  return text || fallback;
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

// 同时避开已有文件、本批输出，以及侧车使用的 .ffgui-partial 路径。
function uniqueOutputPath(candidate, reserved, fsImpl, avoidPartial = false) {
  const ext = path.extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  let out = candidate;
  let suffix = 2;
  const unavailable = (p) => fsImpl.existsSync(p) || reserved.has(pathKey(p))
    || (avoidPartial && (fsImpl.existsSync(p + PARTIAL_SUFFIX) || reserved.has(pathKey(p + PARTIAL_SUFFIX))));
  while (unavailable(out)) out = `${stem}_${suffix++}${ext}`;
  reserved.add(pathKey(out));
  if (avoidPartial) reserved.add(pathKey(out + PARTIAL_SUFFIX));
  return out;
}

function allocateOutputPlans(job, fsImpl) {
  let stat;
  try {
    stat = fsImpl.statSync(job.outputDir);
  } catch (err) {
    throw discError('FFGUI_OUTPUT_DIR', t('main.disc.errOutputDirUnusable', { path: job.outputDir }),
      { path: job.outputDir, cause: err.message });
  }
  if (!stat.isDirectory()) throw discError('FFGUI_OUTPUT_DIR', t('main.disc.errOutputNotDir', { path: job.outputDir }), { path: job.outputDir });

  const outputDir = path.resolve(job.outputDir);
  const reserved = new Set([pathKey(job.source.path)]);
  if (job.keydbPath) reserved.add(pathKey(job.keydbPath));
  let sourceName = path.basename(path.normalize(job.source.path));
  if (job.source.kind === 'iso') sourceName = path.basename(sourceName, path.extname(sourceName));
  sourceName = safeFilePart(sourceName, job.source.kind);
  const jobPart = safeFilePart(job.id, 'job');

  return job.titles.map((title, index) => {
    const stem = `${sourceName}_${safeFilePart(title.titleId, `title-${index + 1}`)}`;
    const finalOutput = uniqueOutputPath(
      path.join(outputDir, `${stem}.${job.format}`), reserved, fsImpl, job.mode === 'copy');
    const ripOutput = job.mode === 'copy' ? finalOutput : uniqueOutputPath(
      path.join(outputDir, `.${stem}.${jobPart}.${index + 1}.ffgui-temp.mkv`), reserved, fsImpl, true);
    return {
      index,
      title,
      finalOutput,
      ripOutput,
      ripPartial: ripOutput + PARTIAL_SUFFIX,
      finalExisted: fsImpl.existsSync(finalOutput),
      ripPartialExisted: fsImpl.existsSync(ripOutput + PARTIAL_SUFFIX),
    };
  });
}

function nullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createDiscService(options = {}) {
  const fsImpl = options.fs || fs;
  const createSidecar = options.createSidecar || createDiscSidecar;
  const runConversion = options.runConversion || ((payload) => require('./ffmpeg').runSingleFileConversion(payload));
  const cancelConversion = options.cancelConversion || (() => require('./ffmpeg').cancelCurrentTask());
  let activeJob = null;
  let requestCounter = 0;

  const executable = () => resolveDiscSidecarPath({
    fs: fsImpl,
    env: options.env,
    platform: options.platform,
    resourcesPath: options.resourcesPath,
    app: options.app,
  });

  function invokeSidecar(method, params, onEvent, id, executablePath) {
    const request = {
      version: DISC_SIDECAR_VERSION,
      id: id || `disc-${method}-${++requestCounter}`,
      method,
      params,
    };
    const sidecar = createSidecar({
      executable: executablePath || executable(),
      request,
      onEvent,
    });
    return { sidecar, run: sidecar.run(), request };
  }

  function emit(sender, event) {
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) return;
    try {
      sender.send('ffgui:disc-event', event);
    } catch {
      // 窗口关闭不应打断抓取与清理。
    }
  }

  function cleanupNewFile(sender, jobId, file, existedBefore) {
    if (!file || existedBefore) return;
    try {
      fsImpl.unlinkSync(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      emit(sender, {
        jobId,
        type: 'log',
        level: 'warning',
        code: 'FFGUI_CLEANUP_FAILED',
        params: { path: file, reason: err && err.message ? err.message : String(err) },
        message: t('main.disc.cleanupFailed', { path: file }),
      });
    }
  }

  async function probe(source) {
    const { run } = invokeSidecar('probe', { source: normalizeSource(source) });
    const result = await run;
    if (!isPlainObject(result) || !isPlainObject(result.disc)) {
      throw discError('FFGUI_BAD_RESULT', t('main.disc.errProbeShape'));
    }
    return result.disc;
  }

  async function listDrives() {
    let unsupportedCode = null;
    const { run } = invokeSidecar('list-drives', {}, (event) => {
      if (event.type === 'log' && typeof event.code === 'string' && event.code.includes('UNSUPPORTED')) {
        unsupportedCode = event.code;
      }
    });
    let result;
    try {
      result = await run;
    } catch (err) {
      if (err && typeof err.code === 'string' && err.code.includes('UNSUPPORTED')) {
        return { drives: [], code: err.code };
      }
      throw err;
    }
    if (!isPlainObject(result) || !Array.isArray(result.drives)) {
      throw discError('FFGUI_BAD_RESULT', t('main.disc.errDrivesShape'));
    }
    return unsupportedCode ? { drives: [], code: unsupportedCode } : { drives: result.drives };
  }

  function cancel(jobId) {
    const state = activeJob;
    if (!state || state.id !== jobId) return false;
    state.cancelRequested = true;
    try {
      if (state.phase === 'rip' && state.sidecar) state.sidecar.cancel();
      else if (state.phase === 'transcode') cancelConversion();
    } catch (err) {
      emit(state.sender, {
        jobId: state.id,
        type: 'log',
        level: 'warning',
        code: 'FFGUI_CANCEL_FAILED',
        params: { reason: err && err.message ? err.message : String(err) },
        message: t('main.disc.cancelFailed'),
      });
    }
    return true;
  }

  async function executeJob(state, plans, executablePath) {
    const { job, sender } = state;
    const total = plans.length;
    let done = 0;
    const errors = [];
    emit(sender, { jobId: job.id, type: 'start', total });

    for (const plan of plans) {
      if (state.cancelRequested) break;
      const { index, title, finalOutput, ripOutput } = plan;
      let completed = false;
      state.phase = 'rip';
      state.sidecar = null;
      const meta = (phase, output) => ({ jobId: job.id, index, titleId: title.titleId, phase, output });
      emit(sender, { type: 'title-start', ...meta('rip', ripOutput) });

      try {
        const params = {
          source: job.source,
          titleId: title.titleId,
          output: ripOutput,
          audioTrackIds: title.audioTrackIds,
          subtitleTrackIds: title.subtitleTrackIds,
          keydbPath: job.keydbPath,
          titleFingerprint: title.titleFingerprint,
        };
        const invocation = invokeSidecar('rip', params, (event) => {
          if (event.type === 'progress') {
            const bytesDone = nullableNumber(event.bytesDone);
            const bytesTotal = nullableNumber(event.bytesTotal);
            const percent = bytesDone !== null && bytesTotal > 0
              ? Math.min(99, Math.round((bytesDone / bytesTotal) * 100)) : 0;
            emit(sender, {
              type: 'progress',
              ...meta('rip', ripOutput),
              percent,
              bytesDone,
              bytesTotal,
              speedBps: nullableNumber(event.speedBps),
              etaSecs: nullableNumber(event.etaSecs),
              pass: typeof event.pass === 'string' ? event.pass : null,
              time: null,
              duration: null,
              speed: '',
            });
          } else if (event.type === 'log') {
            const logParams = isPlainObject(event.params) ? event.params : {};
            const message = typeof event.message === 'string' ? event.message
              : (typeof logParams.message === 'string' ? logParams.message : String(event.code || t('main.disc.logFallback')));
            emit(sender, {
              type: 'log',
              ...meta('rip', ripOutput),
              level: event.level || 'info',
              code: event.code || 'DISC_LOG',
              params: logParams,
              message,
            });
          }
        }, `${job.id}:rip:${index}`, executablePath);
        state.sidecar = invocation.sidecar;
        const ripResult = await invocation.run;
        state.sidecar = null;
        if (!isPlainObject(ripResult) || ripResult.titleId !== title.titleId
          || typeof ripResult.output !== 'string' || pathKey(ripResult.output) !== pathKey(ripOutput)) {
          throw discError('FFGUI_BAD_RESULT', t('main.disc.errRipMismatch', { titleId: title.titleId }), {
            titleId: title.titleId,
            output: ripOutput,
          });
        }

        if (job.mode === 'copy') {
          completed = true;
          done += 1;
          emit(sender, { type: 'title-done', ...meta('rip', finalOutput) });
          continue;
        }
        if (state.cancelRequested) break;

        state.phase = 'transcode';
        emit(sender, { type: 'title-start', ...meta('transcode', finalOutput) });
        let conversionError = '';
        const conversionResult = await runConversion({
          job: {
            format: job.format,
            vcodec: 'libx264',
            acodec: job.audioCodec,
            quality: job.quality,
            pixFmt: 'yuv420p',
            preserveChapters: true,
          },
          input: ripOutput,
          output: finalOutput,
          send: (event) => {
            if (event.type === 'progress') {
              emit(sender, {
                type: 'progress',
                ...meta('transcode', finalOutput),
                percent: nullableNumber(event.percent) || 0,
                bytesDone: null,
                bytesTotal: null,
                speedBps: null,
                etaSecs: null,
                pass: null,
                time: nullableNumber(event.time),
                duration: nullableNumber(event.duration),
                speed: typeof event.speed === 'string' ? event.speed : '',
              });
            } else if (event.type === 'file-warning') {
              emit(sender, {
                type: 'log',
                ...meta('transcode', finalOutput),
                level: 'warning',
                code: 'FFGUI_TRANSCODE_WARNING',
                params: { message: event.warning || '' },
                message: event.warning || t('main.disc.transcodeWarning'),
              });
            } else if (event.type === 'file-error') {
              conversionError = event.error || '';
            }
          },
        });
        if (conversionResult && conversionResult.ok) {
          completed = true;
          done += 1;
          emit(sender, { type: 'title-done', ...meta('transcode', finalOutput) });
          continue;
        }
        if (state.cancelRequested || (conversionResult && conversionResult.cancelled)) {
          state.cancelRequested = true;
          break;
        }
        throw discError('FFGUI_TRANSCODE_FAILED', t('main.disc.errTranscodeFailed', { titleId: title.titleId }), {
          message: conversionError || t('main.disc.ffmpegIncomplete'),
        });
      } catch (err) {
        if (state.cancelRequested || (err && err.code === 'cancelled')) {
          state.cancelRequested = true;
          break;
        }
        const code = err && typeof err.code === 'string' ? err.code : 'FFGUI_DISC_FAILED';
        const params = err && isPlainObject(err.params)
          ? err.params : { message: err && err.message ? err.message : String(err) };
        const phase = state.phase || 'rip';
        const output = phase === 'transcode' ? finalOutput : ripOutput;
        emit(sender, { type: 'title-error', ...meta(phase, output), code, params });
        errors.push({ index, titleId: title.titleId, code, params });
      } finally {
        state.sidecar = null;
        state.phase = null;
        cleanupNewFile(sender, job.id, plan.ripPartial, plan.ripPartialExisted);
        if (job.mode === 'transcode') cleanupNewFile(sender, job.id, ripOutput, false);
        if (!completed) cleanupNewFile(sender, job.id, finalOutput, plan.finalExisted);
      }
    }

    const cancelled = state.cancelRequested;
    const result = { total, done, cancelled, errors };
    emit(sender, { jobId: job.id, type: 'done', total, done, cancelled });
    return result;
  }

  async function start(sender, job) {
    if (activeJob) throw discError('FFGUI_DISC_BUSY', t('main.disc.errBusy'));
    const normalized = validateDiscJob(job);
    const state = {
      id: normalized.id,
      job: normalized,
      sender,
      phase: null,
      sidecar: null,
      cancelRequested: false,
    };
    activeJob = state;
    try {
      // 在任何抓取前解析组件并分配本批全部输出，避免中途才发生名称冲突。
      const executablePath = executable();
      const plans = allocateOutputPlans(normalized, fsImpl);
      return await executeJob(state, plans, executablePath);
    } finally {
      if (activeJob === state) activeJob = null;
    }
  }

  return { probe, listDrives, start, cancel };
}

function registerDiscIpc() {
  const { app, ipcMain, dialog, BrowserWindow } = require('electron');
  const service = createDiscService({ app });
  const windowFor = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('ffgui:disc-pick-source', async (event, kind) => {
    if (kind !== 'iso' && kind !== 'folder') throw invalid('kind', t('main.disc.errPickKind'));
    const res = await dialog.showOpenDialog(windowFor(event), {
      title: kind === 'iso' ? t('main.dialog.pickIsoImage') : t('main.dialog.pickDiscFolder'),
      properties: [kind === 'iso' ? 'openFile' : 'openDirectory'],
      filters: kind === 'iso' ? [
        { name: t('main.dialog.filterIsoImage'), extensions: ['iso'] },
        { name: t('main.dialog.filterAllFiles'), extensions: ['*'] },
      ] : undefined,
    });
    return res.canceled || !res.filePaths[0] ? null : { kind, path: res.filePaths[0] };
  });

  ipcMain.handle('ffgui:disc-pick-keydb', async (event) => {
    const res = await dialog.showOpenDialog(windowFor(event), {
      title: t('main.dialog.pickKeydb'),
      properties: ['openFile'],
      filters: [
        { name: t('main.dialog.filterKeydb'), extensions: ['cfg'] },
        { name: t('main.dialog.filterAllFiles'), extensions: ['*'] },
      ],
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  ipcMain.handle('ffgui:disc-list-drives', () => service.listDrives());
  ipcMain.handle('ffgui:disc-probe', (_event, source) => service.probe(source));
  ipcMain.handle('ffgui:disc-start', (event, job) => service.start(event.sender, job));
  ipcMain.handle('ffgui:disc-cancel', (_event, jobId) => service.cancel(jobId));
}

module.exports = {
  registerDiscIpc,
  createDiscService,
  validateDiscJob,
  resolveDiscSidecarPath,
  safeFilePart,
};
