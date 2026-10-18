'use strict';

// 运行：node --test scripts/disc.test.cjs
// 主进程光盘任务测试：mock 侧车与单文件转换，不依赖 Electron、Rust 二进制或 FFmpeg。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  createDiscService,
  validateDiscJob,
  resolveDiscSidecarPath,
} = require('../main/disc.js');

const repo = path.resolve(__dirname, '..');
const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function fingerprint(id, over = {}) {
  return { id, firstLba: 10, sectors: 20, durationSecs: 60, sizeBytes: 40960, ...over };
}

function title(id = 'bluray/00000.mpls', over = {}) {
  return {
    titleId: id,
    titleFingerprint: fingerprint(id),
    audioTrackIds: null,
    subtitleTrackIds: null,
    ...over,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-disc-main-'));
  tempRoots.push(dir);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const binary = path.join(dir, process.platform === 'win32' ? 'ffgui-disc.exe' : 'ffgui-disc');
  fs.writeFileSync(binary, 'mock');
  const events = [];
  const invocations = [];
  const conversions = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel, event) => {
      assert.equal(channel, 'ffgui:disc-event');
      events.push(event);
    },
  };
  const state = { conversionCancelCalls: 0 };

  async function defaultSidecar(invocation) {
    const { method, params } = invocation.request;
    if (method === 'probe') return { disc: { format: 'bluray', label: 'TEST', titles: [] } };
    if (method === 'list-drives') return { drives: [{ kind: 'drive', path: 'D:', label: 'DVD' }] };
    if (method === 'rip') {
      fs.writeFileSync(params.output, `rip:${params.titleId}`);
      return { output: params.output, titleId: params.titleId };
    }
    throw new Error(`未知 method ${method}`);
  }

  const service = createDiscService({
    app: { isPackaged: false, getAppPath: () => repo },
    env: { FFGUI_DISC_SIDECAR: binary },
    createSidecar: ({ executable, request, onEvent }) => {
      const invocation = { executable, request, onEvent, cancelCalls: 0 };
      invocations.push(invocation);
      return {
        run: () => (options.runSidecar || defaultSidecar)(invocation),
        cancel: () => {
          invocation.cancelCalls += 1;
          if (options.onSidecarCancel) options.onSidecarCancel(invocation);
        },
      };
    },
    runConversion: async (payload) => {
      conversions.push(payload);
      if (options.runConversion) return options.runConversion(payload);
      fs.writeFileSync(payload.output, 'transcoded');
      return { ok: true };
    },
    cancelConversion: () => {
      state.conversionCancelCalls += 1;
      if (options.onConversionCancel) options.onConversionCancel();
    },
  });

  return { dir, out, binary, events, invocations, conversions, sender, service, state };
}

function jobFor(h, over = {}) {
  return {
    id: 'job-1',
    source: { kind: 'iso', path: path.join(h.dir, 'Movie Disc.iso'), label: '界面专用' },
    keydbPath: null,
    outputDir: h.out,
    mode: 'copy',
    format: 'mkv',
    quality: 'high',
    audioCodec: 'copy',
    titles: [title()],
    ...over,
  };
}

function error(code, params = {}) {
  const err = new Error(code);
  err.code = code;
  err.params = params;
  return err;
}

