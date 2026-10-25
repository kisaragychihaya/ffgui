'use strict';

// 运行：node --test scripts/disc-ui.test.cjs
// 光盘页（html/disc.html + html/js/disc.dvd.js / disc.cd.js / disc.type.js）的纯逻辑测试：
// 选轨语义、job 构造、格式切换、MP4 图像字幕约束、默认最长标题、任务防重入、
// 语言/时长/字节格式化、类型切换面板显隐，以及合并页本身的安全约定
// （CSP、无 innerHTML、脚本顺序、控件齐备、三个脚本的 API 白名单）。
// 音乐 CD 侧的纯逻辑（曲目归一、任务与元数据构造）见 scripts/cd-ui.test.cjs。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const discHtml = fs.readFileSync(path.join(repo, 'html/disc.html'), 'utf8');
const discCss = fs.readFileSync(path.join(repo, 'html/css/disc.css'), 'utf8');
const cdCss = fs.readFileSync(path.join(repo, 'html/css/cd.css'), 'utf8');
// 视频光盘侧（原 disc.js）与音乐 CD 侧（原 cd.js）各是一个独立 IIFE，
// 类型切换控制器 disc.type.js 只负责按类型显隐两组外壳面板
const discSrc = fs.readFileSync(path.join(repo, 'html/js/disc.dvd.js'), 'utf8');
const cdSrc = fs.readFileSync(path.join(repo, 'html/js/disc.cd.js'), 'utf8');
const typeSrc = fs.readFileSync(path.join(repo, 'html/js/disc.type.js'), 'utf8');
const PAGE_SCRIPTS = [
  ['html/js/disc.dvd.js', discSrc],
  ['html/js/disc.cd.js', cdSrc],
  ['html/js/disc.type.js', typeSrc],
];

// 标记行自带中文说明（「（node:test 按标记整段提取…）」），必须整行丢弃，
// 只按前缀切会把行尾残片留在被提取的代码里，导致 vm 报 SyntaxError。
const START = '// ---------- 纯逻辑开始';
const END = '// ---------- 纯逻辑结束';

// 按标记行整段提取纯逻辑并与测试在同一 realm 内求值（仅用函数包一层，避免污染本文件
// 的顶层作用域）：跨 realm 求值得到的数组/对象原型不同，assert.deepEqual（strict）会
// 误判为不等。视频侧与类型控制器两段纯逻辑共用这一提取器。
function extractLogic(src, filename, names) {
  const lines = src.split(/\r?\n/);
  const startLine = lines.findIndex((line) => line.trim().startsWith(START));
  const endLine = lines.findIndex((line) => line.trim().startsWith(END));
  assert.ok(startLine >= 0, `${filename}：找不到纯逻辑开始标记所在行`);
  assert.ok(endLine > startLine, `${filename}：找不到纯逻辑结束标记所在行`);
  const logic = lines.slice(startLine + 1, endLine).join('\n');
  assert.match(logic.trimStart(), /^(?:const|function|let)\b/,
    `${filename}：纯逻辑段必须以代码开始，不得残留注释尾巴`);
  // 纯逻辑段被要求在无 DOM 的环境里求值，不得偷偷摸 document
  assert.ok(!/\bdocument\s*\./.test(logic), `${filename}：纯逻辑段不得引用 DOM`);
  return vm.runInThisContext(
    `(function () {\n${logic}\n  return { ${names.join(', ')} };\n})()`,
    { filename: `${filename}#logic` },
  );
}

// 纯逻辑段里的 t() 从 window.i18n 取词：这里注入真实 zh-CN 词典，
// 使断言仍校验用户看到的中文原文（词典改动会在此暴露）。
const zhDict = JSON.parse(fs.readFileSync(path.join(repo, 'locales/zh-CN.json'), 'utf8'));
function dictLookup(dict, key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}
global.window = {
  i18n: {
    t(key, vars) {
      let text = dictLookup(zhDict, key);
      if (text === undefined) return key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) text = text.split(`{{${name}}}`).join(String(value));
      }
      return text;
    },
  },
};

const LOGIC_EXPORTS = [
  'normalizeTrackIds', 'formatsForMode', 'audioOptionsFor', 'defaultSelectedTitleIds',
  'hasImageSubtitles', 'buildTitleEntry', 'buildJob', 'validateJob',
  'formatDuration', 'formatBytes', 'formatSpeed', 'formatEta', 'streamLabel', 'passLabel',
  'MODES', 'MODE_FORMATS', 'AUDIO_OPTIONS', 'IMAGE_SUBTITLE_CODECS',
];
const logicApi = extractLogic(discSrc, 'html/js/disc.dvd.js', LOGIC_EXPORTS);
const {
  normalizeTrackIds, formatsForMode, audioOptionsFor, defaultSelectedTitleIds,
  hasImageSubtitles, buildTitleEntry, buildJob, validateJob,
  formatDuration, formatBytes, formatSpeed, formatEta, streamLabel, passLabel,
  MODES, MODE_FORMATS, AUDIO_OPTIONS, IMAGE_SUBTITLE_CODECS,
} = logicApi;

