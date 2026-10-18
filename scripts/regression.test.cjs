// 运行：npm test。需要 ffmpeg（libx264/AAC/libmp3lame/FLAC/subtitles）及 ffprobe。
// 也可用 FFMPEG、FFPROBE 指定二进制；测试媒体只写入独立临时目录。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const repo = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-regression-'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const source = fs.readFileSync(path.join(repo, 'main/ffmpeg.js'), 'utf8');
const quiet = { log() {} };
function load(overrides = {}) {
  const childProcess = {
    ...cp,
    execFile: (_, ...args) => cp.execFile(ffmpeg, ...args),
    spawn: (_, ...args) => cp.spawn(ffmpeg, ...args),
    ...overrides,
  };
  const ctx = {
    require: (n) => n === 'electron'
      ? { app: { isPackaged: false, getAppPath: () => repo, getPath: () => temp } }
      : n === 'child_process' ? childProcess
        // 主进程文案走 locales/<lng>.json；vm 沙箱里的相对 require 需按仓库根解析
        : n === './i18n' ? require(path.join(repo, 'main', 'i18n.js'))
          : require(n),
    process, console: quiet, module: { exports: {} },
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nmodule.exports = {buildArgs, buildClipArgs, buildMergeArgs, buildOutputPath, '
    + 'pathKey, probeFile, validateAudioSelection, runFfmpegTask, runJob, cancelCurrentTask};', ctx);
  return ctx.module.exports;
}
const api = load();
function execute(args, success = true) {
  const r = cp.spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (success) assert.equal(r.status, 0, r.error?.message || r.stderr);
  return r;
}
function probe(file) {
  return JSON.parse(cp.execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
function audios(file) { return probe(file).streams.filter((s) => s.codec_type === 'audio'); }
function dims(file) {
  const v = probe(file).streams.find((s) => s.codec_type === 'video');
  return [v.width, v.height];
}
// 取指定位置的像素（RGB），用于验证 crop 的 x/y 偏移真的生效（尺寸正确不代表区域正确）
function pixelAt(file, x, y) {
  const [w] = dims(file);
  const buf = cp.execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 4 * 1024 * 1024 });
  assert.ok(buf.length >= w * 3, '必须实际解码出画面');
  const i = (y * w + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
}
// 编码有损，纯色也会有少量偏差，逐通道允许小误差
function nearPixel(file, x, y, expect, tol = 4) {
  const px = pixelAt(file, x, y);
  expect.forEach((v, i) => assert.ok(Math.abs(px[i] - v) <= tol,
    `像素 (${x},${y}) 通道 ${i} 期望 ${v}±${tol}，实际 ${px[i]}`));
  return px;
}
function decode(file, track, start = 0.2, duration = 0.3) {
  return cp.execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-ss', String(start), '-map', `0:a:${track}`,
    '-t', String(duration), '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 8 * 1024 * 1024 });
}
function rms(bytes) {
  let energy = 0;
  for (let i = 0; i < bytes.length; i += 4) energy += bytes.readFloatLE(i) ** 2;
  assert.ok(bytes.length > 0, '必须实际解码出音频');
  return Math.sqrt(energy / (bytes.length / 4));
}
function frequency(bytes) {
  let crossings = 0;
  for (let i = 4; i < bytes.length; i += 4) {
    if (bytes.readFloatLE(i - 4) <= 0 && bytes.readFloatLE(i) > 0) crossings++;
  }
  return crossings / (bytes.length / 4 / 8000);
}
const dual = path.join(temp, 'dual.mkv');
const silent = path.join(temp, 'silent.mp4');
const audio = path.join(temp, 'audio.m4a');
const subtitle = path.join(temp, 'normal.srt');
let dualProbe, silentProbe, audioProbe;
before(async () => {
  execute(['-hide_banner', '-n', '-f', 'lavfi', '-i', 'color=s=160x120:r=10:d=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.2',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-g', '1', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng',
    '-disposition:a:0', '0', '-disposition:a:1', 'default', dual]);
  execute(['-hide_banner', '-n', '-i', dual, '-map', '0:v:0', '-c', 'copy', silent]);
  execute(['-hide_banner', '-n', '-i', dual, '-map', '0:a:0', '-c', 'copy', audio]);
  fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  [dualProbe, silentProbe, audioProbe] = await Promise.all([dual, silent, audio].map(api.probeFile));
});
after(() => {
  if (process.env.KEEP_TEST_MEDIA) console.log('测试媒体：', temp);
  else fs.rmSync(temp, { recursive: true, force: true });
});

test('转码：MKV/MP4 的复制和 AAC 重编码均保留两条独立音轨及语言、默认轨', async (t) => {
  for (const format of ['mkv', 'mp4']) for (const acodec of ['copy', 'aac']) {
    await t.test(`${format}/${acodec}`, () => {
      const out = path.join(temp, `convert-${acodec}.${format}`);
      execute(api.buildArgs({ format, vcodec: 'copy', acodec }, dual, out));
      const tracks = audios(out);
      assert.equal(tracks.length, 2);
      assert.deepEqual(tracks.map((s) => s.tags.language), ['jpn', 'eng']);
      assert.deepEqual(tracks.map((s) => s.disposition.default), [0, 1]);
      assert.ok(Math.abs(frequency(decode(out, 0)) - 440) < 12);
      assert.ok(Math.abs(frequency(decode(out, 1)) - 880) < 12);
    });
  }
});

test('MKV 转码和截取保留两条字幕及附件，截取保留全部音轨', () => {
  const input = path.join(temp, 'with-subs.mkv');
  const attachment = path.join(temp, 'attachment.txt');
  fs.writeFileSync(attachment, '附件回归测试');
  execute(['-n', '-i', dual, '-i', subtitle, '-map', '0', '-map', '1:0', '-map', '1:0',
    '-c', 'copy', '-attach', attachment, '-metadata:s:t:0', 'mimetype=text/plain', input]);
  for (const mode of ['convert', 'clip']) {
    const out = path.join(temp, `with-subs-${mode}.mkv`);
    execute(mode === 'clip' ? api.buildClipArgs({ input, start: 0.1, end: 0.8 }, out)
      : api.buildArgs({ format: 'mkv', vcodec: 'copy', acodec: 'copy' }, input, out));
    const ss = probe(out).streams;
    assert.equal(ss.filter((s) => s.codec_type === 'audio').length, 2);
    assert.equal(ss.filter((s) => s.codec_type === 'subtitle').length, 2);
    assert.equal(ss.filter((s) => s.codec_type === 'attachment').length, 1);
  }
});

test('无音频、禁音、纯音频、GIF 输出不受全部音轨映射影响', () => {
  for (const [name, input, job, expected] of [
    ['silent.mp4', silent, { format: 'mp4', vcodec: 'copy', acodec: 'copy' }, ['video']],
    ['muted.mp4', dual, { format: 'mp4', vcodec: 'copy', acodec: 'none' }, ['video']],
    ['all.m4a', dual, { format: 'm4a', vcodec: 'none', acodec: 'aac' }, ['audio', 'audio']],
    ['animation.gif', dual, { format: 'gif', vcodec: 'auto', acodec: 'none' }, ['video']],
  ]) {
    const out = path.join(temp, `mode-${name}`);
    execute(api.buildArgs(job, input, out));
    assert.deepEqual(probe(out).streams.map((s) => s.codec_type), expected);
  }
});

test('单音轨格式拒绝隐式丢轨，选择第 2 轨可导出且确实是 880 Hz', async () => {
  for (const format of ['mp3', 'wav', 'flac', 'flv']) {
    assert.throws(() => api.validateAudioSelection({ format }, [dualProbe]), /明确选轨|填写/);
  }
  for (const format of ['mp3', 'wav', 'flac']) {
    const events = [];
    const sender = { isDestroyed: () => false, send: (_, e) => events.push(e) };
    const result = await api.runJob(sender, { inputs: [dual], outputDir: temp, format, vcodec: 'none', acodec: 'auto', audioTrack: 2 });
    assert.equal(result.done, 1, JSON.stringify(events));
    const out = events.find((e) => e.type === 'file-done').output;
    assert.equal(audios(out).length, 1);
    const hz = frequency(decode(out, 0));
    assert.ok(Math.abs(hz - 880) < 12, `${format}: ${hz} Hz，${out}`);
  }
  assert.throws(() => api.validateAudioSelection({ format: 'mkv', audioTrack: 3 }, [dualProbe]), /没有第 3/);
  assert.throws(() => api.validateAudioSelection({ format: 'mkv', audioTrack: 1.5 }, [dualProbe]), /整数/);
  const events = [];
  const result = await api.runJob({ isDestroyed: () => false, send: (_, e) => events.push(e) },
    { inputs: [dual], outputDir: temp, format: 'mp3', vcodec: 'none', acodec: 'auto' });
  assert.equal(result.done, 0);
  assert.equal(events.some((e) => e.type === 'file-start'), false);
  assert.match(events[0].error, /填写/);
});

test('输出避开所有源文件、历史输出和批内同名目标；执行时 -n 保护后来出现的文件', async () => {
  const dir = path.join(temp, 'collision');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'same.mkv'), b = path.join(dir, 'same.mp4');
  fs.copyFileSync(dual, a); fs.copyFileSync(silent, b);
  const originals = [fs.readFileSync(a), fs.readFileSync(b)];
  const events = [];
  const result = await api.runJob({ isDestroyed: () => false, send: (_, e) => events.push(e) },
    { inputs: [a, b], format: 'mp4', vcodec: 'copy', acodec: 'copy' });
  assert.equal(result.done, 2, JSON.stringify(events));
  assert.ok(fs.readFileSync(a).equals(originals[0]));
  assert.ok(fs.readFileSync(b).equals(originals[1]));
  const reserved = new Set([api.pathKey(a), api.pathKey(b)]);
  const first = api.buildOutputPath(a, dir, 'mp4', reserved);
  const second = api.buildOutputPath(a, dir, 'mp4', reserved);
  assert.notEqual(first, second);
  fs.writeFileSync(first, '在命令启动前出现的文件');
  const protectedBytes = fs.readFileSync(first);
  const refused = execute(api.buildArgs({ format: 'mp4', vcodec: 'copy', acodec: 'copy' }, a, first), false);
  assert.ok(fs.readFileSync(first).equals(protectedBytes));
  assert.match(refused.stderr, /already exists|Not overwriting/);
});

test('多音轨合并：逐轨音频正确，视频缺轨及纯音频段补静音；字幕输入不扰乱索引', () => {
  const task = api.buildMergeArgs({ inputs: [dual, silent, audio], format: 'mkv', outputDir: temp,
    subtitle: { path: subtitle, mode: 'embed' } }, [dualProbe, silentProbe, audioProbe], true);
  execute(task.args);
  const out = task.args.at(-1);
  assert.equal(audios(out).length, 2);
  assert.deepEqual(audios(out).map((s) => s.tags.language), ['jpn', 'eng']);
  assert.equal(probe(out).streams.filter((s) => s.codec_type === 'subtitle').length, 1);
  const duration = Number(probe(out).format.duration);
  assert.ok(duration > 3.5 && duration < 4, `输出时长 ${duration}`);
  assert.ok(Math.abs(frequency(decode(out, 1)) - 880) < 12);
  assert.ok(rms(decode(out, 1, 1.6)) < 0.001);
  assert.ok(rms(decode(out, 1, 2.8)) < 0.001);
  assert.ok(rms(decode(out, 0, 2.8)) > 0.02);
});

test('纯音频多轨 M4A 合并、指定第 2 轨和全静音视频合并', async () => {
  const dualAudio = path.join(temp, 'dual-audio.m4a');
  execute(['-n', '-i', dual, '-map', '0:a', '-c', 'copy', dualAudio]);
  const p = await api.probeFile(dualAudio);
  for (const [inputs, probes, format, audioTrack, count] of [
    [[dualAudio, audio], [p, audioProbe], 'm4a', '', 2],
    [[dualAudio, audio], [p, audioProbe], 'mp3', 2, 1],
    [[silent, silent], [silentProbe, silentProbe], 'mp4', '', 1],
  ]) {
    const task = api.buildMergeArgs({ inputs, format, outputDir: temp, audioTrack }, probes, true);
    execute(task.args);
    assert.equal(audios(task.args.at(-1)).length, count);
  }
});

test('字幕烧录路径：空格、中文、单引号及滤镜特殊字符', () => {
  const names = ["it's.srt", '中文 空格.srt'];
  if (process.platform !== 'win32') names.push(" it's: [x],;\\字幕 .srt");
  for (const name of names) {
    const sub = path.join(temp, name);
    fs.copyFileSync(subtitle, sub);
    const task = api.buildMergeArgs({ inputs: [dual], format: 'mkv', outputDir: temp,
      subtitle: { path: sub, mode: 'burn' } }, [dualProbe], true);
    execute(task.args);
    assert.equal(audios(task.args.at(-1)).length, 2);
  }
});

test('进度跨块甚至逐字节到达仍保留时间、速度和文件名', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const mock = load({ spawn: () => child });
  const events = [];
  const pending = mock.runFfmpegTask({ args: [], index: 0, label: dual, output: 'test',
    getDuration: () => 10, send: (e) => events.push(e), taskName: '测试' });
  for (const c of 'out_time=00:00:05.000000\nspeed=1x\nprogress=continue\n') child.stdout.emit('data', Buffer.from(c));
  child.stdout.emit('data', Buffer.from('out_time=00:00:10.000000\nprogress=end\n'));
  child.emit('close', 0);
  await pending;
  const progress = events.filter((e) => e.type === 'progress');
  assert.deepEqual(progress.map((e) => e.percent), [50, 99]);
  assert.equal(progress[0].speed, '1x');
  assert.equal(progress[0].input, dual);
  assert.equal(progress[1].speed, '');
  assert.equal(progress[1].done, true);
});

