'use strict';

// 运行：node --test scripts/dub.test.cjs
// 字幕配音（dub）主进程测试：纯函数（字幕解析 / ffmpeg 参数 / 模型 URL / 任务
// 校验）直接 require；服务层用 vm 加载并替换 require('./ffmpeg')、child_process
// 的 spawn 与 electron，TTS 引擎用一个真实的本地 http 桩替代（不跑真模型、不下载
// 任何模型、不调用真实 ffmpeg）。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const repo = path.resolve(__dirname, '..');
const dub = require(path.join(repo, 'main', 'dub.js'));

const tempRoots = [];
const openServers = new Set();
after(() => {
  for (const server of openServers) {
    try {
      server.close();
    } catch {
      // 已关闭
    }
  }
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-dub-'));
  tempRoots.push(dir);
  return dir;
}

// ---------- 字幕样例 ----------

const SRT_SAMPLE = [
  '1',
  '00:00:01,000 --> 00:00:03,500 X1:100 X2:200 Y1:50 Y2:60',
  '<i>第一条</i>字幕',
  '第二行文本',
  '',
  '2',
  '00:00:05,250 --> 00:00:07,000',
  '第二条字幕',
  '',
  // 乱序：时间更早
  '3',
  '00:00:00,500 --> 00:00:01,000',
  '最早的一条',
  '',
  // 非法条目：结束早于开始，应被丢弃
  '4',
  '00:00:09,000 --> 00:00:08,000',
  '非法时间',
  '',
  // 空文本条目应被丢弃
  '5',
  '00:00:10,000 --> 00:00:11,000',
  '   ',
].join('\r\n');

test('字幕解析 srt：剥标签、多行拼空格、丢非法条目、按开始时间排序', () => {
  const cues = dub.parseSubtitleCues(SRT_SAMPLE, 'srt');
  assert.equal(cues.length, 3);
  // 排序后 index 从 1 重排
  assert.deepEqual(cues.map((cue) => cue.text), ['最早的一条', '第一条字幕 第二行文本', '第二条字幕']);
  assert.deepEqual(cues.map((cue) => cue.startMs), [500, 1000, 5250]);
  assert.deepEqual(cues.map((cue) => cue.endMs), [1000, 3500, 7000]);
  assert.deepEqual(cues.map((cue) => cue.index), [1, 2, 3]);
  // 扩展名大小写与带点写法都接受
  assert.equal(dub.parseSubtitleCues(SRT_SAMPLE, '.SRT').length, 3);
});

const VTT_SAMPLE = [
  'WEBVTT',
  'Kind: captions',
  'Language: zh',
  '',
  'NOTE 这是注释块',
  '不应被当成台词',
  '',
  'STYLE',
  '::cue { color: yellow }',
  '',
  'cue-1',
  '00:01.000 --> 00:03.000 align:start position:0%',
  '短格式时间戳',
  '',
  '00:00:05.500 --> 00:00:07.250',
  '带<v 说话人>标签</v>的第二条',
].join('\n');

test('字幕解析 vtt：跳过 WEBVTT 头与 NOTE/STYLE 块，兼容 MM:SS.mmm', () => {
  const cues = dub.parseSubtitleCues(VTT_SAMPLE, 'vtt');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3000);
  assert.equal(cues[0].text, '短格式时间戳');
  assert.equal(cues[1].startMs, 5500);
  assert.equal(cues[1].endMs, 7250);
  assert.equal(cues[1].text, '带标签的第二条');
});

// Events 的列顺序故意与默认不同，验证按 Format: 行取列而不是硬编码列号
const ASS_SAMPLE = [
  '[Script Info]',
  'Title: 测试',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,20',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,这是一条注释不是台词',
  'Dialogue: 0,0:00:01.50,0:00:04.00,Default,,0,0,0,,{\\pos(400,570)}你好，\\N世界',
  'Dialogue: 0,0:00:00.10,0:00:01.00,Default,,0,0,0,,最早的台词',
].join('\r\n');

test('字幕解析 ass：按 Format 行取列、剥覆盖块、\\N 转空格、跳过 Comment', () => {
  const cues = dub.parseSubtitleCues(ASS_SAMPLE, 'ass');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 100);
  assert.equal(cues[0].endMs, 1000);
  assert.equal(cues[0].text, '最早的台词');
  assert.equal(cues[1].startMs, 1500);
  assert.equal(cues[1].endMs, 4000);
  assert.equal(cues[1].text, '你好， 世界');
  // ssa 走同一套解析
  assert.equal(dub.parseSubtitleCues(ASS_SAMPLE, 'ssa').length, 2);
});

test('字幕解析 ass：列顺序打乱也能取到正确字段', () => {
  const source = [
    '[Events]',
    'Format: Start, End, Text, Layer',
    'Dialogue: 0:00:02.00,0:00:03.00,打乱的列顺序,0',
  ].join('\n');
  const cues = dub.parseSubtitleCues(source, 'ass');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 2000);
  assert.equal(cues[0].endMs, 3000);
  assert.equal(cues[0].text, '打乱的列顺序');
});

test('字幕解析：空内容得空数组，非法扩展名报错', () => {
  assert.deepEqual(dub.parseSubtitleCues('', 'srt'), []);
  assert.deepEqual(dub.parseSubtitleCues('\n\n\n', 'vtt'), []);
  assert.throws(() => dub.parseSubtitleCues('x', 'txt'), (err) => err.code === 'FFGUI_DUB_SUBTITLE_FORMAT');
  assert.throws(() => dub.parseSubtitleCues('x', ''), (err) => err.code === 'FFGUI_DUB_SUBTITLE_FORMAT');
});

test('字幕解析：单条截 500 字符，总数上限 1000', () => {
  const longText = 'a'.repeat(900);
  const one = dub.parseSubtitleCues(`1\n00:00:00,000 --> 00:00:02,000\n${longText}\n`, 'srt');
  assert.equal(one[0].text.length, dub.MAX_CUE_CHARS);

  const make = (count) => {
    const blocks = [];
    for (let i = 0; i < count; i += 1) {
      const start = String(Math.floor(i / 3600)).padStart(2, '0');
      const mm = String(Math.floor((i % 3600) / 60)).padStart(2, '0');
      const ss = String(i % 60).padStart(2, '0');
      const end = String((i % 60) + 1).padStart(2, '0');
      blocks.push(`${i + 1}\n${start}:${mm}:${ss},000 --> ${start}:${mm}:${end},000\ntext ${i}\n`);
    }
    return blocks.join('\n');
  };
  assert.equal(dub.parseSubtitleCues(make(1000), 'srt').length, 1000);
  assert.throws(
    () => dub.parseSubtitleCues(make(1001), 'srt'),
    (err) => err.code === 'FFGUI_DUB_TOO_MANY_CUES',
  );
});

// ---------- 组装 / 混流参数 ----------

function filterGraph(args) {
  const idx = args.indexOf('-filter_complex');
  assert.ok(idx >= 0, '必须带 -filter_complex');
  return args[idx + 1];
}

test('组配音轨：≤100 条时单次 amix，adelay 毫秒正确，含 -n 与进度', () => {
  const entries = [
    { path: '/tmp/cue_0001.wav', startMs: 0 },
    { path: '/tmp/cue_0002.wav', startMs: 1500 },
    { path: '/tmp/cue_0003.wav', startMs: 63000 },
  ];
  const args = dub.buildDubAssemblyArgs({ wavEntries: entries, durationMs: 70000, outPath: '/tmp/dub.wav' });
  const graph = filterGraph(args);
  assert.match(graph, /\[0:a\]adelay=0\|all\[cue0\]/);
  assert.match(graph, /\[1:a\]adelay=1500\|all\[cue1\]/);
  assert.match(graph, /\[2:a\]adelay=63000\|all\[cue2\]/);
  assert.match(graph, /\[cue0\]\[cue1\]\[cue2\]amix=inputs=3:normalize=0/);
  assert.ok(!graph.includes('concat='), '单组不应出现 concat');
  assert.match(graph, /atrim=start=0:end=70/);
  // 三个输入 + 输出在最后
  assert.deepEqual(args.filter((a) => a === '-i').length, 3);
  assert.equal(args[args.length - 1], '/tmp/dub.wav');
  assert.ok(args.includes('-n'));
  assert.ok(args.includes('-nostats'));
  const progressIdx = args.indexOf('-progress');
  assert.equal(args[progressIdx + 1], 'pipe:1');
  assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args[args.indexOf('-ac') + 1], '1');
});