// ---------- 测试数据 ----------
function title(id, over = {}) {
  return {
    id,
    durationMs: 1000,
    sizeBytes: 0,
    chapters: 1,
    video: { id: '0', codec: 'h264' },
    audio: [{ id: '1', codec: 'ac3', language: 'eng', label: 'English' }],
    subtitles: [],
    fingerprint: `fp-${id}`,
    ...over,
  };
}

// 带 PGS 图像字幕的标题（蓝光常见），MP4 容器无法承载
const pgsTitle = title('3', {
  subtitles: [
    { id: '5', codec: 'pgssub', language: 'chi' },
    { id: '6', codec: 'subrip', language: 'eng' },
  ],
});
// 只有文字字幕的标题：MP4 同样不保留任何字幕，只选 subrip 也必须被拒
const textSubTitle = title('4', {
  subtitles: [{ id: '7', codec: 'subrip', language: 'eng' }],
});
const titles = [
  title('1', { durationMs: 5 * 60000, sizeBytes: 1024 * 1024 * 700, chapters: 4 }),
  title('2', { durationMs: 110 * 60000, sizeBytes: 1024 * 1024 * 4200, chapters: 16 }),
  pgsTitle,
];

function states(selectedIds, audio = null, subs = null) {
  return titles.map((t) => ({
    title: t,
    selected: selectedIds.includes(t.id),
    audio,
    subs,
  }));
}