async function until(predicate, message = '等待条件超时') {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('任务白名单：选轨三态保留、顺序去重，来源与指纹只进入协议字段', () => {
  const h = harness();
  const job = jobFor(h, {
    titles: [title('a', { audioTrackIds: undefined, subtitleTrackIds: [] })],
  });
  const normalized = validateDiscJob(job);
  assert.deepEqual(normalized.source, { kind: 'iso', path: job.source.path });
  assert.equal(normalized.titles[0].audioTrackIds, null);
  assert.deepEqual(normalized.titles[0].subtitleTrackIds, []);
  assert.deepEqual(normalized.titles[0].titleFingerprint, fingerprint('a'));
  const deduped = validateDiscJob(jobFor(h, {
    titles: [title('b', {
      audioTrackIds: ['s2:p2:eng', 's1:p1:chi', 's2:p2:eng', 's1:p1:chi'],
      subtitleTrackIds: ['s4:p4:eng', 's3:p3:chi', 's4:p4:eng'],
    })],
  })).titles[0];
  assert.deepEqual(deduped.audioTrackIds, ['s2:p2:eng', 's1:p1:chi']);
  assert.deepEqual(deduped.subtitleTrackIds, ['s4:p4:eng', 's3:p3:chi']);

  for (const mutate of [
    (j) => { j.mode = 'other'; },
    (j) => { j.format = 'mp4'; },
    (j) => { j.audioCodec = 'aac'; },
    (j) => { j.quality = 'best'; },
    (j) => { j.titles = []; },
    (j) => { j.titles[0].audioTrackIds = 'all'; },
    (j) => { j.titles[0].audioTrackIds = ['']; },
    (j) => { j.titles[0].titleFingerprint = null; },
    (j) => { j.titles[0].titleFingerprint.id = 'different'; },
  ]) {
    const bad = jobFor(h);
    mutate(bad);
    assert.throws(() => validateDiscJob(bad), (err) => err.code === 'FFGUI_INVALID_JOB');
  }
});

test('MP4 转码必须 AAC 且每个标题显式 subtitleTrackIds=[]', () => {
  const h = harness();
  for (const subs of [undefined, null, ['s2:p3:chi']]) {
    const job = jobFor(h, {
      mode: 'transcode',
      format: 'mp4',
      audioCodec: 'aac',
      titles: [title('a', { subtitleTrackIds: subs })],
    });
    assert.throws(() => validateDiscJob(job), /显式选择不保留字幕/);
  }
  const valid = jobFor(h, {
    mode: 'transcode', format: 'mp4', audioCodec: 'aac',
    titles: [title('a', { subtitleTrackIds: [] })],
  });
  assert.deepEqual(validateDiscJob(valid).titles[0].subtitleTrackIds, []);
  valid.audioCodec = 'copy';
  assert.throws(() => validateDiscJob(valid), /仅支持 AAC/);
});

test('copy 多标题串行：完整 rip 参数、指纹、日志/进度和最终事件', async () => {
  let running = 0;
  let maxRunning = 0;
  const h = harness({
    runSidecar: async (inv) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      const { params } = inv.request;
      inv.onEvent({ type: 'progress', bytesDone: 50, bytesTotal: 100, speedBps: 25, etaSecs: 2, pass: 'mux' });
      inv.onEvent({ type: 'log', level: 'info', code: 'RIP_TEST', params: { n: 1 } });
      fs.writeFileSync(params.output, params.titleId);
      running -= 1;
      return { output: params.output, titleId: params.titleId };
    },
  });
  const first = title('bluray/00000.mpls', { audioTrackIds: undefined, subtitleTrackIds: [] });
  const second = title('dvd/VTS_01_1.VOB', { audioTrackIds: ['s1:p256:eng'], subtitleTrackIds: null });
  const result = await h.service.start(h.sender, jobFor(h, {
    keydbPath: path.join(h.dir, 'KEYDB.cfg'),
    titles: [first, second],
  }));
  assert.deepEqual(result, { total: 2, done: 2, cancelled: false, errors: [] });
  assert.equal(maxRunning, 1, '标题必须串行抓取');
  assert.equal(h.invocations.length, 2);
  for (let i = 0; i < 2; i++) {
    const req = h.invocations[i].request;
    assert.equal(req.method, 'rip');
    assert.equal(req.params.titleId, jobFor(h, { titles: [first, second] }).titles[i].titleId);
    assert.equal(req.params.keydbPath, path.join(h.dir, 'KEYDB.cfg'));
    assert.deepEqual(req.params.titleFingerprint, i === 0 ? first.titleFingerprint : second.titleFingerprint);
    assert.equal('label' in req.params.source, false);
    assert.equal(req.params.output, h.events.filter((e) => e.type === 'title-done')[i].output);
  }
  assert.equal(h.invocations[0].request.params.audioTrackIds, null);
  assert.deepEqual(h.invocations[0].request.params.subtitleTrackIds, []);
  assert.deepEqual(h.invocations[1].request.params.audioTrackIds, ['s1:p256:eng']);
  const progress = h.events.find((e) => e.type === 'progress');
  assert.equal(progress.percent, 50);
  assert.equal(progress.phase, 'rip');
  assert.equal(progress.bytesDone, 50);
  assert.equal(progress.speedBps, 25);
  assert.equal(progress.pass, 'mux');
  assert.equal(h.events.filter((e) => e.type === 'log').length, 2);
  assert.deepEqual(h.events.at(-1), { jobId: 'job-1', type: 'done', total: 2, done: 2, cancelled: false });
});