test('拒绝覆盖即使返回退出码 0，也不能误报任务完成', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const mock = load({ spawn: () => child });
  const events = [];
  const pending = mock.runFfmpegTask({ args: [], index: 0, label: dual, output: dual,
    getDuration: () => 1, send: (e) => events.push(e), taskName: '测试' });
  child.stderr.emit('data', Buffer.from(`File '${dual}' already exists. Exiting.\n`));
  child.emit('close', 0);
  assert.equal((await pending).ok, false);
  assert.equal(events.some((e) => e.type === 'file-done'), false);
  assert.match(events.find((e) => e.type === 'file-error').error, /already exists/);
});

test('取消任务时删除本次产生的半成品，不误删任务开始前已存在的文件', async () => {
  const dir = path.join(temp, 'cancel');
  fs.mkdirSync(dir, { recursive: true });
  // 子进程 mock：EventEmitter + kill()，与 load({spawn:()=>child}) 的既有用法一致
  const mockChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    return child;
  };
  const start = (mock, output, events = []) => mock.runFfmpegTask({
    args: [], index: 0, label: dual, output, getDuration: () => 10,
    send: (e) => events.push(e), taskName: '测试',
  });
  // 1. 取消时已写出的半成品被删除，返回值仍是 cancelled
  const partial = path.join(dir, 'partial.mkv');
  {
    const child = mockChild();
    const mock = load({ spawn: () => child });
    const events = [];
    const pending = start(mock, partial, events);
    fs.writeFileSync(partial, '半成品数据');
    mock.cancelCurrentTask();
    assert.equal(child.killed, true, '取消应结束子进程');
    child.emit('close', 1);
    const result = await pending;
    // 结果对象由 vm 上下文创建，逐字段比较而不是 deepEqual
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(fs.existsSync(partial), false, '取消后必须删除半成品输出');
    assert.equal(events.some((e) => e.type === 'file-done'), false);
    assert.match(events.find((e) => e.type === 'file-error').error, /已取消/);
  }
  // 2. 任务开始前已存在的同名文件在取消时不能被误删
  const existing = path.join(dir, 'existing.mkv');
  fs.writeFileSync(existing, '任务开始前的文件');
  {
    const child = mockChild();
    const mock = load({ spawn: () => child });
    const pending = start(mock, existing);
    mock.cancelCurrentTask();
    child.emit('close', 1);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(fs.readFileSync(existing, 'utf8'), '任务开始前的文件', '不得删除任务启动前已存在的文件');
  }
  // 3. 输出文件从未生成（或 output 为空）时取消也不能抛错
  for (const output of [path.join(dir, 'never-created.mkv'), '']) {
    const child = mockChild();
    const mock = load({ spawn: () => child });
    const pending = start(mock, output);
    mock.cancelCurrentTask();
    child.emit('close', 1);
    const result = await pending;
    assert.equal(result.ok, false, `output=${JSON.stringify(output)}`);
    assert.equal(result.cancelled, true, `output=${JSON.stringify(output)}`);
  }
  // 4. 正常完成保留输出；一般失败的行为保持不变（仍不清理）
  for (const [name, code, ended, ok] of [['ok.mkv', 0, true, true], ['fail.mkv', 1, false, false]]) {
    const file = path.join(dir, name);
    const child = mockChild();
    const mock = load({ spawn: () => child });
    const pending = start(mock, file);
    fs.writeFileSync(file, name === 'ok.mkv' ? '完整输出' : '失败残留');
    if (ended) child.stdout.emit('data', Buffer.from('progress=end\n'));
    else child.stderr.emit('data', Buffer.from('Conversion failed!\n'));
    child.emit('close', code);
    const result = await pending;
    assert.equal(result.ok, ok, `${name} 结果应为 ${ok}`);
    assert.equal(fs.existsSync(file), true, `${name} 不应被删除`);
  }
});