test('组配音轨：>100 条时按 100 条分组 amix 并 concat', () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({
    path: `/tmp/cue_${String(i + 1).padStart(4, '0')}.wav`,
    startMs: i * 1000,
  }));
  const args = dub.buildDubAssemblyArgs({
    wavEntries: entries, durationMs: 160000, outPath: '/tmp/dub.wav',
  });
  const graph = filterGraph(args);
  assert.equal(args.filter((a) => a === '-i').length, 150);
  assert.equal((graph.match(/amix=inputs=100:normalize=0/g) || []).length, 1);
  assert.equal((graph.match(/amix=inputs=50:normalize=0/g) || []).length, 1);
  assert.match(graph, /concat=n=2:v=0:a=1/);
  // 第二组从第 100 条（100000ms）开始，第一组切片终点也是它
  assert.match(graph, /atrim=start=0:end=100,/);
  assert.match(graph, /atrim=start=100:end=160,/);
  assert.match(graph, /\[149:a\]adelay=149000\|all\[cue149\]/);
  assert.ok(args.includes('-n'));
});

test('组配音轨：空条目或非法时长直接报错', () => {
  assert.throws(() => dub.buildDubAssemblyArgs({ wavEntries: [], durationMs: 1000, outPath: 'x.wav' }),
    (err) => err.code === 'FFGUI_DUB_INVALID_JOB');
  assert.throws(() => dub.buildDubAssemblyArgs({
    wavEntries: [{ path: 'a.wav', startMs: 0 }], durationMs: 0, outPath: 'x.wav',
  }), (err) => err.code === 'FFGUI_DUB_INVALID_JOB');
});

test('混流：新音轨序号 = 源音频流数，MP4 字幕转 mov_text、MKV 原样复制', () => {
  const mp4 = dub.buildDubMuxArgs({
    video: '/v/a.mp4',
    audioWav: '/tmp/dub.wav',
    outPath: '/v/a_dub.mp4',
    sourceAudioCount: 2,
    language: 'chinese',
    title: '配音',
  });
  assert.deepEqual(mp4.slice(0, 13), [
    '-hide_banner', '-i', '/v/a.mp4', '-i', '/tmp/dub.wav',
    '-map', '0', '-map', '1:a:0', '-c', 'copy', '-c:a:2', 'aac',
  ]);
  assert.equal(mp4[mp4.indexOf('-b:a:2') + 1], '192k');
  assert.equal(mp4[mp4.indexOf('-ar') + 1], '48000');
  assert.equal(mp4[mp4.indexOf('-ac') + 1], '2');
  // MP4 的 mov muxer 只认 ISO 639-2 三字母码，两字母的 zh 会被静默丢弃（实测）
  assert.equal(mp4[mp4.indexOf('-metadata:s:a:2') + 1], 'language=zho');
  assert.equal(mp4[mp4.indexOf('-metadata:s:a:2', mp4.indexOf('-metadata:s:a:2') + 1) + 1], 'title=配音');
  assert.equal(mp4[mp4.indexOf('-c:s') + 1], 'mov_text');
  assert.ok(mp4.includes('-n'));
  assert.ok(mp4.includes('-nostats'));
  assert.equal(mp4[mp4.indexOf('-progress') + 1], 'pipe:1');
  assert.equal(mp4[mp4.length - 1], '/v/a_dub.mp4');

  const mkv = dub.buildDubMuxArgs({
    video: '/v/a.mkv', audioWav: '/tmp/dub.wav', outPath: '/v/a_dub.mkv', sourceAudioCount: 0,
    language: 'chinese',
  });
  assert.equal(mkv[mkv.indexOf('-c:a:0') + 1], 'aac');
  assert.equal(mkv[mkv.indexOf('-c:s') + 1], 'copy');
  // MKV 用 BCP 47 两字母码
  assert.equal(mkv[mkv.indexOf('-metadata:s:a:0') + 1], 'language=zh');
  // 不保留字幕时用 -sn 而不是转换
  const noSub = dub.buildDubMuxArgs({
    video: '/v/a.mp4', audioWav: '/tmp/dub.wav', outPath: '/v/a_dub.mp4', keepSubtitle: false,
  });
  assert.ok(noSub.includes('-sn'));
  assert.ok(!noSub.includes('-c:s'));
});

test('语言到 BCP 47 的映射', () => {
  assert.equal(dub.languageToBcp47('chinese'), 'zh');
  assert.equal(dub.languageToBcp47('Chinese'), 'zh');
  assert.equal(dub.languageToBcp47('english'), 'en');
  assert.equal(dub.languageToBcp47('japanese'), 'ja');
  assert.equal(dub.languageToBcp47('korean'), 'ko');
  assert.equal(dub.languageToBcp47('auto'), 'und');
  assert.equal(dub.languageToBcp47('klingon'), 'und');
  // MP4 系列切成 ISO 639-2 三字母码，其他容器保留 BCP 47
  assert.equal(dub.containerLanguageTag('chinese', 'mp4'), 'zho');
  assert.equal(dub.containerLanguageTag('chinese', 'mov'), 'zho');
  assert.equal(dub.containerLanguageTag('japanese', 'MKV'), 'ja');
  assert.equal(dub.containerLanguageTag('chinese', 'mkv'), 'zh');
  assert.equal(dub.containerLanguageTag('auto', 'mp4'), 'und');
  assert.equal(dub.containerLanguageTag('klingon', 'mp4'), 'und');
});

test('容器扩展名：same 沿用 mp4/mkv，其他源一律 mp4', () => {
  assert.equal(dub.resolveContainerExt('same', '/v/a.mp4'), 'mp4');
  assert.equal(dub.resolveContainerExt('same', '/v/a.MKV'), 'mkv');
  assert.equal(dub.resolveContainerExt('same', '/v/a.avi'), 'mp4');
  assert.equal(dub.resolveContainerExt('mp4', '/v/a.mkv'), 'mp4');
  assert.equal(dub.resolveContainerExt('mkv', '/v/a.mp4'), 'mkv');
});

test('输出路径：撞名加序号，并避开输入文件', () => {
  const dir = tempDir();
  const fsStub = { existsSync: (file) => fs.existsSync(file) };
  const first = path.join(dir, 'movie_dub.mp4');
  fs.writeFileSync(first, '');
  const reserved = new Set();
  reserved.add(path.resolve(path.join(dir, 'movie_dub_2.mp4')).toLowerCase());
  const out = dub.uniqueOutputPath(first, reserved, fsStub);
  assert.equal(path.basename(out), 'movie_dub_3.mp4');
});

// ---------- 模型与引擎路径 ----------

test('模型下载地址：official 与 mirror 只换主机', () => {
  const talker = dub.talkerFileName('Q4_K_M');
  assert.equal(talker, 'qwen-talker-1.7b-base-Q4_K_M.gguf');
  assert.equal(dub.tokenizerFileName('Q8_0'), 'qwen-tokenizer-12hz-Q8_0.gguf');
  assert.equal(
    dub.modelDownloadUrl(talker, 'official'),
    `https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main/${talker}`,
  );
  assert.equal(
    dub.modelDownloadUrl(talker, 'mirror'),
    `https://hf-mirror.com/Serveurperso/Qwen3-TTS-GGUF/resolve/main/${talker}`,
  );
  // 未识别的 mirror 值按 official 处理
  assert.ok(dub.modelDownloadUrl(talker, 'whatever').startsWith('https://huggingface.co/'));
});

test('aria2 进度：解析真实 readout 的尺寸对，缺尺寸时按百分比换算', () => {
  // 真实 aria2c 1.37 的输出（readout 走 stdout，按 \r 原地刷新）
  assert.deepEqual(
    dub.parseAria2Readout('[#1 SIZE:1.5MiB/114MiB(1%) CN:4 DL:1.4MiB ETA:1m20s]'),
    { receivedBytes: Math.round(1.5 * 1024 * 1024), totalBytes: 114 * 1024 * 1024 },
  );
  assert.deepEqual(
    dub.parseAria2Readout('[#2089b0 0B/1000KiB(0%) CN:1 DL:0B]'),
    { receivedBytes: 0, totalBytes: 1000 * 1024 },
  );
  // 只有百分比时用上次已知总大小换算
  assert.deepEqual(
    dub.parseAria2Readout('[#1 SIZE:(50%) CN:4]', 1000),
    { receivedBytes: 500, totalBytes: 1000 },
  );
  // 不知道总大小时退化为 0/0，调用方沿用上一次进度
  assert.deepEqual(dub.parseAria2Readout('[#1 SIZE:(50%)]'), { receivedBytes: 0, totalBytes: 0 });
  // 非进度行（日志 / 空行）不产出进度
  assert.equal(dub.parseAria2Readout('[NOTICE] Download complete: x.gguf'), null);
  assert.equal(dub.parseAria2Readout(''), null);
});