test('Rust 日志正文优先 event.message，其次 params.message，最后回退 code', async () => {
  const h = harness({
    runSidecar: async (inv) => {
      inv.onEvent({
        type: 'log', code: 'DIRECT', message: 'event 正文',
        params: { message: 'params 不应优先' },
      });
      inv.onEvent({ type: 'log', code: 'PARAMS', params: { message: 'params 正文' } });
      inv.onEvent({ type: 'log', code: 'ENGINE_LOG', params: {} });
      fs.writeFileSync(inv.request.params.output, 'ok');
      return { output: inv.request.params.output, titleId: inv.request.params.titleId };
    },
  });
  await h.service.start(h.sender, jobFor(h));
  const logs = h.events.filter((event) => event.type === 'log');
  assert.deepEqual(logs.map((event) => event.message), ['event 正文', 'params 正文', 'ENGINE_LOG']);
  assert.equal(logs[1].code, 'PARAMS');
  assert.deepEqual(logs[1].params, { message: 'params 正文' });
});

test('输出名由源名和 titleId 安全生成，预分配避开已有文件与批内冲突', async () => {
  const h = harness();
  const existing = path.join(h.out, 'Movie Disc_bluray_00000.mpls.mkv');
  fs.writeFileSync(existing, '不得覆盖');
  const result = await h.service.start(h.sender, jobFor(h, {
    titles: [title(), title('dvd/VTS_01_1.VOB')],
  }));
  assert.equal(result.done, 2);
  const outputs = h.invocations.map((i) => i.request.params.output);
  assert.equal(new Set(outputs).size, 2);
  assert.notEqual(outputs[0], existing);
  assert.match(path.basename(outputs[0]), /Movie Disc_bluray_00000\.mpls_2\.mkv$/);
  assert.equal(fs.readFileSync(existing, 'utf8'), '不得覆盖');
  for (const output of outputs) assert.equal(fs.existsSync(output), true);
});

test('transcode/MKV：rip 写任务临时文件，内部转换保留章节并映射进度，结束后清临时', async () => {
  const h = harness({
    runConversion: async (payload) => {
      assert.equal(fs.existsSync(payload.input), true);
      payload.send({ type: 'progress', percent: 40, time: 4, duration: 10, speed: '2x' });
      fs.writeFileSync(payload.output, 'final');
      return { ok: true };
    },
  });
  const result = await h.service.start(h.sender, jobFor(h, {
    mode: 'transcode', format: 'mkv', audioCodec: 'copy', quality: 'low',
  }));
  assert.equal(result.done, 1);
  assert.equal(h.conversions.length, 1);
  const conversion = h.conversions[0];
  const ripOutput = h.invocations[0].request.params.output;
  assert.equal(conversion.input, ripOutput);
  assert.equal(conversion.job.preserveChapters, true);
  assert.equal(conversion.job.vcodec, 'libx264');
  assert.equal(conversion.job.acodec, 'copy');
  assert.equal(conversion.job.quality, 'low');
  assert.equal(conversion.job.pixFmt, 'yuv420p');
  assert.equal(fs.existsSync(ripOutput), false, '临时 MKV 必须清理');
  assert.equal(fs.existsSync(`${ripOutput}.ffgui-partial`), false);
  assert.equal(fs.readFileSync(conversion.output, 'utf8'), 'final');
  assert.deepEqual(h.events.filter((e) => e.type === 'title-start').map((e) => [e.phase, e.output]), [
    ['rip', ripOutput], ['transcode', conversion.output],
  ]);
  const progress = h.events.find((e) => e.type === 'progress');
  assert.equal(progress.phase, 'transcode');
  assert.equal(progress.percent, 40);
  assert.equal(progress.time, 4);
  assert.equal(progress.duration, 10);
  assert.equal(progress.speed, '2x');
});