function extractFunction(src, name) {
  const start = src.indexOf('  function ' + name + '(');
  assert.ok(start >= 0);
  return src.slice(start, src.indexOf('\n  }', start) + 4);
}
test('前端进度回调在正常事件及缺省文件名时均不抛错', () => {
  const src = fs.readFileSync(path.join(repo, 'html/js/convert.js'), 'utf8');
  const start = src.indexOf('((evt) => {', src.indexOf('async function startConvert')) + 1;
  const end = src.indexOf('\n    });', start);
  const ctx = { els: { progressBar: { style: {} }, status: {} }, state: { files: [dual] }, job: { inputs: [dual] },
    setFileStatus() {}, formatSeconds: String, log() {} };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(src, 'baseName') + '\nvar handler=' + src.slice(start, end) + '\n}', ctx);
  for (const input of [dual, undefined]) {
    ctx.handler({ type: 'progress', index: 0, input, percent: 50, time: 5, duration: 10 });
    assert.match(ctx.els.status.textContent, /dual.mkv.*50%/);
  }
});

test('截取保留毫秒时间，跨分钟进位和小于 1 秒的区间正确', () => {
  const src = fs.readFileSync(path.join(repo, 'html/js/clip.js'), 'utf8');
  const stub = () => ({ value: '', classList: { remove() {} } });
  const ctx = { state: { duration: 100 }, els: { sliderStart: stub(), sliderEnd: stub(), inputStart: stub(),
    inputEnd: stub(), sliders: { style: { setProperty() {} } } } };
  vm.createContext(ctx);
  vm.runInContext(['formatTime', 'parseTime', 'setRange'].map((n) => extractFunction(src, n)).join('\n'), ctx);
  ctx.setRange(0.5, 1.8);
  assert.equal(ctx.parseTime(ctx.els.inputStart.value), 0.5);
  assert.equal(ctx.parseTime(ctx.els.inputEnd.value), 1.8);
  ctx.setRange(0.1, 0.9);
  assert.equal(ctx.parseTime(ctx.els.inputEnd.value) - ctx.parseTime(ctx.els.inputStart.value), 0.8);
  assert.equal(ctx.formatTime(59.9999), '0:01:00.000');
  const html = fs.readFileSync(path.join(repo, 'html/clip.html'), 'utf8');
  for (const id of ['slider-start', 'slider-end']) assert.match(html, new RegExp(`id="${id}"[^>]*step="0.001"`));
});

test('主题：所有页面先加载 theme.js，样式与 preload 暴露主题 API', () => {
  for (const page of ['index', 'convert', 'merge', 'clip', 'record', 'disc']) {
    const html = fs.readFileSync(path.join(repo, `html/${page}.html`), 'utf8');
    const themeIdx = html.indexOf('js/theme.js');
    const pageIdx = html.indexOf(`js/${page}.js`);
    assert.ok(themeIdx !== -1 && pageIdx !== -1 && themeIdx < pageIdx, `${page}.html 须先加载 theme.js 再加载页面脚本`);
  }
  const css = fs.readFileSync(path.join(repo, 'html/css/style.css'), 'utf8');
  assert.match(css, /:root\[data-theme="dark"\]/, '样式须含深色主题变量块');
  assert.match(css, /\.theme-toggle/, '样式须含主题切换按钮');
  const preload = fs.readFileSync(path.join(repo, 'preload/preload.js'), 'utf8');
  for (const name of ['getTheme', 'setTheme', 'onThemeChanged']) {
    assert.match(preload, new RegExp(`${name}:`), `preload 须暴露 ${name}`);
  }
});