test('引擎路径：环境变量优先，Windows 开发/打包路径不同，Linux 回退 PATH', () => {
  const root = tempDir();
  const devApp = { isPackaged: false, getAppPath: () => root };
  fs.mkdirSync(path.join(root, 'bin', 'tts'), { recursive: true });
  const devBin = path.join(root, 'bin', 'tts', 'tts-server.exe');
  fs.writeFileSync(devBin, '');
  assert.equal(dub.getTtsServerPath({ env: {}, platform: 'win32', app: devApp }), devBin);
  assert.equal(
    dub.getTtsServerPath({ env: { FFGUI_TTS_SERVER: '/custom/tts-server' }, platform: 'win32', app: devApp }),
    '/custom/tts-server',
  );
  // 找不到时 Windows/macOS 返回 null（缺失），Linux 回退裸名
  assert.equal(dub.getTtsServerPath({ env: {}, platform: 'win32', app: { isPackaged: true, getAppPath: () => path.join(root, 'nope') } }), null);
  assert.equal(dub.getTtsServerPath({ env: {}, platform: 'linux', app: { getAppPath: () => path.join(root, 'nope') } }), 'tts-server');
});

test('内置 aria2c 路径：Windows/macOS 有，开发走 bin/aria2，打包看 extraResource 布局', () => {
  const root = tempDir();
  const devExe = path.join(root, 'bin', 'aria2', 'aria2c.exe');
  fs.mkdirSync(path.dirname(devExe), { recursive: true });
  fs.writeFileSync(devExe, '');
  const devApp = { isPackaged: false, getAppPath: () => root };
  assert.equal(dub.getBundledAria2Path({ app: devApp, platform: 'win32' }), devExe);

  // 打包态：extraResource 把 bin/aria2/ 映射成 resources/aria2/
  const resources = path.join(root, 'resources');
  const packedExe = path.join(resources, 'aria2', 'aria2c.exe');
  fs.mkdirSync(path.dirname(packedExe), { recursive: true });
  fs.writeFileSync(packedExe, '');
  const packedApp = { isPackaged: true, getAppPath: () => path.join(root, 'app.asar') };
  assert.equal(
    dub.getBundledAria2Path({ app: packedApp, platform: 'win32', resourcesPath: resources }),
    packedExe,
  );

  // macOS：开发态是可执行文件 aria2c（无扩展名）
  const darwinDevExe = path.join(root, 'bin', 'aria2', 'aria2c');
  fs.writeFileSync(darwinDevExe, '');
  assert.equal(dub.getBundledAria2Path({ app: devApp, platform: 'darwin' }), darwinDevExe);
  // macOS 打包态：extraResource 复制整个 bin/，所以落在 resources/bin/aria2/
  const darwinPacked = path.join(resources, 'bin', 'aria2', 'aria2c');
  fs.mkdirSync(path.dirname(darwinPacked), { recursive: true });
  fs.writeFileSync(darwinPacked, '');
  assert.equal(
    dub.getBundledAria2Path({ app: packedApp, platform: 'darwin', resourcesPath: resources }),
    darwinPacked,
  );
  // 显式 resources/aria2/ 布局也认（将来若给 macOS 加独立 extraResource）
  const darwinExplicit = path.join(resources, 'aria2', 'aria2c');
  fs.mkdirSync(path.dirname(darwinExplicit), { recursive: true });
  fs.writeFileSync(darwinExplicit, '');
  assert.equal(
    dub.getBundledAria2Path({ app: packedApp, platform: 'darwin', resourcesPath: resources }),
    darwinExplicit,
  );

  // Linux 不内置：交给 PATH 探测
  assert.equal(dub.getBundledAria2Path({ app: devApp, platform: 'linux' }), null);
  // Windows 不会命中 macOS 的 resources/bin/aria2/ 布局（可执行文件名不同）
  const darwinOnlyRoot = path.join(root, 'only-darwin-layout');
  fs.mkdirSync(path.join(darwinOnlyRoot, 'bin', 'aria2'), { recursive: true });
  fs.writeFileSync(path.join(darwinOnlyRoot, 'bin', 'aria2', 'aria2c'), '');
  assert.equal(dub.getBundledAria2Path({
    app: packedApp,
    platform: 'win32',
    resourcesPath: darwinOnlyRoot,
  }), null);
  // 文件不存在时不算命中
  assert.equal(dub.getBundledAria2Path({
    app: { isPackaged: false, getAppPath: () => path.join(root, 'nope') },
    platform: 'win32',
  }), null);
  // existsSync 可注入（假 fs 场景）
  assert.equal(dub.getBundledAria2Path({
    app: devApp,
    platform: 'win32',
    fs: { existsSync: () => false },
  }), null);
  assert.equal(dub.getBundledAria2Path({
    app: devApp,
    platform: 'win32',
    fs: { existsSync: () => true },
  }), devExe);
});

test('引擎环境变量：auto 不设 GGML_BACKEND，vulkan/cpu 分别映射', () => {
  assert.equal(dub.backendEnv('auto', {}).GGML_BACKEND, undefined);
  assert.equal(dub.backendEnv('vulkan', {}).GGML_BACKEND, 'Vulkan0');
  assert.equal(dub.backendEnv('cpu', {}).GGML_BACKEND, 'CPU');
  // 沿用父进程其余环境变量，但不污染原对象
  const base = { PATH: '/bin', GGML_BACKEND: 'CUDA0' };
  const out = dub.backendEnv('auto', base);
  assert.equal(out.PATH, '/bin');
  assert.equal(base.GGML_BACKEND, 'CUDA0');
});

test('语言清单：11 项（含 auto），dictKey 带 dub.lang. 前缀', () => {
  assert.equal(dub.LANGUAGES.length, 11);
  assert.deepEqual(dub.LANGUAGES[0], { id: 'auto', dictKey: 'dub.lang.auto' });
  assert.ok(dub.LANGUAGES.some((entry) => entry.id === 'chinese' && entry.dictKey === 'dub.lang.chinese'));
  for (const entry of dub.LANGUAGES) assert.equal(entry.dictKey, `dub.lang.${entry.id}`);
});

test('任务校验：白名单字段与错误码', () => {
  const ok = dub.validateDubJob({ id: 'job_1', video: '/v/a.mp4', subtitle: '/v/a.srt' });
  assert.deepEqual(ok, {
    id: 'job_1', video: '/v/a.mp4', subtitle: '/v/a.srt', language: 'auto', backend: 'auto', container: 'same', variant: '',
  });
  const full = dub.validateDubJob({
    id: 'job_2', video: '/v/a.mp4', subtitle: '/v/a.srt', language: 'Chinese', backend: 'cpu', container: 'mkv', variant: 'q4_k_m',
  });
  assert.equal(full.language, 'chinese');
  assert.equal(full.variant, 'Q4_K_M');
  const bad = (job, code) => assert.throws(() => dub.validateDubJob(job), (err) => err.code === code);
  bad({ video: '/v/a.mp4', subtitle: '/v/a.srt' }, 'FFGUI_DUB_INVALID_JOB');
  bad({ id: '../evil', video: '/v/a.mp4', subtitle: '/v/a.srt' }, 'FFGUI_DUB_INVALID_JOB');
  bad({ id: 'x', video: '/v/a.mp4', subtitle: '/v/a.srt', language: 'klingon' }, 'FFGUI_DUB_INVALID_JOB');
  bad({ id: 'x', video: '/v/a.mp4', subtitle: '/v/a.srt', backend: 'cuda' }, 'FFGUI_DUB_INVALID_JOB');
  bad({ id: 'x', video: '/v/a.mp4', subtitle: '/v/a.srt', container: 'avi' }, 'FFGUI_DUB_INVALID_JOB');
  bad({ id: 'x', video: '/v/a.mp4', subtitle: '/v/a.srt', variant: 'F16' }, 'FFGUI_DUB_INVALID_JOB');
  bad(null, 'FFGUI_DUB_INVALID_JOB');
});