test('transcode/MP4：AAC、显式无字幕、多标题临时路径唯一且全部清理', async () => {
  const h = harness();
  const result = await h.service.start(h.sender, jobFor(h, {
    mode: 'transcode', format: 'mp4', audioCodec: 'aac',
    titles: [title('a', { subtitleTrackIds: [] }), title('b', { subtitleTrackIds: [] })],
  }));
  assert.equal(result.done, 2);
  assert.equal(h.conversions.length, 2);
  const temps = h.invocations.map((i) => i.request.params.output);
  assert.equal(new Set(temps).size, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(h.conversions[i].job.format, 'mp4');
    assert.equal(h.conversions[i].job.acodec, 'aac');
    assert.equal(h.conversions[i].job.preserveChapters, true);
    assert.equal(path.extname(h.conversions[i].output), '.mp4');
    assert.equal(fs.existsSync(temps[i]), false);
  }
});

test('copy 失败保留 code/params，清理本次 final/partial，继续后续标题且不删已有文件', async () => {
  const h = harness({
    runSidecar: async (inv) => {
      const { params } = inv.request;
      if (params.titleId === 'bad') {
        fs.writeFileSync(params.output, '本次 final 半成品');
        fs.writeFileSync(`${params.output}.ffgui-partial`, '本次 partial');
        throw error('E7022', { sector: 1234 });
      }
      fs.writeFileSync(params.output, 'ok');
      return { output: params.output, titleId: params.titleId };
    },
  });
  const existingBad = path.join(h.out, 'Movie Disc_bad.mkv');
  fs.writeFileSync(existingBad, '任务开始前已有文件');
  const result = await h.service.start(h.sender, jobFor(h, { titles: [title('bad'), title('good')] }));
  assert.equal(result.total, 2);
  assert.equal(result.done, 1);
  assert.equal(result.cancelled, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'E7022');
  assert.deepEqual(result.errors[0].params, { sector: 1234 });
  const titleError = h.events.find((e) => e.type === 'title-error');
  assert.equal(titleError.titleId, 'bad');
  assert.equal(titleError.code, 'E7022');
  assert.deepEqual(titleError.params, { sector: 1234 });
  const badOutput = h.invocations[0].request.params.output;
  assert.notEqual(badOutput, existingBad);
  assert.equal(fs.existsSync(badOutput), false, 'copy 失败也必须清理本次 final');
  assert.equal(fs.existsSync(`${badOutput}.ffgui-partial`), false);
  assert.equal(fs.readFileSync(existingBad, 'utf8'), '任务开始前已有文件');
  assert.equal(fs.existsSync(h.invocations[1].request.params.output), true, '后续已完成标题必须保留');
});