// ---------- 选轨语义 ----------
test('选轨语义：null=全部、[]=不保留、非空=指定轨', () => {
  assert.equal(normalizeTrackIds(null), null, 'null 表示保留全部轨');
  assert.equal(normalizeTrackIds(undefined), null, '缺省等同 null');
  assert.deepEqual(normalizeTrackIds([]), [], '空数组表示一条都不保留');
  assert.deepEqual(normalizeTrackIds(['1', '2']), ['1', '2'], '非空数组为指定轨');
  assert.deepEqual(normalizeTrackIds(['2', '2', '1']), ['2', '1'], '重复项去重且保持顺序');
  // 非字符串、空串、非数组一律拒绝（渲染层不得塞进非法值）
  for (const bad of [1, '1', 0, true, {}, { 0: '1' }, ['1', ''], ['1', 2], ['1', null], [null]]) {
    assert.throws(() => normalizeTrackIds(bad), /选轨/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('buildTitleEntry 只透传数据，不含任何命令片段', () => {
  const st = { title: titles[0], selected: true, audio: ['1'], subs: [] };
  assert.deepEqual(buildTitleEntry(st), {
    titleId: '1',
    titleFingerprint: 'fp-1',
    audioTrackIds: ['1'],
    subtitleTrackIds: [],
  });
  const all = { title: titles[0], selected: true, audio: null, subs: null };
  assert.equal(buildTitleEntry(all).audioTrackIds, null);
  assert.equal(buildTitleEntry(all).subtitleTrackIds, null);
});

// ---------- 格式与模式组合 ----------
test('格式切换：copy 仅 MKV，transcode 可选 MKV / MP4', () => {
  assert.deepEqual(formatsForMode('copy'), ['mkv']);
  assert.deepEqual(formatsForMode('transcode'), ['mkv', 'mp4']);
  assert.equal(formatsForMode('bogus'), null, '未知方式应返回 null');
  // 每种模式都能在自身候选里找到合法格式，组合规则自洽
  for (const mode of ['copy', 'transcode']) {
    for (const format of formatsForMode(mode)) {
      const audio = audioOptionsFor(mode, format);
      assert.ok(Array.isArray(audio) && audio.length > 0, `${mode}/${format} 必须有音频候选`);
      assert.ok(audio.some((o) => o.value === 'copy' || o.value === 'aac'));
    }
  }
  assert.deepEqual(audioOptionsFor('copy', 'mkv').map((o) => o.value), ['copy'], '无损模式只能复制音频');
  assert.deepEqual(audioOptionsFor('transcode', 'mkv').map((o) => o.value), ['copy', 'aac']);
  assert.deepEqual(audioOptionsFor('transcode', 'mp4').map((o) => o.value), ['aac'],
    'MP4 必须重编码音频');
});

// ---------- 默认最长标题 ----------
test('默认只勾选时长最长的标题', () => {
  assert.deepEqual(defaultSelectedTitleIds(titles), ['2']);
  // 并列时取第一个
  const tie = [title('a', { durationMs: 100 }), title('b', { durationMs: 100 })];
  assert.deepEqual(defaultSelectedTitleIds(tie), ['a']);
  // 单个标题时选它；空列表不选
  assert.deepEqual(defaultSelectedTitleIds([title('only', { durationMs: 1 })]), ['only']);
  assert.deepEqual(defaultSelectedTitleIds([]), []);
  // 时长缺失/非法的条目被忽略，不会变成默认选择
  assert.deepEqual(defaultSelectedTitleIds([title('x', { durationMs: null })]), []);
  assert.deepEqual(defaultSelectedTitleIds([title('x', { durationMs: 'abc' })]), []);
});

// ---------- MP4 与图像字幕 ----------
test('MP4 不保留 PGS / VobSub 图像字幕，且必须由用户主动选择', () => {
  assert.ok(hasImageSubtitles(pgsTitle));
  assert.ok(!hasImageSubtitles(titles[0]));
  for (const codec of ['pgssub', 'PGS', 'dvd_subtitle', 'dvdsub', 'vobsub', 'xsub']) {
    assert.ok(IMAGE_SUBTITLE_CODECS.has(codec.toLowerCase()), `${codec} 应属图像字幕`);
  }
  for (const codec of ['subrip', 'ass', 'webvtt', 'mov_text']) {
    assert.ok(!IMAGE_SUBTITLE_CODECS.has(codec.toLowerCase()), `${codec} 是文字字幕`);
  }

  const selected = states(['3']);
  // 字幕仍为「全部」：必须被拦住，并提示主动改为不保留
  let job = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mp4', quality: 'high', audioCodec: 'aac', titles: selected,
  });
  assert.ok(validateJob(job, selected).some((e) => /MP4 不支持 PGS \/ VobSub/.test(e)
    && /主动/.test(e)), JSON.stringify(validateJob(job, selected)));
  // 逐项只保留文字字幕（非空）：同样被拦住，不允许默默丢轨
  job = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mp4', quality: 'high', audioCodec: 'aac', titles: selected,
  });
  job.titles[0].subtitleTrackIds = ['6'];
  assert.ok(validateJob(job, selected).some((e) => /MP4 不支持/.test(e)),
    '只保留文字字幕也不能绕过图像字幕限制');
  // 纯文字字幕标题：MP4 同样什么都不保留，只选 subrip 也被拒
  const textOnly = [{ title: textSubTitle, selected: true, audio: null, subs: ['7'] }];
  const textJob = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mp4', quality: 'high', audioCodec: 'aac', titles: textOnly,
  });
  const textErrors = validateJob(textJob, textOnly);
  assert.ok(textErrors.some((e) => /MP4 输出不保留字幕/.test(e) && /主动/.test(e)),
    JSON.stringify(textErrors));
  assert.ok(!textErrors.some((e) => /PGS \/ VobSub/.test(e)),
    '纯文字字幕标题不应提示图像字幕');
  // 同一标题改为「不保留」后放行
  const textNone = [{ title: textSubTitle, selected: true, audio: null, subs: [] }];
  const textNoneJob = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mp4', quality: 'high', audioCodec: 'aac', titles: textNone,
  });
  assert.deepEqual(validateJob(textNoneJob, textNone), []);
  // 用户主动把该标题字幕设为「不保留」：放行
  const none = states(['3'], null, []);
  job = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mp4', quality: 'high', audioCodec: 'aac', titles: none,
  });
  assert.deepEqual(validateJob(job, none), [], '主动选择不保留字幕后应放行');
  // MKV 输出不受图像字幕限制
  const mkvJob = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mkv', quality: 'high', audioCodec: 'copy', titles: states(['3']),
  });
  assert.deepEqual(validateJob(mkvJob, states(['3'])), []);
  // 无损 copy 模式也只有 MKV
  const copyJob = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'copy',
    format: 'mkv', quality: 'high', audioCodec: 'copy', titles: states(['3']),
  });
  assert.deepEqual(validateJob(copyJob, states(['3'])), []);
});

// ---------- job 构造与校验 ----------
test('job 构造：字段齐全，选轨原样透传', () => {
  const selected = states(['1', '2'], ['1'], null);
  const job = buildJob({
    id: 'job-1',
    source: { kind: 'folder', path: 'D:/BDMV' },
    keydbPath: 'C:/KEYDB.cfg',
    outputDir: 'C:/out',
    mode: 'transcode',
    format: 'mkv',
    quality: 'medium',
    audioCodec: 'aac',
    titles: selected,
  });
  assert.equal(job.id, 'job-1');
  assert.equal(job.source.kind, 'folder');
  assert.equal(job.keydbPath, 'C:/KEYDB.cfg');
  assert.equal(job.mode, 'transcode');
  assert.equal(job.format, 'mkv');
  assert.equal(job.quality, 'medium');
  assert.equal(job.audioCodec, 'aac');
  assert.equal(job.titles.length, 2, '只提交勾选的标题');
  assert.deepEqual(job.titles.map((t) => t.titleId), ['1', '2']);
  assert.deepEqual(job.titles[0].audioTrackIds, ['1']);
  assert.equal(job.titles[0].subtitleTrackIds, null, '未设置的字幕保持全部');
  // 任务对象不得夹带可执行命令片段
  const flat = JSON.stringify(job);
  for (const bad of ['-c:', '-map', 'ffmpeg', 'copy>', 'pipe:']) {
    assert.ok(!flat.includes(bad), `job 不得包含 ${bad}`);
  }
});