// ---------- 服务层（vm 加载 + 假引擎 + mock spawn） ----------

// 最小合法 WAV：44 字节 RIFF 头 + 8 个采样（16bit 单声道 24kHz）
function wavBytes() {
  const data = Buffer.alloc(16);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ffmpeg -i 的 stderr 片段：时长 + 1 条音频流 + 1 条视频流（MP4 的真实形态，
// 流标识带 [0xN] track id）
const PROBE_STDERR = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':",
  '  Duration: 00:01:10.50, start: 0.000000, bitrate: 1000 kb/s',
  '    Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720',
  '    Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp',
].join('\n');

test('流计数：兼容 MP4 track id、MKV 语言标记与纯 WAV，忽略 attached pic 封面', () => {
  const mp4 = dub.countStreams([
    '    Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080',
    '    Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp',
    '    Stream #0:2[0x3](eng): Audio: ac3, 48000 Hz, 5.1',
    '    Stream #0:3[0x4](chi): Subtitle: mov_text',
  ].join('\n'));
  assert.deepEqual(mp4, { audioCount: 2, videoCount: 1, subtitleCount: 1 });

  const mkv = dub.countStreams([
    '  Stream #0:0(eng): Video: hevc (Main), yuv420p(tv), 3840x2160, 23.98 fps',
    '  Stream #0:1(jpn): Audio: flac, 48000 Hz, stereo, s16',
  ].join('\n'));
  assert.deepEqual(mkv, { audioCount: 1, videoCount: 1, subtitleCount: 0 });

  // 内嵌封面：mp3 的 attached pic 不应算作视频流
  const mp3 = dub.countStreams([
    '  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 192 kb/s',
    '  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr (attached pic)',
  ].join('\n'));
  assert.deepEqual(mp3, { audioCount: 1, videoCount: 0, subtitleCount: 0 });
});

function loadService(options = {}) {
  const root = tempDir();
  const userData = path.join(root, 'userData');
  const modelsDir = path.join(userData, 'tts-models');
  fs.mkdirSync(modelsDir, { recursive: true });
  // 假模型文件：存在即可（服务只检查存在与大小）
  const variant = options.variant === undefined ? 'Q8_0' : options.variant;
  if (variant) {
    fs.writeFileSync(path.join(modelsDir, dub.talkerFileName(variant)), 'gguf');
    fs.writeFileSync(path.join(modelsDir, dub.tokenizerFileName(variant)), 'gguf');
  }
  // 假引擎二进制
  const enginePath = path.join(root, 'tts-server-mock');
  if (options.enginePresent !== false) fs.writeFileSync(enginePath, '');

  const spawned = [];
  const events = [];
  const speechRequests = [];
  const writtenFiles = [];
  const servers = [];

  const sender = {
    isDestroyed: () => false,
    send: (channel, event) => {
      assert.equal(channel, dub.EVENT_CHANNEL);
      events.push(event);
    },
  };

  // 引擎桩：按 --port 在本机监听，模拟 tts-server 的 /health、/v1/models、
  // /v1/audio/speech
  function startFakeEngine(argv) {
    const portIdx = argv.indexOf('--port');
    const port = Number(argv[portIdx + 1]);
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'ffgui-dub', object: 'model' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          const index = speechRequests.length + 1;
          speechRequests.push({ body, headers: req.headers });
          if (typeof options.onSpeech === 'function') {
            options.onSpeech({
              index, body, res, wav: wavBytes(), request: req,
            });
            return;
          }
          res.writeHead(200, { 'Content-Type': 'audio/wav' });
          res.end(wavBytes());
        });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    servers.push(server);
    openServers.add(server);
    server.listen(port, '127.0.0.1');
    return server;
  }

  // aria2c 桩：真实 aria2 自己写 .partial，这里由用例按 -d/-o 自行落盘。
  // --version 是探测探针，回一段版本号并退出 0。
  function spawnAria2Mock(cmd, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.signals = [];
    child.kill = (signal) => {
      child.killed = true;
      child.signals.push(signal || 'SIGTERM');
      // aria2 收到 SIGTERM 会收尾退出（可能带信号名而非退出码）
      setImmediate(() => child.emit('close', null, signal || 'SIGTERM'));
    };
    const record = { cmd, args, child, killed: false };
    spawned.push(record);

    if (args.includes('--version')) {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('aria2 version 1.37.0\nCopyright (C) 2006, 2019 Tatsuhiro Tsujikawa\n'));
        child.emit('close', 0);
      });
      return child;
    }
    const dir = args[args.indexOf('-d') + 1];
    const name = args[args.indexOf('-o') + 1];
    const target = path.join(dir, name);
    setImmediate(() => {
      if (typeof options.onAria2 === 'function') {
        options.onAria2({ record, target, child });
        return;
      }
      fs.writeFileSync(target, 'aria2-body');
      child.emit('close', 0);
    });
    return child;
  }

  function spawnMock(cmd, args) {
    // aria2c 可能是注入的桩名、内置的 bin/aria2/aria2c.exe 或 PATH 上的裸名 aria2c
    if (/^aria2c(-mock)?(\.exe)?$/i.test(path.basename(String(cmd)))) {
      return spawnAria2Mock(cmd, args);
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    let server = null;
    child.kill = () => {
      child.killed = true;
      if (server) {
        try {
          server.close();
        } catch {
          // 已关闭
        }
        openServers.delete(server);
      }
      setImmediate(() => child.emit('exit', 0, 'SIGTERM'));
    };
    const record = { cmd, args, child, killed: false };
    spawned.push(record);

    if (cmd !== 'ffmpeg-mock') {
      // TTS 引擎：真的监听端口
      server = startFakeEngine(args);
      record.server = server;
      return child;
    }
    const isProbe = !args.includes('-progress');
    if (isProbe) {
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from(options.probeStderr || PROBE_STDERR));
        // 真实 ffmpeg 在缺输出文件时退出码为 1，stderr 里已含所需信息
        child.emit('close', 1);
      });
      return child;
    }
    // 组装 / 混流：写出输出文件并补进度
    setImmediate(() => {
      const output = args[args.length - 1];
      if (typeof options.onFfmpeg === 'function') {
        const result = options.onFfmpeg(record);
        if (result && result.skip) {
          child.emit('close', result.code === undefined ? 1 : result.code);
          return;
        }
      }
      try {
        fs.writeFileSync(output, 'ffmpeg-output');
      } catch (err) {
        child.stderr.emit('data', Buffer.from(String(err.message)));
        child.emit('close', 1);
        return;
      }
      child.stdout.emit('data', Buffer.from('out_time=00:00:30.000000\nprogress=continue\n'));
      child.stdout.emit('data', Buffer.from('progress=end\n'));
      child.emit('close', 0);
    });
    return child;
  }

  const ctx = {
    require: (name) => {
      if (name === 'electron') {
        return {
          app: {
            isPackaged: false,
            getAppPath: () => repo,
            getPath: () => userData,
            on: () => {},
          },
          ipcMain: { handle: () => {} },
          dialog: {},
          BrowserWindow: { fromWebContents: () => null },
        };
      }
      if (name === './i18n') return require(path.join(repo, 'main', 'i18n.js'));
      if (name === './ffmpeg') return { getFfmpegPath: () => 'ffmpeg-mock' };
      if (name === 'child_process') return { spawn: (cmd, args) => spawnMock(cmd, args) };
      return require(name);
    },
    process,
    console: { log() {}, error() {} },
    module: { exports: {} },
    __dirname: path.join(repo, 'main'),
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    AbortController,
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(repo, 'main', 'dub.js'), 'utf8')
    + '\nmodule.exports = { createDubService, parseSubtitleCues };',
    ctx,
  );

  // 记录写盘路径（cue WAV 落盘校验）
  const fsStub = {
    ...fs,
    writeFileSync: (file, data, enc) => {
      writtenFiles.push(file);
      return fs.writeFileSync(file, data, enc);
    },
  };

  const appRoot = options.appPath || repo;
  const serviceOptions = {
    fs: fsStub,
    env: {
      FFGUI_TTS_SERVER: options.enginePresent === false ? path.join(root, 'missing') : enginePath,
      ...(options.env || {}),
    },
    platform: options.platform || 'win32',
    spawn: (cmd, args) => spawnMock(cmd, args),
    http,
    https: options.https || require('https'),
    app: {
      isPackaged: Boolean(options.isPackaged),
      getAppPath: () => appRoot,
      getPath: () => userData,
    },
  };
  // 打包态的内置资源根（resources/），用于验证内置 aria2c 的打包路径
  if (options.resourcesPath) serviceOptions.resourcesPath = options.resourcesPath;
  // aria2c：默认注入 false（视为不可用），避免在装了 aria2c 的机器上真去探测 PATH
  // 而改变既有用例的行为；options.aria2Probe 时才走真实探测分支（配合 env 覆盖）
  if (options.aria2Probe !== true) {
    serviceOptions.aria2 = options.aria2 === undefined ? false : options.aria2;
  }
  const service = ctx.module.exports.createDubService(serviceOptions);

  return {
    root,
    userData,
    modelsDir,
    enginePath,
    service,
    sender,
    events,
    spawned,
    speechRequests,
    writtenFiles,
    servers,
    cleanup: () => service.dispose(),
    types: () => events.map((event) => (event.type === 'phase' ? `phase:${event.phase}` : event.type)),
  };
}