test('转换失败：清理临时 MKV 和本次新产生的最终半成品，不静默成功', async () => {
  const h = harness({
    runConversion: async (payload) => {
      fs.writeFileSync(payload.output, '未完成');
      payload.send({ type: 'file-error', error: 'encoder failed' });
      return { ok: false };
    },
  });
  const result = await h.service.start(h.sender, jobFor(h, { mode: 'transcode' }));
  assert.equal(result.done, 0);
  assert.equal(result.errors[0].code, 'FFGUI_TRANSCODE_FAILED');
  assert.equal(result.errors[0].params.message, 'encoder failed');
  assert.equal(fs.existsSync(h.invocations[0].request.params.output), false);
  assert.equal(fs.existsSync(h.conversions[0].output), false);
});

test('copy 输出分配避开预存 partial，唯一化后正常完成且不误删旧文件', async () => {
  const h = harness();
  const occupied = path.join(h.out, 'Movie Disc_bluray_00000.mpls.mkv');
  const partial = `${occupied}.ffgui-partial`;
  const expected = path.join(h.out, 'Movie Disc_bluray_00000.mpls_2.mkv');
  fs.writeFileSync(partial, '用户已有 partial');
  const result = await h.service.start(h.sender, jobFor(h));
  assert.equal(result.done, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(h.invocations[0].request.params.output, expected);
  assert.equal(fs.readFileSync(partial, 'utf8'), '用户已有 partial');
  assert.equal(fs.existsSync(expected), true);
});

test('copy 取消清理当前新 final/partial，保留已完成标题和已有文件', async () => {
  const pending = deferred();
  const h = harness({
    runSidecar: async (inv) => {
      if (inv.request.params.titleId === 'first') {
        fs.writeFileSync(inv.request.params.output, 'copy 已完成');
        return { output: inv.request.params.output, titleId: 'first' };
      }
      return pending.promise;
    },
    onSidecarCancel: (inv) => {
      fs.writeFileSync(inv.request.params.output, '取消产生的 final');
      fs.writeFileSync(`${inv.request.params.output}.ffgui-partial`, '取消产生的 partial');
      pending.reject(error('cancelled'));
    },
  });
  const existingSecond = path.join(h.out, 'Movie Disc_second.mkv');
  fs.writeFileSync(existingSecond, '取消也不得删除');
  const start = h.service.start(h.sender, jobFor(h, { titles: [title('first'), title('second')] }));
  await until(() => h.invocations.length === 2, '第二个 copy 标题尚未开始');
  assert.equal(h.service.cancel('job-1'), true);
  const result = await start;
  const completedOutput = h.invocations[0].request.params.output;
  const cancelledOutput = h.invocations[1].request.params.output;
  assert.equal(result.done, 1);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.errors, []);
  assert.notEqual(cancelledOutput, existingSecond);
  assert.equal(fs.readFileSync(completedOutput, 'utf8'), 'copy 已完成');
  assert.equal(fs.existsSync(cancelledOutput), false, 'copy 取消必须清理当前新 final');
  assert.equal(fs.existsSync(`${cancelledOutput}.ffgui-partial`), false);
  assert.equal(fs.readFileSync(existingSecond, 'utf8'), '取消也不得删除');
});

test('transcode rip 取消：只取消当前侧车、停止后续标题，清临时且保留已完成最终文件', async () => {
  const pending = deferred();
  const h = harness({
    runSidecar: async (inv) => {
      if (inv.request.params.titleId === 'first') {
        fs.writeFileSync(inv.request.params.output, '抓取完成');
        return { output: inv.request.params.output, titleId: 'first' };
      }
      return pending.promise;
    },
    onSidecarCancel: (inv) => {
      fs.writeFileSync(inv.request.params.output, '删除我');
      fs.writeFileSync(`${inv.request.params.output}.ffgui-partial`, '删除我');
      pending.reject(error('cancelled'));
    },
  });
  const start = h.service.start(h.sender, jobFor(h, {
    mode: 'transcode', titles: [title('first'), title('second')],
  }));
  await until(() => h.invocations.length === 2, '第二个标题尚未开始');
  assert.equal(h.service.cancel('wrong-job'), false);
  assert.equal(h.service.cancel('job-1'), true);
  assert.equal(h.invocations[1].cancelCalls, 1);
  const result = await start;
  const firstTemp = h.invocations[0].request.params.output;
  const firstFinal = h.conversions[0].output;
  const secondTemp = h.invocations[1].request.params.output;
  assert.equal(result.done, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.errors.length, 0);
  assert.equal(h.invocations.length, 2);
  assert.equal(fs.readFileSync(firstFinal, 'utf8'), 'transcoded');
  assert.equal(fs.existsSync(firstTemp), false);
  assert.equal(fs.existsSync(secondTemp), false);
  assert.equal(fs.existsSync(`${secondTemp}.ffgui-partial`), false);
  assert.equal(h.events.some((e) => e.type === 'title-error'), false);
  assert.equal(h.events.at(-1).cancelled, true);
});