test('页面无内联 style 属性（CSP style-src \'self\' 不允许 inline）', () => {
  for (const page of ['index', 'convert', 'merge', 'clip', 'record', 'disc']) {
    const html = fs.readFileSync(path.join(repo, `html/${page}.html`), 'utf8');
    assert.ok(!html.includes('style="'), `${page}.html 不得含内联 style 属性`);
  }
});

test('光盘抓取：IPC 注册、preload 暴露最小 API、首页入口与侧车协议契约', () => {
  const indexSrc = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
  assert.match(indexSrc, /require\('\.\/main\/disc'\)\.registerDiscIpc\(\)/,
    'index.js 须注册光盘抓取 IPC');

  const preload = fs.readFileSync(path.join(repo, 'preload/preload.js'), 'utf8');
  for (const name of ['discPickSource', 'discPickKeydb', 'discListDrives', 'discProbe',
    'discStart', 'discCancel', 'onDiscEvent']) {
    assert.match(preload, new RegExp(`${name}:`), `preload 须暴露 ${name}`);
  }
  // 渲染层不得直接接触侧车子进程或内部取消
  assert.ok(!preload.includes('createDiscSidecar'), 'preload 不得暴露侧车工厂');
  assert.ok(!preload.includes('spawn'), 'preload 不得暴露 spawn');

  const indexHtml = fs.readFileSync(path.join(repo, 'html/index.html'), 'utf8');
  assert.match(indexHtml, /data-feature="disc"/, '首页须有光盘抓取入口');
  const indexJs = fs.readFileSync(path.join(repo, 'html/js/index.js'), 'utf8');
  assert.match(indexJs, /disc\.html/, '首页跳转须指向 disc.html');

  // 侧车协议契约：选轨三态与终态事件不可被静默破坏
  const sidecar = fs.readFileSync(path.join(repo, 'main/disc.js'), 'utf8');
  assert.match(sidecar, /'FFGUI_DISC_SIDECAR_NOT_FOUND'/, '须对侧车缺失给出明确错误');
  assert.match(sidecar, /titleFingerprint/, '抓取须传标题指纹校验');
});

test('主题：主进程持久化设置、拒绝非法值并向所有窗口广播', () => {
  const sent = [];
  const electron = {
    app: { getPath: () => temp },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false,
      webContents: { send: (_ch, theme) => sent.push(theme) } }] },
    ipcMain: { handle() {}, on() {} },
    nativeTheme: {},
  };
  const handlers = {};
  electron.ipcMain.handle = (ch, fn) => { handlers[ch] = fn; };
  electron.ipcMain.on = (ch, fn) => { handlers[ch] = fn; };
  const ctx = { require: (n) => (n === 'electron' ? electron : require(n)),
    process, console: quiet, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, 'main/theme.js'), 'utf8'), ctx);
  const theme = ctx.module.exports;
  theme.initTheme();
  assert.equal(electron.nativeTheme.themeSource, 'system', '无持久化设置时默认为跟随系统');
  theme.registerThemeIpc();
  handlers['ffgui:theme-set']({}, 'neon');
  assert.equal(electron.nativeTheme.themeSource, 'system', '非法主题值须被拒绝');
  handlers['ffgui:theme-set']({}, 'dark');
  assert.equal(electron.nativeTheme.themeSource, 'dark');
  assert.deepEqual(sent, ['dark'], '切换后须向所有窗口广播');
  const cfg = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.equal(cfg.theme, 'dark', '主题设置须持久化到 config.json');
  assert.equal(handlers['ffgui:theme-get'](), 'dark');
  theme.initTheme();
  assert.equal(electron.nativeTheme.themeSource, 'dark', '重启后应恢复持久化的主题');
});