test('validateJob：缺来源/输出目录/标题、格式不兼容、音频编码不符一律报错', () => {
  const selected = states(['1']);
  const base = {
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out',
    mode: 'transcode', format: 'mkv', quality: 'high', audioCodec: 'aac',
    titles: selected,
  };
  assert.deepEqual(validateJob(buildJob(base), selected), []);
  assert.deepEqual(validateJob(null, selected), ['任务无效']);

  const noSource = { ...base, source: null };
  assert.ok(validateJob(buildJob(noSource), selected).some((e) => /选择光盘来源/.test(e)));
  const noDir = { ...base, outputDir: '' };
  assert.ok(validateJob(buildJob(noDir), selected).some((e) => /输出目录/.test(e)));
  const noTitles = { ...base, titles: [] };
  assert.ok(validateJob(buildJob(noTitles), []).some((e) => /至少勾选一个标题/.test(e)));

  // copy 模式选 MP4：格式与方式不兼容
  const badFormat = { ...base, mode: 'copy', format: 'mp4' };
  assert.ok(validateJob(buildJob(badFormat), selected).some((e) => /不兼容/.test(e)));
  // transcode/MP4 但音频不是 aac
  const badAudio = { ...base, format: 'mp4', audioCodec: 'copy' };
  assert.ok(validateJob(buildJob(badAudio), selected).some((e) => /MP4 输出必须把音频编码设为 AAC/.test(e)));
  // 无损模式但音频不是 copy
  const badCopy = { ...base, mode: 'copy', audioCodec: 'aac' };
  assert.ok(validateJob(buildJob(badCopy), selected).some((e) => /无损模式只能直接复制音频流/.test(e)));
});

test('validateJob：轨号必须真实存在，未勾选与未选轨都会被拒绝', () => {
  const selected = states(['1']);
  const job = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mkv', quality: 'high', audioCodec: 'aac', titles: selected,
  });
  // 标题 1 只有音轨 '1'
  job.titles[0].audioTrackIds = ['9'];
  assert.ok(validateJob(job, selected).some((e) => /音轨 9 不存在/.test(e)),
    '伪造的轨号必须被拒绝');
  job.titles[0].audioTrackIds = ['1'];
  job.titles[0].subtitleTrackIds = ['7']; // 标题 1 没有任何字幕
  assert.ok(validateJob(job, selected).some((e) => /字幕轨 7 不存在/.test(e)));
  job.titles[0].subtitleTrackIds = [];
  assert.deepEqual(validateJob(job, selected), [], '合法指定轨应放行');

  // 未勾选的标题不应出现在 job 里；若出现要报错
  const unselected = states([], ['1'], []);
  const job2 = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mkv', quality: 'high', audioCodec: 'aac', titles: unselected,
  });
  assert.equal(job2.titles.length, 0);
  assert.ok(validateJob(job2, unselected).some((e) => /至少勾选一个标题/.test(e)));

  // 提交前未设置选轨（undefined）也要报错，不允许静默按全部处理
  // 注意：不能用 states(['1'], undefined, undefined) —— 默认参数会把 undefined 变成 null
  const untouched = [{ title: titles[0], selected: true }];
  const job3 = buildJob({
    source: { kind: 'iso', path: 'C:/d.iso' }, outputDir: 'C:/out', mode: 'transcode',
    format: 'mkv', quality: 'high', audioCodec: 'aac', titles: untouched,
  });
  const errors = validateJob(job3, untouched);
  assert.ok(errors.some((e) => /标题 1 未选择音轨/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some((e) => /标题 1 未选择字幕/.test(e)), JSON.stringify(errors));
});