function writeSubtitleFile(dir, cues, ext = 'srt') {
  const lines = [];
  cues.forEach((cue, i) => {
    const fmt = (ms) => {
      const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
      const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
      const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      const msPart = String(ms % 1000).padStart(3, '0');
      return `${h}:${m}:${s},${msPart}`;
    };
    lines.push(String(i + 1), `${fmt(cue.startMs)} --> ${fmt(cue.endMs)}`, cue.text, '');
  });
  const file = path.join(dir, `sub.${ext}`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

test('配音任务：逐条合成 WAV -> 组装 -> 混流，事件顺序与输出正确', async () => {
  const h = loadService();
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [
    { startMs: 1000, endMs: 2000, text: '第一条' },
    { startMs: 3000, endMs: 4500, text: '第二条' },
    { startMs: 6000, endMs: 7000, text: '第三条' },
  ]);

  const result = await h.service.start(h.sender, {
    id: 'job-1',
    video,
    subtitle,
    language: 'chinese',
    backend: 'auto',
    container: 'mkv',
    variant: 'Q8_0',
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.cues, 3);
  assert.equal(result.output, path.join(dir, 'movie_dub.mkv'));
  assert.ok(fs.existsSync(result.output), '成品应落盘');

  // 合成：三条字幕各一次 POST，body 字段齐全
  assert.equal(h.speechRequests.length, 3);
  assert.deepEqual(h.speechRequests.map((req) => req.body.input), ['第一条', '第二条', '第三条']);
  for (const req of h.speechRequests) {
    assert.equal(req.body.language, 'chinese');
    assert.equal(req.body.response_format, 'wav');
    assert.equal(req.headers.accept, 'audio/wav');
  }
  // 三条 cue WAV 都写到了 dub-cache/<jobId>/cue_000N.wav
  const cueFiles = h.writtenFiles.filter((file) => file.endsWith('.wav'));
  assert.equal(cueFiles.length, 3);
  assert.ok(cueFiles.every((file) => file.includes(path.join('dub-cache', 'job-1'))));
  assert.ok(cueFiles[0].endsWith('cue_0001.wav'));

  // 事件：start(total) -> phase synthesize -> 逐条 cue-start/cue-done ->
  // phase assemble -> phase mux -> file-done -> done
  const types = h.types();
  assert.equal(h.events[0].type, 'start');
  assert.equal(h.events[0].total, 3);
  assert.deepEqual(types.filter((type) => type.startsWith('cue-')), [
    'cue-start', 'cue-done', 'cue-start', 'cue-done', 'cue-start', 'cue-done',
  ]);
  assert.equal(types.filter((type) => type === 'phase:synthesize').length, 1);
  assert.equal(types.indexOf('phase:synthesize') < types.indexOf('phase:assemble'), true);
  assert.equal(types.indexOf('phase:assemble') < types.indexOf('phase:mux'), true);
  assert.equal(types[types.length - 1], 'done');
  assert.equal(h.events[h.events.length - 1].output, result.output);
  const fileDone = h.events.find((event) => event.type === 'file-done');
  assert.equal(fileDone.output, result.output);
  const progress = h.events.filter((event) => event.type === 'progress');
  assert.ok(progress.some((event) => event.phase === 'synthesize' && event.percent === 100));
  assert.ok(progress.some((event) => event.phase === 'assemble'));
  assert.ok(progress.some((event) => event.phase === 'mux'));

  // ffmpeg 调用：先探测，再组装（3 个 -i），再混流（新音轨序号 = 源音频数 1）
  const ffmpegCalls = h.spawned.filter((record) => record.cmd === 'ffmpeg-mock');
  assert.equal(ffmpegCalls.length, 3);
  const assemble = ffmpegCalls[1].args;
  assert.equal(assemble.filter((arg) => arg === '-i').length, 3);
  const mux = ffmpegCalls[2].args;
  assert.equal(mux[mux.indexOf('-c:a:1') + 1], 'aac');
  assert.ok(mux.includes('language=zh'));
  assert.equal(mux[mux.indexOf('-c:s') + 1], 'copy');
  assert.equal(mux[mux.length - 1], result.output);

  // 缓存目录用完即清
  assert.equal(fs.existsSync(path.join(h.userData, 'dub-cache', 'job-1')), false);
  h.cleanup();
});

test('配音任务：取消时中断合成、清理缓存、不发完成事件', async () => {
  let started = null;
  const h = loadService({
    onSpeech: ({ index, res }) => {
      if (index === 1) {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wavBytes());
        return;
      }
      // 第二条起挂住，等取消把它打断
      started = { index, res };
    },
  });
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [
    { startMs: 0, endMs: 1000, text: 'A' },
    { startMs: 2000, endMs: 3000, text: 'B' },
    { startMs: 4000, endMs: 5000, text: 'C' },
  ]);

  const running = h.service.start(h.sender, { id: 'job-cancel', video, subtitle });
  // 等到第二条开始合成再取消
  const deadline = Date.now() + 10000;
  while (!started && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(started, '第二条应已开始请求');
  assert.equal(h.service.cancel('job-cancel'), true);
  // 不存在的 jobId 取消返回 false
  assert.equal(h.service.cancel('other-job'), false);

  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.output, null);
  assert.ok(h.speechRequests.length <= 2, '取消后不应继续请求后续字幕');
  assert.equal(h.speechRequests.length, 2);
  // 没有 file-done / file-error，只有 done(cancelled)
  assert.equal(h.events.some((event) => event.type === 'file-done'), false);
  assert.equal(h.events.some((event) => event.type === 'file-error'), false);
  const done = h.events[h.events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.cancelled, true);
  // 缓存清理，且没有留下输出文件
  assert.equal(fs.existsSync(path.join(h.userData, 'dub-cache', 'job-cancel')), false);
  assert.equal(fs.existsSync(path.join(dir, 'movie_dub.mp4')), false);
  h.cleanup();
});

test('配音任务：单任务锁，并发提交报 FFGUI_DUB_BUSY', async () => {
  const h = loadService({
    onSpeech: ({ res }) => {
      // 挂住第一条，让任务保持运行
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'audio/wav' });
          res.end(wavBytes());
        }
      }, 500);
    },
  });
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [{ startMs: 0, endMs: 1000, text: 'A' }]);

  const first = h.service.start(h.sender, { id: 'job-a', video, subtitle });
  const deadline = Date.now() + 10000;
  while (h.speechRequests.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await assert.rejects(
    () => h.service.start(h.sender, { id: 'job-b', video, subtitle }),
    (err) => err.code === 'FFGUI_DUB_BUSY',
  );
  h.service.cancel('job-a');
  await first;
  h.cleanup();
});

test('配音任务：引擎缺失时报 FFGUI_DUB_NO_ENGINE，模型缺失时报 FFGUI_DUB_NO_MODEL', async () => {
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [{ startMs: 0, endMs: 1000, text: 'A' }]);

  const noEngine = loadService({ enginePresent: false });
  const res1 = await noEngine.service.start(noEngine.sender, { id: 'job-x', video, subtitle });
  assert.equal(res1.error.code, 'FFGUI_DUB_NO_ENGINE');
  assert.equal(noEngine.events.some((event) => event.type === 'file-error'), true);
  noEngine.cleanup();

  const noModel = loadService({ variant: null });
  const res2 = await noModel.service.start(noModel.sender, { id: 'job-y', video, subtitle });
  assert.equal(res2.error.code, 'FFGUI_DUB_NO_MODEL');
  noModel.cleanup();
});

