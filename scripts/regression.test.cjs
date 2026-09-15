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
      : n === 'child_process' ? childProcess : require(n),
    process, console: quiet, module: { exports: {} },
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nmodule.exports = {buildArgs, buildClipArgs, buildMergeArgs, buildOutputPath, '
    + 'pathKey, probeFile, validateAudioSelection, runFfmpegTask, runJob};', ctx);
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
  ]) {
    const out = path.join(temp, `${name}.mp4`); execute(api.buildArgs(job, input, out));
    const v = probe(out).streams.find((s) => s.codec_type === 'video');
    assert.equal(v.pix_fmt, 'yuv420p'); assert.equal(v.avg_frame_rate, expected);
  }
});

test('拦截复制流与转换参数的冲突、无效预设和不兼容 Profile/位深', () => {
  for (const opts of [
    { vcodec: 'copy', pixFmt: 'yuv420p' },
    { vcodec: 'copy', scale: { w: 960, h: 540 } },
    { vcodec: 'libx265', h264Profile: 'main' },
    { vcodec: 'libx264', h264Profile: 'main', pixFmt: 'yuv420p10le' },
    { vcodec: 'libx264', h264Level: 'invalid' },
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