// ---------- 格式化 ----------
test('时长 / 字节 / 速度 / 剩余时间格式化', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(1000), '00:00:01');
  assert.equal(formatDuration(3661000), '01:01:01');
  assert.equal(formatDuration(110 * 60000), '01:50:00');
  for (const bad of [-1, null, undefined, 'abc', NaN, Infinity]) {
    assert.equal(formatDuration(bad), '--:--:--', `非法时长 ${String(bad)}`);
  }

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 700), '700 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 4.2), '4.2 GB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 1024 * 3), '3.0 TB');
  assert.equal(formatBytes(150 * 1024), '150 KB', '三位数不带小数');
  for (const bad of [-1, null, undefined, 'abc', NaN]) {
    assert.equal(formatBytes(bad), '--', `非法字节数 ${String(bad)}`);
  }
  assert.equal(formatSpeed(1024 * 1024 * 2), '2.0 MB/s');

  assert.equal(formatEta(0), '00:00');
  assert.equal(formatEta(59), '00:59');
  assert.equal(formatEta(3600 + 120 + 5), '1:02:05');
  for (const bad of [-1, null, undefined, 'abc', NaN]) {
    assert.equal(formatEta(bad), '--', `非法剩余时间 ${String(bad)}`);
  }
});

test('轨道文案：语言 / 编码 / 标签，缺失时优雅降级', () => {
  assert.equal(streamLabel({ language: 'eng', codec: 'ac3', label: 'English' }), 'eng · ac3 · English');
  assert.equal(streamLabel({ language: 'jpn', codec: 'aac' }), 'jpn · aac');
  assert.equal(streamLabel({ codec: 'aac' }), 'aac');
  assert.equal(streamLabel({ language: 'und' }), 'und');
  assert.equal(streamLabel({ language: 'eng', label: 'English' }), 'eng · English',
    '标签与语言不同才展示');
  assert.equal(streamLabel({ language: 'eng', label: 'eng' }), 'eng', '标签与语言相同不重复');
  assert.equal(streamLabel({}), '未知轨道');
  assert.equal(streamLabel(null), '未知轨道');
  // 不可信字符串只被转换，不会被当成 HTML
  const weird = streamLabel({ language: '<img src=x onerror=alert(1)>', codec: 'x' });
  assert.ok(weird.includes('<img'), '文案本身不转义（转义由 textContent 保证）');
});

// ---------- 进度文案 ----------
test('进度阶段文案：pass 是阶段名，不能显示成「第 mux 遍」', () => {
  assert.equal(passLabel('mux'), '阶段：封装');
  assert.equal(passLabel('sync'), '阶段：同步');
  assert.equal(passLabel('verify'), '阶段：校验');
  assert.equal(passLabel('MUX'), '阶段：封装', '忽略大小写');
  assert.equal(passLabel('custom'), '阶段：custom', '未知阶段原样展示');
  for (const empty of ['', '   ', null, undefined, 3, {}]) {
    assert.equal(passLabel(empty), '', `非法阶段 ${String(empty)} 返回空串`);
  }
  // 源码里不得再出现「第 ${evt.pass} 遍」这种把阶段名当序号的写法
  assert.ok(!/第 \$\{[^}]+\} 遍/.test(discSrc), 'pass 不得渲染成「第 N 遍」');
  // 进度事件必须真的驱动进度条，而不只是状态文字
  assert.match(discSrc, /case 'progress'[\s\S]*?progressBar\.style\.setProperty\('--progress-width'/,
    'progress 事件必须更新进度条宽度');
});