test('配音任务：视频无法探测时长时报错，不启动引擎', async () => {
  const h = loadService({ probeStderr: 'Input #0, mov, from \'a.mp4\':\n  Stream #0:0: Video: h264\n' });
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [{ startMs: 0, endMs: 1000, text: 'A' }]);
  await assert.rejects(
    () => h.service.start(h.sender, { id: 'job-z', video, subtitle }),
    (err) => err.code === 'FFGUI_DUB_VIDEO',
  );
  assert.equal(h.spawned.filter((record) => record.cmd !== 'ffmpeg-mock').length, 0);
  h.cleanup();
});

test('状态：引擎缺失 / 无模型 / 正常三种 state', async () => {
  const missing = loadService({ enginePresent: false });
  const missStatus = await missing.service.status();
  assert.equal(missStatus.state, 'missing-engine');
  assert.equal(missStatus.engine.present, false);
  assert.equal(missStatus.downloading, null);
  assert.equal(missStatus.languages.length, 11);
  missing.cleanup();

  const noModel = loadService({ variant: null });
  const noModelStatus = await noModel.service.status();
  assert.equal(noModelStatus.state, 'no-model');
  assert.equal(noModelStatus.models.variant, undefined);
  assert.equal(noModelStatus.models.talker.present, false);
  noModel.cleanup();

  const ok = loadService({ variant: 'Q4_K_M' });
  const okStatus = await ok.service.status();
  assert.equal(okStatus.state, 'ok');
  assert.equal(okStatus.engine.present, true);
  assert.equal(okStatus.engine.running, false);
  assert.equal(okStatus.models.variant, 'Q4_K_M');
  assert.equal(okStatus.models.talker.present, true);
  assert.ok(okStatus.models.talker.bytes > 0);
  assert.equal(okStatus.models.tokenizer.present, true);
  ok.cleanup();
});

test('解析字幕文件：返回 cues 与整体时长', async () => {
  const h = loadService();
  const dir = tempDir();
  const subtitle = writeSubtitleFile(dir, [
    { startMs: 0, endMs: 1500, text: 'A' },
    { startMs: 2000, endMs: 4200, text: 'B' },
  ]);
  const parsed = await h.service.parseSubtitleFile(subtitle);
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.durationMs, 4200);
  // 不支持的扩展名直接抛错
  const bad = path.join(dir, 'sub.txt');
  fs.writeFileSync(bad, 'x');
  await assert.rejects(() => h.service.parseSubtitleFile(bad),
    (err) => err.code === 'FFGUI_DUB_SUBTITLE_FORMAT');
  h.cleanup();
});

test('引擎常驻：后端变化时重启，dispose 后回收', async () => {
  const h = loadService();
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [{ startMs: 0, endMs: 1000, text: 'A' }]);

  await h.service.start(h.sender, { id: 'job-backend-1', video, subtitle, backend: 'cpu' });
  const engineCalls = h.spawned.filter((record) => record.cmd !== 'ffmpeg-mock');
  assert.equal(engineCalls.length, 1);
  assert.equal(engineCalls[0].args[engineCalls[0].args.indexOf('--host') + 1], '127.0.0.1');
  assert.ok(Number(engineCalls[0].args[engineCalls[0].args.indexOf('--port') + 1]) > 0);
  assert.ok(engineCalls[0].args.includes('--alias'));
  assert.equal(engineCalls[0].args[engineCalls[0].args.indexOf('--alias') + 1], 'ffgui-dub');
  // 模型路径与 tokenizer 都传了
  const modelArg = engineCalls[0].args[engineCalls[0].args.indexOf('--model') + 1];
  const codecArg = engineCalls[0].args[engineCalls[0].args.indexOf('--codec') + 1];
  assert.ok(modelArg.endsWith('qwen-talker-1.7b-base-Q8_0.gguf'));
  assert.ok(codecArg.endsWith('qwen-tokenizer-12hz-Q8_0.gguf'));

  const status = await h.service.status();
  assert.equal(status.engine.running, true);
  assert.equal(status.engine.backend, 'cpu');
  assert.equal(status.engine.version, 'ffgui-dub');

  // 同一后端复用常驻进程
  await h.service.start(h.sender, { id: 'job-backend-2', video, subtitle, backend: 'cpu' });
  assert.equal(h.spawned.filter((record) => record.cmd !== 'ffmpeg-mock').length, 1);

  // 换后端 -> 杀掉旧进程重新拉起
  await h.service.start(h.sender, { id: 'job-backend-3', video, subtitle, backend: 'vulkan' });
  const engineCalls2 = h.spawned.filter((record) => record.cmd !== 'ffmpeg-mock');
  assert.equal(engineCalls2.length, 2);
  assert.equal(engineCalls2[0].killed, false);
  assert.equal(engineCalls2[0].child.killed, true);

  h.service.dispose();
  const afterDispose = await h.service.status();
  assert.equal(afterDispose.engine.running, false);
});

// ---------- 模型下载（注入假 https，不真下载） ----------

// 假 https.get：handler 收到 (url, options, cb)，自行决定返回什么响应流
function fakeHttps(handler) {
  return {
    get: (url, opts, cb) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => handler(url, opts, cb));
      return req;
    },
  };
}