// 以下覆盖实际输出文件，而不仅检查参数字符串。
test('老设备预设：10-bit/60fps/6 声道输入转为 Main 3.1/8-bit/最高30fps/AAC双声道', () => {
  const input = path.join(temp, 'legacy-source.mkv');
  execute(['-n', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=60:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-profile:v', 'high10', '-c:a', 'flac', input]);
  for (const preset of ['ipod4-540', 'ipod4-720']) {
    const out = path.join(temp, `${preset}.mp4`);
    execute(api.buildArgs({ devicePreset: preset, vcodec: 'copy', pixFmt: 'yuv420p10le' }, input, out));
    const ss = probe(out).streams;
    const v = ss.find((s) => s.codec_type === 'video'), a = ss.find((s) => s.codec_type === 'audio');
    assert.equal(v.profile, 'Main'); assert.equal(v.level, 31); assert.equal(v.pix_fmt, 'yuv420p');
    assert.ok(v.width <= (preset === 'ipod4-540' ? 960 : 1280));
    assert.ok(v.height <= (preset === 'ipod4-540' ? 540 : 720));
    assert.ok(Math.abs(v.width / v.height - 4 / 3) < 0.01, '不得把 4:3 拉伸成 16:9');
    assert.equal(v.sample_aspect_ratio, '1:1');
    const [n, d] = v.avg_frame_rate.split('/').map(Number); assert.ok(n / d <= 30.001);
    assert.equal(a.codec_name, 'aac'); assert.equal(a.profile, 'LC'); assert.equal(a.channels, 2);
    assert.equal(a.sample_rate, '48000');
    const bytes = fs.readFileSync(out); assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'));
  }
});

test('老设备预设保留 23.976 fps；自定义可明确指定 8-bit、Profile 和固定帧率', () => {
  const input = path.join(temp, 'film.mkv');
  execute(['-n', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24000/1001:d=1',
    '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', input]);
  for (const [name, job, expected] of [
    ['film-preset', { devicePreset: 'ipod4-540' }, '24000/1001'],
    ['film-custom', { format: 'mp4', vcodec: 'libx264', acodec: 'aac', pixFmt: 'yuv420p',
      h264Profile: 'baseline', h264Level: '3.1', fps: '25', scale: { w: 320, h: 180 } }, '25/1'],
    ['film-custom-15fps', { format: 'mp4', vcodec: 'libx264', acodec: 'aac', pixFmt: 'yuv420p',
      fps: '15', scale: { w: 320, h: 180 } }, '15/1'],
  ]) {
    const out = path.join(temp, `${name}.mp4`); execute(api.buildArgs(job, input, out));
    const v = probe(out).streams.find((s) => s.codec_type === 'video');
    assert.equal(v.pix_fmt, 'yuv420p'); assert.equal(v.avg_frame_rate, expected);
  }
});

test('设备/平台预设：按表锁定 Profile/Level/分辨率/码率，覆盖表单旧值', () => {
  const cases = {
    'bili-1080p': { profile: 'high', level: '4.2', scale: '1920:1080', v: '6000', maxrate: '12000', bufsize: '24000', a: '320', ar: '48000', fpsmax: '60' },
    'bili-720p': { profile: 'high', level: '3.1', scale: '1280:720', v: '3000', maxrate: '6000', bufsize: '12000', a: '192', ar: '48000', fpsmax: '30' },
    'douyin-1080p': { profile: 'high', level: '4.2', scale: '1920:1080', v: '6000', maxrate: '12000', bufsize: '24000', a: '192', ar: '48000', fpsmax: '60' },
    'wechat-1080p': { profile: 'high', level: '4.0', scale: '1920:1080', v: '4000', maxrate: '8000', bufsize: '16000', a: '128', ar: '48000', fpsmax: '30' },
    'youtube-1080p': { profile: 'high', level: '4.2', scale: '1920:1080', v: '8000', maxrate: '12000', bufsize: '24000', a: '384', ar: '48000', fpsmax: '60' },
    'iphone4s': { profile: 'high', level: '4.0', scale: '1920:1080', v: '4000', maxrate: '8000', bufsize: '16000', a: '160', ar: '48000', fpsmax: '30' },
    'psp': { profile: 'main', level: '2.2', scale: '480:272', v: '1000', maxrate: '1500', bufsize: '3000', a: '128', ar: '48000', fpsmax: '30' },
    'android-legacy': { profile: 'baseline', level: '2.1', scale: '800:480', v: '1000', maxrate: '1500', bufsize: '3000', a: '128', ar: '44100', fpsmax: '30' },
    'web-safe': { profile: 'baseline', level: '3.0', scale: '1280:720', v: '2500', maxrate: '5000', bufsize: '10000', a: '128', ar: '44100', fpsmax: '30' },
    'tv-4k': { profile: 'high', level: '5.1', scale: '3840:2160', v: '20000', maxrate: '40000', bufsize: '60000', a: '192', ar: '48000', fpsmax: '30' },
  };
  for (const [preset, e] of Object.entries(cases)) {
    // 表单残留旧值（复制流 / 10-bit）必须被预设表完整覆盖
    const args = api.buildArgs({ devicePreset: preset, vcodec: 'copy', pixFmt: 'yuv420p10le' },
      dual, path.join(temp, `preset-${preset}.mp4`));
    const argStr = args.join(' ');
    assert.ok(argStr.includes(`-c:v libx264`) && argStr.includes(`-pix_fmt yuv420p`), `${preset} 编码器/位深`);
    assert.ok(argStr.includes(`-profile:v ${e.profile}`) && argStr.includes(`-level:v ${e.level}`), `${preset} Profile/Level`);
    assert.ok(argStr.includes(`scale=${e.scale}:`), `${preset} 分辨率`);
    assert.ok(argStr.includes(`-b:v ${e.v}k`) && argStr.includes(`-maxrate ${e.maxrate}k`)
      && argStr.includes(`-bufsize ${e.bufsize}k`), `${preset} 视频码率`);
    assert.ok(argStr.includes(`-b:a ${e.a}k`) && argStr.includes(`-ar ${e.ar}`), `${preset} 音频`);
    assert.ok(argStr.includes(`-fpsmax ${e.fpsmax}`), `${preset} 帧率上限`);
  }
  // 渲染层预设表与主进程预设表键一致，防止下拉选项与落实参数脱节
  const mainSrc = fs.readFileSync(path.join(repo, 'main/ffmpeg.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(repo, 'html/js/convert.js'), 'utf8');
  const keys = [...mainSrc.matchAll(/^  '([\w-]+)': \{ format: 'mp4'/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 12, '主进程预设表应含全部预设');
  for (const k of keys) assert.ok(uiSrc.includes(` '${k}':`), `渲染层缺预设 ${k}`);
});

test('PSP 预设真实转码：480×272 / Main 2.2 / AAC 48 kHz', () => {
  const out = path.join(temp, 'psp-real.mp4');
  execute(api.buildArgs({ devicePreset: 'psp' }, dual, out));
  const ss = probe(out).streams;
  const v = ss.find((s) => s.codec_type === 'video');
  assert.equal(v.profile, 'Main');
  assert.equal(v.level, 22, 'Level 2.2 的 level_idc 为 22');
  assert.ok(v.width <= 480 && v.height <= 272);
  const [n, d] = v.avg_frame_rate.split('/').map(Number);
  assert.ok(n / d <= 30.001, 'fpsmax 30 应封顶帧率');
  const a = ss.find((s) => s.codec_type === 'audio');
  assert.equal(a.codec_name, 'aac');
  assert.equal(a.sample_rate, '48000');
});

test('拦截复制流与转换参数的冲突、无效预设和不兼容 Profile/位深', () => {
  for (const opts of [
    { vcodec: 'copy', pixFmt: 'yuv420p' },
    { vcodec: 'copy', scale: { w: 960, h: 540 } },
    { vcodec: 'libx265', h264Profile: 'main' },
    { vcodec: 'libx264', h264Profile: 'main', pixFmt: 'yuv420p10le' },
    { vcodec: 'libx264', h264Level: 'invalid' },
    { vcodec: 'libx264', fps: 'abc' },
    { vcodec: 'libx264', fps: '0' },
    { vcodec: 'libx264', fps: '300' },
    { acodec: 'copy', channels: 2 },
    { acodec: 'aac', sampleRate: 'bad' },
    { devicePreset: 'unknown' },
  ]) assert.throws(() => api.buildArgs({ format: 'mp4', ...opts }, dual, 'unused.mp4'));
});

async function makeTaggedFlac() {
  const image = path.join(temp, 'cover.png'), file = path.join(temp, 'tagged.flac');
  if (fs.existsSync(file)) return { image, file, info: await api.probeFile(file) };
  execute(['-n', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', image]);
  execute(['-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', image,
    '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata', 'title=测试曲名', '-metadata', 'artist=初音ミク', '-metadata', 'album=测试专辑',
    '-metadata', 'album_artist=专辑艺术家', '-metadata', 'composer=作曲者テスト',
    '-metadata', 'track=2/12', '-metadata', 'disc=1/2', '-metadata', 'date=2026',
    '-metadata', 'genre=Electronic', '-metadata', 'comment=中文与日本語',
    '-metadata:s:v', 'comment=Cover (front)', file]);
  return { image, file, info: await api.probeFile(file) };
}
function lowerTags(file) {
  return Object.fromEntries(Object.entries(probe(file).format.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
}

test('FLAC 转 MP3/M4A/FLAC 保留真实 PNG 封面、作曲者及中日文常用标签', async () => {
  const { image, file, info } = await makeTaggedFlac();
  assert.equal(info.hasVideo, false); assert.equal(info.covers.length, 1);
  for (const format of ['mp3', 'm4a', 'flac']) {
    const out = path.join(temp, `tagged-converted.${format}`);
    execute(api.buildArgs({ format, vcodec: 'none', acodec: 'auto' }, file, out, info));
    const tags = lowerTags(out);
    for (const [key, value] of Object.entries({ title: '测试曲名', artist: '初音ミク', album: '测试专辑',
      album_artist: '专辑艺术家', composer: '作曲者テスト', track: '2/12', disc: '1/2', date: '2026', genre: 'Electronic' })) {
      assert.equal(tags[key], value, `${format}: ${key}`);
    }
    const cover = probe(out).streams.find((s) => s.disposition?.attached_pic);
    assert.ok(cover, `${format} 必须保留封面`); assert.equal(cover.codec_name, 'png');
    const extracted = path.join(temp, `extracted-${format}.png`);
    execute(['-n', '-i', out, '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', extracted]);
    assert.ok(fs.readFileSync(image).equals(fs.readFileSync(extracted)), 'PNG 封面应逐字节保留');
    if (format === 'mp3') assert.equal(fs.readFileSync(out)[3], 3, '默认写入 ID3v2.3');
  }
});

test('MP3 可选 ID3v2.4；关闭封面或标签分别生效；无封面音频正常转换', async () => {
  const { file, info } = await makeTaggedFlac();
  for (const [name, opts] of [
    ['id3v24', { id3Version: '4' }], ['no-cover', { preserveCover: false }],
    ['no-tags', { preserveMetadata: false }],
  ]) {
    const out = path.join(temp, `${name}.mp3`);
    execute(api.buildArgs({ format: 'mp3', vcodec: 'none', acodec: 'auto', ...opts }, file, out, info));
    assert.equal(probe(out).streams.some((s) => s.disposition?.attached_pic), name !== 'no-cover');
    assert.equal(lowerTags(out).composer, name === 'no-tags' ? undefined : '作曲者テスト');
    if (name === 'id3v24') assert.equal(fs.readFileSync(out)[3], 4);
  }
  const out = path.join(temp, 'plain-audio.mp3');
  execute(api.buildArgs({ format: 'mp3', vcodec: 'none' }, audio, out, audioProbe));
  assert.deepEqual(probe(out).streams.map((s) => s.codec_type), ['audio']);
});

test('真实任务使用封面探测结果；WAV 缺少封面实现时给出明确提示', async () => {
  const { file } = await makeTaggedFlac();
  for (const format of ['mp3', 'wav']) {
    const events = [];
    const result = await api.runJob({ isDestroyed: () => false, send: (_, e) => events.push(e) },
      { inputs: [file], outputDir: temp, format, vcodec: 'none' });
    assert.equal(result.done, 1, JSON.stringify(events));
    assert.equal(events.some((e) => e.type === 'file-warning'), format === 'wav');
    const out = events.find((e) => e.type === 'file-done').output;
    assert.equal(probe(out).streams.some((s) => s.disposition?.attached_pic), format === 'mp3');
  }
});

test('设备预设通过任务入口正确生成 MP4；无音轨视频也能输出', async () => {
  for (const input of [dual, silent]) {
    const events = [];
    const result = await api.runJob({ isDestroyed: () => false, send: (_, e) => events.push(e) },
      { inputs: [input], outputDir: temp, format: 'wav', devicePreset: 'ipod4-540' });
    assert.equal(result.done, 1, JSON.stringify(events));
    const out = events.find((e) => e.type === 'file-done').output;
    assert.equal(path.extname(out), '.mp4');
    assert.equal(audios(out).length, input === dual ? 1 : 0);
  }
});

test('30 秒试转确实限制输出时长，不覆盖或截短原文件', async () => {
  const input = path.join(temp, 'long.wav'), out = path.join(temp, 'sample.mp3');
  execute(['-n', '-f', 'lavfi', '-i', 'sine=duration=35', input]);
  const original = fs.readFileSync(input);
  execute(api.buildArgs({ format: 'mp3', vcodec: 'none', sampleOnly: true }, input, out));
  const duration = Number(probe(out).format.duration);
  assert.ok(duration >= 30 && duration < 30.2, `试转时长：${duration}`);
  assert.ok(original.equals(fs.readFileSync(input)));
});

test('多个封面保留类型，JPEG 原样复制，WebP 封面转换为兼容图片', async () => {
  const { image, file } = await makeTaggedFlac();
  const jpeg = path.join(temp, 'back.jpg'), webp = path.join(temp, 'webp.webp');
  execute(['-n', '-i', image, '-frames:v', '1', jpeg]);
  execute(['-n', '-i', image, '-frames:v', '1', webp]);
  const input = path.join(temp, 'multi-cover.mp3');
  execute(['-n', '-i', file, '-i', jpeg, '-i', webp, '-map', '0:a', '-map', '0:v', '-map', '1:v', '-map', '2:v',
    '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata:s:v:1', 'comment=Cover (back)', '-metadata:s:v:2', 'comment=Other', input]);
  const info = await api.probeFile(input), out = path.join(temp, 'multi-cover-output.mp3');
  assert.equal(info.covers.length, 3);
  execute(api.buildArgs({ format: 'mp3', vcodec: 'none' }, input, out, info));
  const covers = probe(out).streams.filter((s) => s.disposition?.attached_pic);
  assert.deepEqual(covers.map((s) => s.codec_name), ['png', 'mjpeg', 'mjpeg']);
  assert.equal(covers[1].tags.comment, 'Cover (back)');
});

// 以下覆盖实际输出文件，而不仅检查参数字符串。
test('可视化裁剪：归一化矩形校验，非法值一律拒绝、合法边界可接受', async () => {
  const base = { format: 'mp4', vcodec: 'libx264', acodec: 'aac' };
  const reject = (crop) => assert.throws(() => api.buildArgs({ ...base, crop }, dual, 'unused.mp4'),
    /裁剪区域/, `应拒绝 ${JSON.stringify(crop)}`);
  // 缺字段：w/h 缺失、只有宽高没有起点
  for (const crop of [
    { x: 0, y: 0, w: 0.5 },
    { x: 0, y: 0, h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5 },
    { x: 0.25, y: 0.25, h: 0.5 },
    { w: 0.5, h: 0.5 },
    {},
  ]) reject(crop);
  // 字符串、NaN、Infinity、null 字段、数组、标量
  for (const crop of [
    { x: '0.25', y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.25, y: '0.25', w: 0.5, h: 0.5 },
    { x: 0.25, y: 0.25, w: '0.5', h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5, h: '0.5' },
    { x: NaN, y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.25, y: Infinity, w: 0.5, h: 0.5 },
    { x: 0.25, y: -Infinity, w: 0.5, h: 0.5 },
    { x: 0.25, y: 0.25, w: NaN, h: 0.5 },
    { x: 0.25, y: 0.25, w: Infinity, h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5, h: null },
    { x: 0.25, y: 0.25, w: 0.5, h: undefined },
    [0.25, 0.25, 0.5, 0.5],
    'x=0.25',
    0.25,
    true,
  ]) reject(crop);
  // 负数起点
  for (const crop of [
    { x: -0.1, y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.25, y: -0.1, w: 0.5, h: 0.5 },
    { x: -1e-9, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: -1e-9, w: 0.5, h: 0.5 },
  ]) reject(crop);
  // 零/负宽高
  for (const crop of [
    { x: 0.25, y: 0.25, w: 0, h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5, h: 0 },
    { x: 0.25, y: 0.25, w: -0.2, h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5, h: -0.2 },
  ]) reject(crop);
  // 超出 1
  for (const crop of [
    { x: 0.75, y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.25, y: 0.75, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.6, h: 0.4 },
    { x: 1.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0, w: 1.5, h: 1 },
    { x: 0, y: 0, w: 1, h: 1.0001 },
  ]) reject(crop);
  // 合法边界可接受：整幅画面、常见比例、浮点求和误差在容差内、极小区域
  for (const crop of [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.1, y: 0.2, w: 0.3, h: 0.8 },
    { x: 0.999999, y: 0, w: 1e-6, h: 1 },
    { x: 0.1 + 0.2, y: 0, w: 0.7 - (0.1 + 0.2), h: 0.5 },
    { x: 0, y: 0, w: 0.3, h: 1 },
  ]) {
    const args = api.buildArgs({ ...base, crop }, dual, 'unused.mp4');
    assert.match(args[args.indexOf('-vf') + 1], /^crop=/, `合法 crop 应进入滤镜链：${JSON.stringify(crop)}`);
  }
  // 无 crop 时不产生滤镜链，也不报错
  for (const crop of [null, undefined]) {
    const args = api.buildArgs({ ...base, crop }, dual, 'unused.mp4');
    assert.equal(args.indexOf('-vf'), -1);
  }
  // 表达式只含数字与 crop/trunc/max/min/in_w 等标识符，绝不夹带未校验字符串；
  // 滤镜选项值内的逗号必须转义为 "\,"，否则会被当成滤镜分隔符
  const vf = api.buildArgs({ ...base, crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }, dual, 'unused.mp4')
    .slice(api.buildArgs({ ...base, crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }, dual, 'unused.mp4').indexOf('-vf') + 1)[0];
  assert.equal(vf, 'crop=w=max(2\\,trunc(in_w*0.3/2)*2):h=max(2\\,trunc(in_h*0.4/2)*2)'
    + ':x=max(0\\,min(trunc(in_w*0.1)\\,in_w-out_w)):y=max(0\\,min(trunc(in_h*0.2)\\,in_h-out_h))');
  // 极小选框也必须是合法表达式：w/h 用 max(2,...) 兜底，不会取偶成 0
  const tinyVf = api.buildArgs({ ...base, crop: { x: 0.999999, y: 0, w: 1e-6, h: 1 } }, dual, 'unused.mp4')
    .slice(api.buildArgs({ ...base, crop: { x: 0.999999, y: 0, w: 1e-6, h: 1 } }, dual, 'unused.mp4').indexOf('-vf') + 1)[0];
  assert.match(tinyVf, /w=max\(2\\,trunc\(in_w\*0\.000001\/2\)\*2\)/, `极小宽兜底：${tinyVf}`);
  assert.match(tinyVf, /x=max\(0\\,min\(trunc\(in_w\*0\.999999\)\\,in_w-out_w\)\)/, `x 钳制：${tinyVf}`);
});

test('裁剪实际执行：按比例换算成像素，区域与尺寸都正确', async () => {
  // 160x120 输入，右上四分之一叠一块纯红，便于验证 x/y 偏移确实生效
  const input = path.join(temp, 'crop-source.mkv');
  const red = path.join(temp, 'crop-red.png');
  execute(['-n', '-f', 'lavfi', '-i', 'color=c=red:s=80x60:r=10:d=0.5', '-frames:v', '1', red]);
  execute(['-n', '-i', dual, '-i', red, '-filter_complex', '[0:v][1:v]overlay=x=80:y=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', input]);
  assert.deepEqual(dims(input), [160, 120]);
  const isRed = (px) => px[0] > 200 && px[1] < 30 && px[2] < 30;
  const originRed = pixelAt(input, 100, 10);
  assert.ok(isRed(originRed), `原片右上角应为红色，实际 ${JSON.stringify(originRed)}`);
  const originBlack = pixelAt(input, 10, 10);
  assert.ok(!isRed(originBlack), '原片左上角应保持原画面');
  const base = { format: 'mkv', vcodec: 'libx264', acodec: 'aac' };
  // 取右上 50%/50%：160x120 -> 80x60，且左上角像素落在红色叠加区
  const out = path.join(temp, 'crop-half.mkv');
  execute(api.buildArgs({ ...base, crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }, input, out));
  assert.deepEqual(dims(out), [80, 60], 'crop 50%/50% 应为 80x60');
  assert.ok(isRed(pixelAt(out, 20, 20)), '右上角裁剪结果应落在红色叠加区');
  // 取左下 50%/50%：尺寸同为 80x60，但左上角像素应回到原画面（非红色叠加区）
  const out2 = path.join(temp, 'crop-quarter.mkv');
  execute(api.buildArgs({ ...base, crop: { x: 0, y: 0.5, w: 0.5, h: 0.5 } }, input, out2));
  assert.deepEqual(dims(out2), [80, 60]);
  assert.ok(!isRed(pixelAt(out2, 20, 20)), '左下角裁剪结果不应落在红色叠加区');
  // 非整数比例：33%/67% -> trunc(160*0.33/2)*2=52, trunc(120*0.67/2)*2=80
  const out3 = path.join(temp, 'crop-odd.mkv');
  execute(api.buildArgs({ ...base, crop: { x: 0.5, y: 0, w: 0.33, h: 0.67 } }, input, out3));
  assert.deepEqual(dims(out3), [52, 80], '宽高应按比例换算后向下取偶数');
  // 任务入口同样生效（runJob 经 normalizeConvertJob 后 crop 仍被保留）
  const events = [];
  const result = await api.runJob({ isDestroyed: () => false, send: (_, e) => events.push(e) },
    { inputs: [input], outputDir: temp, format: 'mkv', vcodec: 'libx264', acodec: 'aac',
      crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  assert.equal(result.done, 1, JSON.stringify(events));
  assert.deepEqual(dims(events.find((e) => e.type === 'file-done').output), [80, 60]);
  // 设备预设下 crop 同样保留（normalizeConvertJob spread 不能丢掉 crop）
  const presetEvents = [];
  const presetResult = await api.runJob({ isDestroyed: () => false, send: (_, e) => presetEvents.push(e) },
    { inputs: [input], outputDir: temp, format: 'mp4', devicePreset: 'ipod4-540',
      crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  assert.equal(presetResult.done, 1, JSON.stringify(presetEvents));
  const presetOut = presetEvents.find((e) => e.type === 'file-done').output;
  // 裁到右半边整幅高度得到 80x120（2:3），等比放进 960x540 后为 360x540；
  // 若 crop 被 normalizeConvertJob 丢掉，4:3 的 160x120 会得到 720x540
  assert.deepEqual(dims(presetOut), [360, 540], 'crop 必须在设备预设下依然生效');
});

test('裁剪与缩放同用：crop 必须位于 scale 之前，输出尺寸以缩放为准', () => {
  const input = path.join(temp, 'crop-scale.mkv');
  execute(['-n', '-i', dual, '-vf', 'pad=320:240:0:0', '-c:v', 'libx264', '-g', '1', input]);
  assert.deepEqual(dims(input), [320, 240]);
  const base = { format: 'mkv', vcodec: 'libx264', acodec: 'aac', crop: { x: 0, y: 0, w: 0.25, h: 0.25 } };
  // 指定尺寸：裁剪到 80x60 后强制缩放到 200x200
  const out = path.join(temp, 'crop-scale-out.mkv');
  const args = api.buildArgs({ ...base, scale: { w: 200, h: 200 } }, input, out);
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.indexOf('crop=') < vf.indexOf('scale='), `crop 必须位于 scale 之前：${vf}`);
  execute(args);
  assert.deepEqual(dims(out), [200, 200]);
  // 百分比缩放：先裁到 80x60 再缩 50% 得到 40x30。
  // 若 crop 被放到 scale 之后，比例会按 320x240 计算成 160x120 再缩半得 80x60，
  // 因此该断言能真正区分两种顺序
  const out2 = path.join(temp, 'crop-scale-percent.mkv');
  const args2 = api.buildArgs({ ...base, scale: { percent: 50 } }, input, out2);
  const vf2 = args2[args2.indexOf('-vf') + 1];
  assert.ok(vf2.indexOf('crop=') < vf2.indexOf('scale='), `crop 必须位于 scale 之前：${vf2}`);
  execute(args2);
  assert.deepEqual(dims(out2), [40, 30], '先裁剪到 80x60 再缩 50% 应为 40x30');
});

test('极小合法选框：宽高兜底为 2 且边缘不越界，普通选框结果不变', async () => {
  // 100x100 输入 + 1% 选框：trunc(100*0.01/2)*2 会取偶成 0，旧实现直接报
  // "Invalid too big or non positive size"，这里必须实际执行成功并得到 2 像素
  const input = path.join(temp, 'crop-tiny-src.mkv');
  execute(['-n', '-f', 'lavfi', '-i', 'color=c=red:s=100x100:r=10:d=0.5', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', input]);
  assert.deepEqual(dims(input), [100, 100]);
  const base = { format: 'mkv', vcodec: 'libx264', acodec: 'aac' };
  // 先证明旧表达式确实会失败（否则兜底就没有意义）
  const broken = execute(['-n', '-i', input, '-vf',
    'crop=w=trunc(in_w*0.01/2)*2:h=trunc(in_h*0.01/2)*2:x=0:y=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(temp, 'crop-tiny-broken.mkv')], false);
  assert.notEqual(broken.status, 0, '取偶成 0 的表达式必须失败');
  assert.match(broken.stderr, /non positive size/);
  // 1% 极小框：宽高兜底为 2，位置在原点
  const out = path.join(temp, 'crop-tiny-1pct.mkv');
  execute(api.buildArgs({ ...base, crop: { x: 0, y: 0, w: 0.01, h: 0.01 } }, input, out));
  assert.deepEqual(dims(out), [2, 2], '极小选框宽高必须兜底为 2');
  nearPixel(out, 0, 0, [255, 0, 0]);
  // 右下边缘极小框：x=0.999999 -> trunc(100*0.999999)=99，w 兜底为 2，
  // x 被钳制到 in_w-out_w = 98，最终 2x2 且不越界
  const out2 = path.join(temp, 'crop-tiny-edge.mkv');
  execute(api.buildArgs({ ...base, crop: { x: 0.999999, y: 0.999999, w: 1e-6, h: 1e-6 } }, input, out2));
  assert.deepEqual(dims(out2), [2, 2], '右下边缘极小框必须兜底为 2');
  nearPixel(out2, 1, 1, [255, 0, 0]);
  // 160x120 上右/下边缘极小框：w/h 兜底为 2，高度保持 120
  for (const [name, crop, expected] of [
    ['crop-tiny-right', { x: 0.999999, y: 0, w: 1e-6, h: 1 }, [2, 120]],
    ['crop-tiny-bottom', { x: 0, y: 0.999999, w: 1, h: 1e-6 }, [160, 2]],
    ['crop-tiny-both', { x: 0.999999, y: 0.999999, w: 1e-6, h: 1e-6 }, [2, 2]],
  ]) {
    const o = path.join(temp, `${name}.mkv`);
    execute(api.buildArgs({ ...base, crop }, dual, o));
    assert.deepEqual(dims(o), expected, `${name} 应为 ${expected.join('x')}`);
    assert.ok(pixelAt(o, expected[0] - 1, expected[1] - 1).length === 3, '右下角像素必须存在');
  }
  // 普通选框结果不变：50% -> 80x60、33%/67% -> 52x80
  for (const [crop, expected] of [
    [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, [80, 60]],
    [{ x: 0.5, y: 0, w: 0.33, h: 0.67 }, [52, 80]],
    [{ x: 0, y: 0, w: 1, h: 1 }, [160, 120]],
  ]) {
    const o = path.join(temp, `crop-tiny-normal-${expected.join('x')}.mkv`);
    execute(api.buildArgs({ ...base, crop }, dual, o));
    assert.deepEqual(dims(o), expected, `普通选框 ${JSON.stringify(crop)} 应仍为 ${expected.join('x')}`);
  }
});

test('裁剪与直接复制视频流同存必须报错，无 crop 时复制不受影响', () => {
  for (const crop of [
    { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    { x: 0, y: 0, w: 1, h: 1 },
  ]) {
    assert.throws(() => api.buildArgs({ format: 'mkv', vcodec: 'copy', acodec: 'copy', crop }, dual, 'unused.mp4'),
      /直接复制视频不能裁剪/);
  }
  const out = path.join(temp, 'copy-no-crop.mkv');
  execute(api.buildArgs({ format: 'mkv', vcodec: 'copy', acodec: 'copy' }, dual, out));
  assert.deepEqual(dims(out), [160, 120]);
  // 纯音频输出下 crop 被忽略，不报错也不影响音频转换
  const audioOut = path.join(temp, 'crop-audio-only.m4a');
  execute(api.buildArgs({ format: 'm4a', vcodec: 'none', acodec: 'aac',
    crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, dual, audioOut));
  assert.equal(audios(audioOut).length, 2);
  // 无视频流（vcodec none）时同样忽略 crop
  const noneOut = path.join(temp, 'crop-no-video.mp4');
  execute(api.buildArgs({ format: 'mp4', vcodec: 'none', acodec: 'aac',
    crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, dual, noneOut));
  assert.deepEqual(probe(noneOut).streams.map((s) => s.codec_type), ['audio', 'audio']);
  // 非法 crop 即使在纯音频分支也应拒绝（校验不依赖输出类型）
  assert.throws(() => api.buildArgs({ format: 'm4a', vcodec: 'none', acodec: 'aac',
    crop: { x: 0, y: 0, w: 0.5 } }, dual, 'unused.mp4'), /裁剪区域/);
});