// ---------- 任务防重入 ----------
test('任务防重入：running 时 startJob 不得再次提交', async () => {
  // 复刻页面 startJob 的前置判断与状态机，验证重复点击只提交一次
  const src = fs.readFileSync(path.join(repo, 'html/js/disc.dvd.js'), 'utf8');
  const fn = extractFunction(src, 'startJob');
  const calls = [];
  const ctx = {
    console,
    jobErrors: () => [],
    currentJob: () => ({ id: 'x', titles: [], mode: 'copy', format: 'mkv' }),
    state: { running: false, jobId: null, titles: [] },
    setTitleState() {},
    els: {
      log: { classList: { add() {} }, textContent: '' },
      progressBar: { style: { setProperty() {}, getPropertyValue: () => '0%' } },
      status: {},
      startHint: {},
    },
    log() {},
    setStatus() {},
    updateButtons() {},
    handleDiscEvent() {},
    FORMAT_LABELS: { mkv: 'MKV', mp4: 'MP4' },
    window: {
      ffgui: {
        onDiscEvent: () => () => {},
        discStart: (job) => { calls.push(job); return Promise.resolve({ done: 1, total: 1 }); },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  // 第一次：正常提交
  await ctx.startJob();
  assert.equal(calls.length, 1);
  // 重置 running 前再次调用（模拟任务未结束时的重复点击）：不得再提交
  ctx.state.running = true;
  await ctx.startJob();
  assert.equal(calls.length, 1, '任务进行中不得重复提交');
  ctx.state.running = false;
  await ctx.startJob();
  assert.equal(calls.length, 2, '任务结束后可以再次提交');
});

// ---------- 类型切换（disc.type.js） ----------
// 合并页由类型控制器收口：它只按类型显隐外壳面板，两侧业务逻辑仍在各自 IIFE 里，
// 所以这里只测这两个纯函数，不触碰 DOM。
const TYPE_EXPORTS = ['canSwitchType', 'typePanels'];
const typeApi = extractLogic(typeSrc, 'html/js/disc.type.js', TYPE_EXPORTS);
const { canSwitchType, typePanels } = typeApi;

test('类型切换：两侧都空闲才允许切换，任一任务进行中一律拒绝', () => {
  const idle = { disc: false, cd: false };
  assert.equal(canSwitchType('video', idle), true);
  assert.equal(canSwitchType('cd', idle), true);
  // 任一侧任务进行中都锁住类型，避免半路换面板后任务失去进度入口
  assert.equal(canSwitchType('video', { disc: true, cd: false }), false);
  assert.equal(canSwitchType('cd', { disc: false, cd: true }), false);
  assert.equal(canSwitchType('cd', { disc: true, cd: true }), false);
  assert.equal(canSwitchType('video', { disc: false, cd: true }), false, 'CD 抓轨中也不得切到视频侧');
  // 状态缺省视为空闲
  for (const running of [undefined, null, {}]) {
    assert.equal(canSwitchType('video', running), true, `running=${String(running)} 视为空闲`);
  }
  // 只有 video / cd 两种类型，大小写不同或拼错都不得放行
  for (const bad of ['', 'vedio', 'CD', 'Video', null, undefined, 0, 1, {}, ['video']]) {
    assert.equal(canSwitchType(bad, idle), false, `应拒绝类型 ${String(bad)}`);
  }
});

test('类型切换：typePanels 给出该侧全部外壳面板，未知类型返回空数组', () => {
  assert.deepEqual(typePanels('video'),
    ['source-panel', 'titles-panel', 'output-panel', 'action-panel']);
  assert.deepEqual(typePanels('cd'),
    ['cd-source-panel', 'tracks-panel', 'meta-panel', 'cd-output-panel', 'cd-action-panel']);
  for (const bad of ['', 'bogus', null, undefined, 0, [], {}]) {
    assert.deepEqual(typePanels(bad), [], `未知类型 ${String(bad)} 不显示任何面板`);
  }
  // 两组面板互不相交：否则切到一侧时会把另一侧的面板顺带显示/隐藏
  const video = typePanels('video');
  const cd = typePanels('cd');
  assert.deepEqual(video.filter((id) => cd.includes(id)), [], '两侧面板 id 不得重复');
  // 每个面板 id 都必须真实存在于合并页，否则控制器 toggle 时会抛错
  for (const id of [...video, ...cd]) {
    assert.ok(new RegExp(`id="${id}"`).test(discHtml), `disc.html 缺少面板 ${id}`);
  }
  // 两侧外壳面板在 HTML 里都是初始 hidden，等待用户先选类型
  for (const id of [...video, ...cd]) {
    assert.match(discHtml, new RegExp(`class="panel hidden" id="${id}"`),
      `面板 ${id} 须初始隐藏`);
  }
});

// ---------- 页面约定 ----------
test('HTML：CSP 不含 media/img 放行，无内联脚本与内联样式，脚本顺序正确', () => {
  // http-equiv 与 content 分开写：分别取出 meta 标签再解析 content 属性
  const cspTag = /<meta[^>]*Content-Security-Policy[^>]*>/.exec(discHtml);
  assert.ok(cspTag, '必须声明 CSP');
  const cspContent = /content="([^"]*)"/.exec(cspTag[0]);
  assert.ok(cspContent, 'CSP meta 必须带 content 属性');
  const policy = cspContent[1];
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /style-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.ok(!/media-src/.test(policy), '本页不预览媒体，不应放行 media-src');
  assert.ok(!/img-src data:/.test(policy), '不应放行 img-src data:');

  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(discHtml), '不得有内联脚本');
  assert.ok(!discHtml.includes('style="'), '不得有内联 style 属性');
  assert.ok(!/on(click|load|error)=/.test(discHtml), '不得有内联事件属性');

  // 合并页固定加载五个脚本，顺序不能变：i18n 供 theme 与两侧脚本取词，
  // 两侧脚本先建好 window.__ffgui*Page 钩子，类型控制器最后接管面板显隐并惰性枚举光驱
  const scriptSrcs = [...discHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scriptSrcs, [
    'js/i18n.js', 'js/theme.js', 'js/disc.dvd.js', 'js/disc.cd.js', 'js/disc.type.js',
  ], '脚本清单与顺序固定：i18n.js → theme.js → 视频侧 → CD 侧 → 类型控制器');
  const themeIdx = discHtml.indexOf('js/theme.js');
  const dvdIdx = discHtml.indexOf('js/disc.dvd.js');
  const cdIdx = discHtml.indexOf('js/disc.cd.js');
  const typeIdx = discHtml.indexOf('js/disc.type.js');
  assert.ok(themeIdx !== -1 && dvdIdx !== -1 && cdIdx !== -1 && typeIdx !== -1);
  assert.ok(themeIdx < dvdIdx, 'theme.js 必须先于两侧页面脚本加载');
  assert.ok(dvdIdx < cdIdx, '视频侧脚本先于 CD 侧脚本加载');
  assert.ok(cdIdx < typeIdx, '类型控制器必须最后加载');
  assert.match(discHtml, /css\/disc\.css/, '须引用 disc.css');
  assert.match(discHtml, /css\/cd\.css/, '须引用 cd.css');
  assert.match(discHtml, /css\/style\.css/, '须引用共用样式');
});