test('FFmpeg 阶段取消走内部取消接口，并清理转码输入和输出半成品', async () => {
  const pending = deferred();
  const h = harness({
    runConversion: async (payload) => {
      fs.writeFileSync(payload.output, '转码半成品');
      return pending.promise;
    },
    onConversionCancel: () => pending.resolve({ ok: false, cancelled: true }),
  });
  const start = h.service.start(h.sender, jobFor(h, { mode: 'transcode' }));
  await until(() => h.conversions.length === 1, '转换尚未开始');
  assert.equal(h.service.cancel('job-1'), true);
  assert.equal(h.state.conversionCancelCalls, 1);
  const result = await start;
  assert.equal(result.cancelled, true);
  assert.equal(result.done, 0);
  assert.equal(fs.existsSync(h.invocations[0].request.params.output), false);
  assert.equal(fs.existsSync(h.conversions[0].output), false);
});

test('同一时间仅一个 disc job，结束后 jobId 可复用', async () => {
  const pending = deferred();
  let blocked = true;
  const h = harness({
    runSidecar: async (inv) => {
      if (blocked) return pending.promise;
      fs.writeFileSync(inv.request.params.output, 'ok');
      return { output: inv.request.params.output, titleId: inv.request.params.titleId };
    },
  });
  const first = h.service.start(h.sender, jobFor(h));
  await until(() => h.invocations.length === 1);
  await assert.rejects(h.service.start(h.sender, jobFor(h)), (err) => err.code === 'FFGUI_DISC_BUSY');
  pending.resolve({ output: h.invocations[0].request.params.output, titleId: title().titleId });
  assert.equal((await first).done, 1);
  blocked = false;
  assert.equal((await h.service.start(h.sender, jobFor(h))).done, 1);
});

test('probe 返回 result.disc；list-drives 成功、错误及 warning 的 unsupported 语义', async () => {
  const h = harness();
  const disc = await h.service.probe({ kind: 'iso', path: 'disc.iso', label: 'strip' });
  assert.deepEqual(disc, { format: 'bluray', label: 'TEST', titles: [] });
  assert.deepEqual(h.invocations[0].request.params, { source: { kind: 'iso', path: 'disc.iso' } });
  assert.deepEqual(await h.service.listDrives(), { drives: [{ kind: 'drive', path: 'D:', label: 'DVD' }] });

  const unsupported = harness({ runSidecar: async () => { throw error('FFGUI_UNSUPPORTED', { kind: 'drive' }); } });
  assert.deepEqual(await unsupported.service.listDrives(), { drives: [], code: 'FFGUI_UNSUPPORTED' });
  const warning = harness({
    runSidecar: async (inv) => {
      inv.onEvent({ type: 'log', code: 'LIST_DRIVES_UNSUPPORTED_PLATFORM', params: {} });
      return { drives: [] };
    },
  });
  assert.deepEqual(await warning.service.listDrives(), { drives: [], code: 'LIST_DRIVES_UNSUPPORTED_PLATFORM' });
});