function fakeResponse({ statusCode = 200, headers = {}, chunks = [] }) {
  const stream = Readable.from(chunks);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test('模型下载：跟随 302、按 content-length 报进度、.partial 改名', async () => {
  const urls = [];
  const body = Buffer.from('0123456789abcdef');
  const httpsStub = fakeHttps((url, opts, cb) => {
    urls.push({ url, accept: opts.headers.Accept });
    if (url.includes('resolve/main/') && !url.includes('cdn.example.com')) {
      // 主站先 302 到 CDN（HF 的真实行为）
      cb(fakeResponse({ statusCode: 302, headers: { location: 'https://cdn.example.com/file?sig=1' } }));
      return;
    }
    cb(fakeResponse({ statusCode: 200, headers: { 'content-length': String(body.length) }, chunks: [body] }));
  });
  const h = loadService({ variant: null, https: httpsStub });

  const result = await h.service.download(h.sender, 'Q8_0', 'mirror');
  assert.equal(result.cancelled, false);
  assert.equal(result.variant, 'Q8_0');
  // result.files 来自 vm 沙箱，展开成当前 realm 的数组再比较
  assert.deepEqual([...result.files], [dub.talkerFileName('Q8_0'), dub.tokenizerFileName('Q8_0')]);

  // 主站地址用 mirror 主机，302 后跟到 CDN
  assert.equal(urls.length, 4);
  assert.ok(urls[0].url.startsWith(`https://hf-mirror.com/Serveurperso/Qwen3-TTS-GGUF/resolve/main/${result.files[0]}`));
  assert.ok(urls[1].url.startsWith('https://cdn.example.com/'));
  assert.ok(urls[2].url.endsWith(dub.tokenizerFileName('Q8_0')));
  assert.equal(urls[0].accept, 'application/octet-stream');

  // 两个模型都落到 tts-models/，且没有 .partial 残留
  for (const file of result.files) {
    const target = path.join(h.modelsDir, file);
    assert.ok(fs.existsSync(target), `${file} 应已下载`);
    assert.equal(fs.readFileSync(target).toString(), body.toString());
    assert.equal(fs.existsSync(`${target}${'.ffgui-partial'}`), false);
  }
  // 事件：每个文件 start -> progress -> done
  assert.deepEqual(h.events.map((event) => event.type), [
    'download-start', 'download-progress', 'download-done',
    'download-start', 'download-progress', 'download-done',
  ]);
  const progress = h.events.find((event) => event.type === 'download-progress');
  assert.equal(progress.file, result.files[0]);
  assert.equal(progress.receivedBytes, body.length);
  assert.equal(progress.totalBytes, body.length);

  // 下载完状态从 no-model 变成 ok
  const status = await h.service.status();
  assert.equal(status.state, 'ok');
  assert.equal(status.models.variant, 'Q8_0');
  assert.equal(status.downloading, null);
  h.cleanup();
});

test('模型下载：取消后中断、删掉半成品、不留模型文件', async () => {
  // 返回一个只吐一块数据、永不结束的响应流
  const httpsStub = fakeHttps((url, opts, cb) => {
    const stream = new Readable({ read() {} });
    stream.statusCode = 200;
    stream.headers = { 'content-length': '1000000' };
    stream.push(Buffer.alloc(1024));
    cb(stream);
  });
  const h = loadService({ variant: null, https: httpsStub });

  const running = h.service.download(h.sender, 'Q4_K_M', 'official');
  const deadline = Date.now() + 10000;
  while (!h.events.some((event) => event.type === 'download-progress') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(h.events.some((event) => event.type === 'download-progress'), '应已开始下载');
  assert.equal(h.events.find((event) => event.type === 'download-progress').totalBytes, 1000000);
  // 无下载时 cancelDownload 返回 false
  assert.equal(h.service.cancelDownload(), true);

  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual([...result.files], []);
  assert.equal(fs.existsSync(path.join(h.modelsDir, dub.talkerFileName('Q4_K_M'))), false);
  assert.equal(fs.existsSync(
    path.join(h.modelsDir, `${dub.talkerFileName('Q4_K_M')}.ffgui-partial`),
  ), false, '取消后半成品必须删除');
  // 没有 download-done，状态里 downloading 归零
  assert.equal(h.events.some((event) => event.type === 'download-done'), false);
  const status = await h.service.status();
  assert.equal(status.downloading, null);
  assert.equal(status.state, 'no-model');
  assert.equal(h.service.cancelDownload(), false);
  h.cleanup();
});

test('模型下载：HTTP 错误码抛错并清理半成品', async () => {
  const httpsStub = fakeHttps((url, opts, cb) => {
    cb(fakeResponse({ statusCode: 503, headers: {} }));
  });
  const h = loadService({ variant: null, https: httpsStub });
  await assert.rejects(
    () => h.service.download(h.sender, 'Q8_0', 'official'),
    (err) => err.code === 'FFGUI_DUB_DOWNLOAD',
  );
  assert.equal(h.events.some((event) => event.type === 'download-error'), true);
  assert.equal(fs.readdirSync(h.modelsDir).length, 0, '不应留下任何文件');
  h.cleanup();
});

test('模型下载：下载中不允许并发下载或开始配音任务', async () => {
  const httpsStub = fakeHttps((url, opts, cb) => {
    const stream = new Readable({ read() {} });
    stream.statusCode = 200;
    stream.headers = { 'content-length': '1000000' };
    stream.push(Buffer.alloc(1024));
    cb(stream);
  });
  const h = loadService({ variant: null, https: httpsStub });
  const running = h.service.download(h.sender, 'Q8_0', 'official');
  const deadline = Date.now() + 10000;
  while (!h.events.some((event) => event.type === 'download-progress') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await assert.rejects(
    () => h.service.download(h.sender, 'Q4_K_M', 'official'),
    (err) => err.code === 'FFGUI_DUB_BUSY',
  );
  const dir = tempDir();
  const video = path.join(dir, 'movie.mp4');
  fs.writeFileSync(video, 'video');
  const subtitle = writeSubtitleFile(dir, [{ startMs: 0, endMs: 1000, text: 'A' }]);
  await assert.rejects(
    () => h.service.start(h.sender, { id: 'job-while-download', video, subtitle }),
    (err) => err.code === 'FFGUI_DUB_BUSY',
  );
  h.service.cancelDownload();
  const result = await running;
  assert.equal(result.cancelled, true);
  h.cleanup();
});

// ---------- 模型下载（注入假 aria2c，不真下载） ----------

test('模型下载：aria2c 可用时走 aria2（-c 续传参数、readout 进度、成功后改名）', async () => {
  const calls = [];
  let httpsCalls = 0;
  const httpsStub = fakeHttps(() => {
    httpsCalls += 1;
  });
  const h = loadService({
    variant: null,
    aria2: { path: 'aria2c-mock' },
    https: httpsStub,
    onAria2: ({ record, target, child }) => {
      calls.push(record);
      // 真实 aria2 会自己落盘 .partial
      fs.writeFileSync(target, 'aria2-body');
      child.stdout.emit('data', Buffer.from('[#1 SIZE:4MiB/8MiB(50%) CN:4 DL:5MiB ETA:2s]\r'));
      child.stdout.emit('data', Buffer.from('[#1 SIZE:8MiB/8MiB(100%) CN:4 DL:5MiB]\r\n'));
      child.emit('close', 0);
    },
  });

  const result = await h.service.download(h.sender, 'Q8_0', 'official');
  assert.equal(result.cancelled, false);
  assert.deepEqual([...result.files], [dub.talkerFileName('Q8_0'), dub.tokenizerFileName('Q8_0')]);
  // 一次下载内不切换实现：aria2 可用时完全不碰 https
  assert.equal(httpsCalls, 0, 'aria2 可用时不应回退 https');

  // 两个文件各一次 aria2c，参数按断点续传配置
  assert.equal(calls.length, 2);
  const talkerArgs = calls[0].args;
  assert.equal(calls[0].cmd, 'aria2c-mock');
  assert.equal(talkerArgs[0], '-c', '必须开断点续传');
  assert.equal(talkerArgs[talkerArgs.indexOf('-d') + 1], h.modelsDir);
  assert.equal(
    talkerArgs[talkerArgs.indexOf('-o') + 1],
    `${dub.talkerFileName('Q8_0')}${'.ffgui-partial'}`,
    '先写 .partial',
  );
  // 多连接切片：16 连接 + 16 切片 + 最小切片 1M（aria2 的切片下限）
  assert.equal(talkerArgs[talkerArgs.indexOf('-x') + 1], '16', '每服务器最大连接数');
  assert.equal(talkerArgs[talkerArgs.indexOf('-s') + 1], '16', '切片数');
  assert.equal(talkerArgs[talkerArgs.indexOf('-k') + 1], '1M', '最小切片大小');
  for (const flag of [
    '--file-allocation=none',
    '--max-tries=0',
    '--auto-file-renaming=false',
    '--check-certificate=true',
    '--show-console-readout=true',
    // 控制文件落盘间隔必须很小，否则取消时来不及保存进度
    '--auto-save-interval=1',
    // 注意是 console-log-level：真实 aria2 不认 console-read-level
    '--console-log-level=notice',
  ]) {
    assert.ok(talkerArgs.includes(flag), `缺少参数 ${flag}`);
  }
  assert.equal(talkerArgs[talkerArgs.indexOf('-U') + 1], 'FFGui/1.0 (https://github.com/kisaragychihaya/ffgui)');
  assert.ok(talkerArgs[talkerArgs.length - 1].startsWith(
    'https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main/',
  ), 'URL 放最后');

  // 模型落到最终文件名，没有 .partial 残留
  for (const file of result.files) {
    const target = path.join(h.modelsDir, file);
    assert.equal(fs.readFileSync(target).toString(), 'aria2-body');
    assert.equal(fs.existsSync(`${target}.ffgui-partial`), false);
  }
  // 进度来自 readout 的尺寸对
  const progress = h.events.filter((event) => event.type === 'download-progress');
  assert.equal(progress[0].receivedBytes, 4 * 1024 * 1024);
  assert.equal(progress[0].totalBytes, 8 * 1024 * 1024);
  assert.equal(progress[1].receivedBytes, 8 * 1024 * 1024);
  assert.deepEqual(h.events.map((event) => event.type), [
    'download-start', 'download-progress', 'download-progress', 'download-done',
    'download-start', 'download-progress', 'download-progress', 'download-done',
  ]);
  assert.equal(h.events.find((event) => event.type === 'download-done').bytes, 'aria2-body'.length);
  const status = await h.service.status();
  assert.equal(status.state, 'ok');
  h.cleanup();
});

test('模型下载：aria2 中途取消保留 .partial 与控制文件（下次 -c 续传）', async () => {
  const partialName = `${dub.talkerFileName('Q8_0')}${'.ffgui-partial'}`;
  let aria2 = null;
  const h = loadService({
    variant: null,
    aria2: 'aria2c-mock',
    onAria2: ({ record, target, child }) => {
      aria2 = { record, target, child };
      fs.writeFileSync(target, 'half-way');
      fs.writeFileSync(`${target}.aria2`, 'control');
      child.stdout.emit('data', Buffer.from('[#1 SIZE:1MiB/8MiB(12%) CN:4 DL:5MiB]\r'));
      // 之后不再输出，等用例取消
    },
  });

  const running = h.service.download(h.sender, 'Q8_0', 'official');
  const deadline = Date.now() + 10000;
  while (!h.events.some((event) => event.type === 'download-progress') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(aria2, '应已启动 aria2c');
  assert.equal(h.service.cancelDownload(), true);

  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual([...result.files], []);
  // 先 SIGTERM 让 aria2 收尾落盘控制文件
  assert.deepEqual(aria2.child.signals, ['SIGTERM']);
  const partial = path.join(h.modelsDir, partialName);
  assert.equal(fs.existsSync(partial), true, 'aria2 路径取消后半成品必须保留');
  assert.equal(fs.existsSync(`${partial}.aria2`), true, '控制文件保留才能续传');
  assert.equal(fs.existsSync(path.join(h.modelsDir, dub.talkerFileName('Q8_0'))), false);
  assert.equal(h.events.some((event) => event.type === 'download-done'), false);
  const status = await h.service.status();
  assert.equal(status.downloading, null);
  assert.equal(status.state, 'no-model');
  h.cleanup();
});

test('模型下载：aria2 非零退出码报错、保留半成品、错误可读', async () => {
  const h = loadService({
    variant: null,
    aria2: 'aria2c-mock',
    onAria2: ({ target, child }) => {
      fs.writeFileSync(target, 'half-way');
      fs.writeFileSync(`${target}.aria2`, 'control');
      child.stderr.emit('data', Buffer.from('Exception caught\nDownload aborted. URI=https://huggingface.co/x\n'));
      child.emit('close', 1);
    },
  });

  await assert.rejects(
    () => h.service.download(h.sender, 'Q4_K_M', 'official'),
    (err) => err.code === 'FFGUI_DUB_DOWNLOAD' && /exit=1/.test(err.message),
  );
  const errorEvent = h.events.find((event) => event.type === 'download-error');
  assert.ok(errorEvent, '应发出 download-error');
  assert.match(errorEvent.error, /exit=1/);
  assert.match(errorEvent.error, /Download aborted/, '错误里带 aria2 的最后一行输出');
  assert.equal(errorEvent.file, dub.talkerFileName('Q4_K_M'));
  assert.equal(errorEvent.code, 'FFGUI_DUB_DOWNLOAD');

  const partial = path.join(h.modelsDir, `${dub.talkerFileName('Q4_K_M')}.ffgui-partial`);
  assert.equal(fs.existsSync(partial), true, 'aria2 失败也要保留半成品');
  assert.equal(fs.existsSync(`${partial}.aria2`), true);
  assert.equal(fs.existsSync(path.join(h.modelsDir, dub.talkerFileName('Q4_K_M'))), false);
  h.cleanup();
});

test('模型下载：未注入时按环境变量 FFGUI_ARIA2 探测一次并缓存结果', async () => {
  const httpsStub = fakeHttps(() => {});
  const h = loadService({
    variant: null,
    aria2Probe: true,
    env: { FFGUI_ARIA2: 'aria2c-mock' },
    https: httpsStub,
  });

  await h.service.download(h.sender, 'Q8_0', 'official');
  const probes = () => h.spawned.filter((record) => record.cmd === 'aria2c-mock'
    && record.args.includes('--version'));
  assert.equal(probes().length, 1, '应通过 aria2c --version 探测');

  // 第二次下载复用缓存，不再探测
  await h.service.download(h.sender, 'Q4_K_M', 'official');
  assert.equal(probes().length, 1, '探测结果应缓存');
  assert.equal(fs.existsSync(path.join(h.modelsDir, dub.talkerFileName('Q4_K_M'))), true);
  h.cleanup();
});

test('模型下载：空的控制文件在下次 aria2 下载前被清掉，按 .partial 长度续传', async () => {
  // 下载不到 1 秒就被取消会留下 0 字节的 .aria2；带它重试 aria2 直接 exit 1 且无输出
  const states = [];
  const h = loadService({
    variant: null,
    aria2: 'aria2c-mock',
    onAria2: ({ target, child }) => {
      states.push(fs.existsSync(`${target}.aria2`));
      fs.writeFileSync(target, 'aria2-body');
      child.emit('close', 0);
    },
  });
  const partial = path.join(h.modelsDir, `${dub.talkerFileName('Q8_0')}${'.ffgui-partial'}`);
  fs.writeFileSync(partial, 'half-way');
  fs.writeFileSync(`${partial}.aria2`, '');

  const result = await h.service.download(h.sender, 'Q8_0', 'official');
  assert.equal(result.cancelled, false);
  assert.deepEqual(states, [false, false], '空控制文件必须在 spawn 之前删掉');
  assert.equal(fs.readFileSync(path.join(h.modelsDir, dub.talkerFileName('Q8_0'))).toString(), 'aria2-body');
  assert.equal(fs.existsSync(`${partial}.aria2`), false);
  h.cleanup();
});

// ---------- 模型下载：内置 aria2c（随包分发） ----------

test('模型下载：Windows 开发态命中内置 bin/aria2/aria2c.exe，不再探测 PATH', async () => {
  // 内置二进制就放在 appRoot/bin/aria2/ 下（开发态 app.getAppPath() 指向项目根）
  const appPath = tempDir();
  const bundled = path.join(appPath, 'bin', 'aria2', 'aria2c.exe');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, '');
  const h = loadService({ variant: null, aria2Probe: true, appPath });

  const result = await h.service.download(h.sender, 'Q8_0', 'official');
  assert.equal(result.cancelled, false);
  const aria2Calls = h.spawned.filter((record) => /aria2c/i.test(String(record.cmd)));
  assert.equal(aria2Calls.length, 2, '两个文件各一次 aria2c');
  for (const call of aria2Calls) {
    assert.equal(call.cmd, bundled, '应直接使用内置二进制');
    assert.equal(call.args.includes('--version'), false, '内置二进制命中即信任，不跑探针');
  }
  assert.equal(fs.existsSync(path.join(h.modelsDir, dub.talkerFileName('Q8_0'))), true);
  h.cleanup();
});

test('模型下载：打包态命中 resources/aria2/aria2c.exe', async () => {
  const resourcesPath = path.join(tempDir(), 'resources');
  const h = loadService({
    variant: null,
    aria2Probe: true,
    isPackaged: true,
    appPath: path.join(resourcesPath, 'app.asar'),
    resourcesPath,
  });
  const packedExe = path.join(resourcesPath, 'aria2', 'aria2c.exe');
  fs.mkdirSync(path.dirname(packedExe), { recursive: true });
  fs.writeFileSync(packedExe, '');

  const result = await h.service.download(h.sender, 'Q8_0', 'official');
  assert.equal(result.cancelled, false);
  const aria2Calls = h.spawned.filter((record) => /aria2c/i.test(String(record.cmd)));
  assert.equal(aria2Calls.length, 2);
  for (const call of aria2Calls) {
    assert.equal(call.cmd, packedExe);
    assert.equal(call.args.includes('--version'), false);
  }
  h.cleanup();
});

test('模型下载：内置缺失时回退 PATH 探测 aria2c', async () => {
  const h = loadService({ variant: null, aria2Probe: true, appPath: tempDir() });
  const result = await h.service.download(h.sender, 'Q8_0', 'official');
  assert.equal(result.cancelled, false);
  const probes = h.spawned.filter((record) => record.cmd === 'aria2c' && record.args.includes('--version'));
  assert.equal(probes.length, 1, '没有内置二进制时应探测 PATH');
  const downloads = h.spawned.filter((record) => record.cmd === 'aria2c' && record.args.includes('-c'));
  assert.equal(downloads.length, 2, '探测通过后用 PATH 上的 aria2c 下载');
  h.cleanup();
});

test('模型下载：macOS 打包态命中 resources/bin/aria2/aria2c（整目录复制布局）', async () => {
  const resourcesPath = path.join(tempDir(), 'resources');
  const h = loadService({
    variant: null,
    aria2Probe: true,
    platform: 'darwin',
    isPackaged: true,
    appPath: path.join(resourcesPath, 'app.asar'),
    resourcesPath,
  });
  const packedExe = path.join(resourcesPath, 'bin', 'aria2', 'aria2c');
  fs.mkdirSync(path.dirname(packedExe), { recursive: true });
  fs.writeFileSync(packedExe, '');

  const result = await h.service.download(h.sender, 'Q8_0', 'official');
  assert.equal(result.cancelled, false);
  const aria2Calls = h.spawned.filter((record) => /aria2c/i.test(String(record.cmd)));
  assert.equal(aria2Calls.length, 2, '两个文件各一次 aria2c');
  for (const call of aria2Calls) {
    assert.equal(call.cmd, packedExe, 'macOS 应使用 resources/bin/aria2/aria2c');
    assert.equal(call.args.includes('--version'), false, '内置二进制不跑探针');
  }
  h.cleanup();
});