test('安全：三个页面脚本都不拼 HTML、不碰 Node 能力，window.ffgui 调用都在白名单内', () => {
  assert.ok(!discHtml.includes('innerHTML'), 'HTML 不得使用 innerHTML');
  for (const [name, src] of PAGE_SCRIPTS) {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write',
      'eval(', 'new Function']) {
      assert.ok(!src.includes(banned), `${name} 不得使用 ${banned}`);
    }
    // 渲染层不得引用 Node/Electron 能力
    for (const banned of ['require(', "require('electron')", 'process.', 'child_process', '__dirname']) {
      assert.ok(!src.includes(banned), `${name} 不得引用 ${banned}`);
    }
    // 不得自行拼装 ffmpeg 参数（CSS 自定义属性 --progress-width 不算 ffmpeg 的 -progress）
    for (const bad of ['-c:v', '-map ', 'pipe:', 'ffmpeg', 'libx264', '-nostats']) {
      assert.ok(!src.includes(bad), `${name} 不得拼装 ffmpeg 参数：${bad}`);
    }
    // 不得自行拼装 ffmpeg 参数。-progress 只在作为独立参数出现时才算命中：
    // CSS 自定义属性 `--progress-width` 与控件 id `cd-progress-bar` 不是 ffmpeg 参数
    assert.ok(!/(^|[\s'"?])-progress\b/m.test(src), `${name} 不得拼装 ffmpeg 参数：-progress`);
  }

  // 只用冻结的 window.ffgui 入口：视频侧 + CD 侧 + 类型控制器合起来也不得越界
  const apiCalls = PAGE_SCRIPTS.flatMap(([name, src]) => [...src.matchAll(/window\.ffgui\.(\w+)/g)]
    .map((m) => ({ file: name, api: m[1] })));
  assert.ok(apiCalls.length > 0, '至少应调用一个 window.ffgui 接口');
  const allowed = new Set([
    'discPickSource', 'discPickKeydb', 'discListDrives', 'discProbe',
    'discStart', 'discCancel', 'onDiscEvent',
    'cdListDrives', 'cdProbe', 'cdLookup', 'cdReleaseTracks', 'cdStart', 'cdCancel', 'onCdEvent',
    'pickDirectory', 'getTheme', 'setTheme', 'onThemeChanged',
  ]);
  for (const call of apiCalls) {
    assert.ok(allowed.has(call.api), `${call.file} 不得调用未冻结的 API ${call.api}`);
    // 两侧接口不得串用：disc* 只在视频侧、cd* 只在 CD 侧（各自的单任务锁互不干扰）
    if (call.api.startsWith('disc') || call.api === 'onDiscEvent') {
      assert.equal(call.file, 'html/js/disc.dvd.js', `视频光盘接口不应出现在 ${call.file}`);
    }
    if (call.api.startsWith('cd') || call.api === 'onCdEvent') {
      assert.equal(call.file, 'html/js/disc.cd.js', `CD 抓轨接口不应出现在 ${call.file}`);
    }
  }

  // 跨 IIFE 的钩子只有两个：各自 IIFE 赋值，类型控制器只读不改写
  const assignments = (src) => [...src.matchAll(/window\.(__ffguiDiscPage|__ffguiCdPage)\s*=/g)]
    .map((m) => m[1]);
  assert.deepEqual(assignments(discSrc), ['__ffguiDiscPage'], '视频侧只暴露自己的钩子');
  assert.deepEqual(assignments(cdSrc), ['__ffguiCdPage'], 'CD 侧只暴露自己的钩子');
  assert.deepEqual(assignments(typeSrc), [], '类型控制器不得改写两侧钩子');
  assert.ok(/window\.__ffguiDiscPage/.test(typeSrc) && /window\.__ffguiCdPage/.test(typeSrc),
    '类型控制器须经钩子查询两侧状态');
  // 控制器只依赖 isRunning / refreshDrives 两个成员，两侧钩子都得提供
  for (const [name, src] of [['html/js/disc.dvd.js', discSrc], ['html/js/disc.cd.js', cdSrc]]) {
    assert.match(src, /isRunning:/, `${name} 的钩子须提供 isRunning`);
    assert.match(src, /refreshDrives:/, `${name} 的钩子须提供 refreshDrives`);
  }
});

test('CSS：两侧样式表都不含内联样式，主题只用 CSS 变量', () => {
  for (const [name, css] of [['disc.css', discCss], ['cd.css', cdCss]]) {
    assert.ok(!css.includes('style="'), `${name} 不得含内联样式`);
    assert.ok(!/@import/.test(css), `${name} 不得引入远程资源`);
    // 颜色一律走 style.css 的主题变量
    const colors = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const allowed = new Set(['#000']);
    for (const c of colors) assert.ok(allowed.has(c), `${name} 不得写死颜色 ${c}`);
    for (const v of ['var(--card-bg)', 'var(--border)', 'var(--text)', 'var(--text-secondary)']) {
      assert.ok(css.includes(v), `${name} 应使用主题变量 ${v}`);
    }
  }
});

test('HTML：关键控件齐备（类型选择 + 视频侧 + CD 侧），id 无重复且脚本引用都落地', () => {
  for (const id of [
    // 页头与类型选择
    'btn-back', 'type-panel', 'type-hint',
    // 视频光盘侧
    'btn-pick-iso', 'btn-pick-folder', 'drive-wrap', 'sel-drive', 'btn-refresh-drives',
    'drive-hint', 'source-name', 'btn-clear-source', 'btn-probe', 'input-keydb',
    'btn-pick-keydb', 'btn-clear-keydb', 'titles-panel', 'disc-meta', 'title-list',
    'btn-select-longest', 'btn-select-all-titles', 'btn-select-none-titles',
    'output-panel', 'sel-mode', 'sel-format', 'sel-quality', 'sel-audio-codec',
    'input-outdir', 'btn-pick-dir', 'action-panel', 'btn-start', 'btn-cancel',
    'start-hint', 'status-text', 'progress-bar', 'log-area',
    // 音乐 CD 侧（容器与列表沿用原名，其余一律 cd- 前缀）
    'cd-source-panel', 'cd-drive-wrap', 'cd-sel-drive', 'cd-btn-refresh-drives',
    'cd-drive-hint', 'cd-btn-probe', 'tracks-panel', 'track-list', 'btn-lookup',
    'cd-meta', 'mb-result', 'meta-panel', 'input-album', 'input-album-artist',
    'input-artist', 'input-date', 'input-genre', 'sel-compression',
    'cd-output-panel', 'sel-paranoia', 'cd-input-outdir', 'cd-btn-pick-dir',
    'cd-action-panel', 'cd-btn-start', 'cd-btn-cancel', 'cd-start-hint',
    'cd-status-text', 'cd-progress-bar', 'cd-log-area',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(discHtml), `缺少控件 ${id}`);
  }
  // 类型卡片：两张 .type-option，靠 data-disc-type 区分（disc.type.js 按它 setType）
  assert.equal((discHtml.match(/class="type-option"/g) || []).length, 2, '须有两张类型卡片');
  assert.match(discHtml, /data-disc-type="video"/);
  assert.match(discHtml, /data-disc-type="cd"/);
  // 输出方式与格式选项在 HTML 中给出，音频编码候选由脚本填充
  assert.match(discHtml, /id="sel-mode"[^>]*>\s*<option value="copy"/);
  assert.match(discHtml, /id="sel-format"/);
  // MP4 字幕限制必须在页面上有明确说明
  assert.match(discHtml, /PGS \/ VobSub 图像字幕/, '页面须说明 MP4 不支持图像字幕');

  // 两侧共用一个文档，id 重复会让 $('id') 拿到另一侧的控件
  const ids = [...discHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'disc.html 的 id 不得重复');
  // 三个脚本用 $('id') / getElementById('id') 取到的控件必须真实存在
  const htmlIds = new Set(ids);
  for (const [name, src] of PAGE_SCRIPTS) {
    const refs = [...src.matchAll(/\$\(\s*'([^']+)'\s*\)|getElementById\(\s*'([^']+)'\s*\)/g)]
      .map((m) => m[1] || m[2]);
    for (const id of refs) assert.ok(htmlIds.has(id), `${name} 引用了不存在的控件 ${id}`);
  }
});

// 从源码中截取单个函数（与 scripts/regression.test.cjs 同思路）
// 允许 async 前缀；函数体按「以两空格缩进的闭合花括号」截取
function extractFunction(src, name) {
  const head = new RegExp(`\\n  (?:async )?function ${name}\\(`).exec(src);
  assert.ok(head, `找不到函数 ${name}`);
  const start = head.index + 1; // 去掉匹配到的前导换行
  const end = src.indexOf('\n  }', start);
  assert.ok(end > start, `函数 ${name} 缺少以「\\n  }」结尾的函数体`);
  return src.slice(start, end + 4);
}