test('侧车路径：环境变量优先、开发 release 优先 debug、打包 resources/disc，缺失明确报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-disc-path-'));
  tempRoots.push(root);
  const appRoot = path.join(root, 'app');
  const target = path.join(appRoot, 'native', 'ffgui-disc', 'target');
  const release = path.join(target, 'release', 'ffgui-disc.exe');
  const debug = path.join(target, 'debug', 'ffgui-disc.exe');
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.mkdirSync(path.dirname(debug), { recursive: true });
  fs.writeFileSync(debug, 'debug');
  const app = { isPackaged: false, getAppPath: () => appRoot };
  assert.equal(resolveDiscSidecarPath({ app, env: {}, platform: 'win32' }), debug);
  fs.writeFileSync(release, 'release');
  assert.equal(resolveDiscSidecarPath({ app, env: {}, platform: 'win32' }), release);
  const override = path.join(root, 'custom.exe');
  fs.writeFileSync(override, 'custom');
  assert.equal(resolveDiscSidecarPath({ app, env: { FFGUI_DISC_SIDECAR: override }, platform: 'win32' }), override);
  const packaged = path.join(root, 'resources', 'disc', 'ffgui-disc.exe');
  fs.mkdirSync(path.dirname(packaged), { recursive: true });
  fs.writeFileSync(packaged, 'packaged');
  assert.equal(resolveDiscSidecarPath({
    app: { isPackaged: true, getAppPath: () => appRoot }, resourcesPath: path.join(root, 'resources'),
    env: {}, platform: 'win32',
  }), packaged);

  const missing = harness();
  missing.service = createDiscService({
    app: { isPackaged: false, getAppPath: () => repo },
    env: { FFGUI_DISC_SIDECAR: path.join(missing.dir, 'missing.exe') },
    createSidecar: () => assert.fail('缺二进制时不得启动侧车'),
  });
  await assert.rejects(missing.service.probe({ kind: 'iso', path: 'x.iso' }),
    (err) => err.code === 'FFGUI_DISC_SIDECAR_NOT_FOUND');
  await assert.rejects(missing.service.listDrives(),
    (err) => err.code === 'FFGUI_DISC_SIDECAR_NOT_FOUND');
  await assert.rejects(missing.service.start(missing.sender, jobFor(missing)),
    (err) => err.code === 'FFGUI_DISC_SIDECAR_NOT_FOUND');
});

test('FFmpeg 参数仅对内部 preserveChapters=true 映射章节，并导出窄内部接口', () => {
  const source = fs.readFileSync(path.join(repo, 'main/ffmpeg.js'), 'utf8');
  const ctx = {
    require: (name) => name === 'electron'
      ? { app: { isPackaged: false, getAppPath: () => repo } }
      // 主进程文案走 locales/<lng>.json；vm 沙箱里的相对 require 需按仓库根解析
      : name === './i18n' ? require(path.join(repo, 'main', 'i18n.js'))
        : require(name),
    process,
    console: { log() {} },
    module: { exports: {} },
  };
  vm.createContext(ctx);
  vm.runInContext(`${source}\nmodule.exports = { buildArgs, runSingleFileConversion, cancelCurrentTask };`, ctx);
  const api = ctx.module.exports;
  assert.equal(typeof api.runSingleFileConversion, 'function');
  assert.equal(typeof api.cancelCurrentTask, 'function');
  const base = { format: 'mkv', vcodec: 'libx264', acodec: 'aac', quality: 'high' };
  const withChapters = api.buildArgs({ ...base, preserveChapters: true }, 'input.mkv', 'output.mkv');
  const at = withChapters.indexOf('-map_chapters');
  assert.ok(at >= 0);
  assert.equal(withChapters[at + 1], '0');
  const ordinary = api.buildArgs(base, 'input.mkv', 'output.mkv');
  assert.equal(ordinary.includes('-map_chapters'), false, '普通转码默认行为不得改变');
});
