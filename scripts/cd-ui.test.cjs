'use strict';

// 运行：node --test scripts/cd-ui.test.cjs
// 光盘页·音乐 CD 侧（html/disc.html + html/js/disc.cd.js）的纯逻辑测试：
// 设备/轨条目归一、MusicBrainz 候选与逐曲覆盖、任务构造与校验、
// 格式化，以及页面本身的安全约定（CSP、无 innerHTML、脚本顺序、CD 侧控件齐备）。
// 页面已与视频光盘侧合并到同一个 html/disc.html，本文件只覆盖 CD 侧脚本与它的控件。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
// 合并后的统一光盘页：HTML 与样式由视频侧/CD 侧共用，本文件只挑 CD 侧的脚本与控件断言
const discHtml = fs.readFileSync(path.join(repo, 'html/disc.html'), 'utf8');
const cdCss = fs.readFileSync(path.join(repo, 'html/css/cd.css'), 'utf8');
const cdSrc = fs.readFileSync(path.join(repo, 'html/js/disc.cd.js'), 'utf8');

// 标记行自带中文说明（「（node:test 按标记整段提取…）」），必须整行丢弃，
// 只按前缀切会把行尾残片留在被提取的代码里，导致 vm 报 SyntaxError。
const START = '// ---------- 纯逻辑开始';
const END = '// ---------- 纯逻辑结束';
const cdLines = cdSrc.split(/\r?\n/);
const startLine = cdLines.findIndex((line) => line.trim().startsWith(START));
const endLine = cdLines.findIndex((line) => line.trim().startsWith(END));
assert.ok(startLine >= 0, '找不到纯逻辑开始标记所在行');
assert.ok(endLine > startLine, '找不到纯逻辑结束标记所在行');
const logic = cdLines.slice(startLine + 1, endLine).join('\n');
assert.match(logic.trimStart(), /^(?:const|function|let)\b/, '纯逻辑段必须以代码开始，不得残留注释尾巴');

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

// 纯逻辑在与测试同一 realm 内求值（仅用函数包一层，避免污染本文件的顶层作用域）
const LOGIC_EXPORTS = [
  'isValidCompression', 'isValidParanoia', 'formatDuration', 'normalizeTrack',
  'normalizeTracks', 'normalizeReleases', 'applyReleaseTracks', 'validateCdJob',
  'buildCdJob', 'buildMetadata', 'formatBytes', 'shortId',
  'COMPRESSION_LEVELS', 'PARANOIA_MODES',
];
const logicApi = vm.runInThisContext(
  `(function () {\n${logic}\n  return { ${LOGIC_EXPORTS.join(', ')} };\n})()`,
  { filename: 'html/js/disc.cd.js#logic' },
);
const {
  isValidCompression, isValidParanoia, formatDuration, normalizeTrack,
  normalizeTracks, normalizeReleases, applyReleaseTracks, validateCdJob,
  buildCdJob, buildMetadata, formatBytes, shortId,
  COMPRESSION_LEVELS, PARANOIA_MODES,
} = logicApi;

// ---------- 白名单 ----------

test('白名单：压缩级别与纠错模式与主进程一致', () => {
  assert.equal(isValidCompression(5), true);
  assert.equal(isValidCompression(8), true);
  assert.equal(isValidCompression(12), true);
  assert.equal(isValidCompression(13), false);
  assert.equal(isValidCompression('8'), true, '字符串数字也接受（来自 <select>）');
  assert.equal(isValidCompression(4.5), false);
  for (const mode of ['disable', 'verify', 'overlap', 'neverskip', 'full']) {
    assert.equal(isValidParanoia(mode), true);
  }
  assert.equal(isValidParanoia('bogus'), false);
  assert.equal(isValidParanoia(''), false);
});

// ---------- 曲目归一 ----------

test('曲目归一：合法条目通过，非法条目被拒', () => {
  const ok = normalizeTrack({ number: 3, start: 10, end: 40.5, title: 'T' }, 0);
  assert.deepEqual(ok, {
    number: 3, start: 10, end: 40.5, duration: 30.5, title: 'T',
  });
  for (const bad of [
    null, undefined, 'x', 42,
    { number: 0, start: 0, end: 1 },
    { number: 100, start: 0, end: 1 },
    { number: 1.5, start: 0, end: 1 },
    { number: 1, start: 10, end: 5 },
    { number: 1, start: -1, end: 5 },
    { number: 1, start: 0, end: 'x' },
    { number: 1, start: 0, end: 0 },
  ]) {
    assert.equal(normalizeTrack(bad, 0), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
  // 标题非字符串时降级为空串，不阻断整轨
  const noTitle = normalizeTrack({ number: 1, start: 0, end: 5, title: 42 }, 0);
  assert.equal(noTitle.title, '');
});

test('曲目归一：整表按轨号排序并剔除坏条目', () => {
  const tracks = normalizeTracks([
    { number: 3, start: 20, end: 30 },
    { number: 1, start: 0, end: 10 },
    { number: 2, start: 10, end: 20 },
    { number: 9, start: 0, end: 0 },
  ]);
  assert.deepEqual(tracks.map((t) => t.number), [1, 2, 3]);
  assert.deepEqual(normalizeTracks(null), []);
  assert.deepEqual(normalizeTracks('x'), []);
});

// ---------- MusicBrainz ----------

test('候选发行归一：只保留界面需要的字段，无 id 的条目被剔', () => {
  const releases = normalizeReleases([
    { id: 'a', title: 'T', artist: 'A', date: '2024', country: 'US', barcode: '1', trackCount: 12 },
    { id: '', title: 'no id' },
    null,
    'x',
  ]);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0], {
    id: 'a', title: 'T', artist: 'A', date: '2024', country: 'US', barcode: '1', trackCount: 12,
  });
  assert.deepEqual(normalizeReleases(null), []);
});

test('逐曲覆盖：按 position 对齐，长度不匹配时只覆盖能对上的', () => {
  const tracks = [
    { number: 1, start: 0, end: 10, duration: 10, title: '', selected: true, mbArtist: '' },
    { number: 2, start: 10, end: 20, duration: 10, title: '', selected: true, mbArtist: '' },
  ];
  const applied = applyReleaseTracks(tracks, [
    { position: 1, title: 'One', artist: 'A1', lengthMs: 10000 },
    { position: 2, title: 'Two', artist: 'A2', lengthMs: 10000 },
    { position: 3, title: 'Extra', artist: 'A3', lengthMs: 1 },
  ]);
  assert.equal(applied[0].title, 'One');
  assert.equal(applied[0].mbArtist, 'A1');
  assert.equal(applied[1].title, 'Two');
  // 盘上只有两轨时第三轨被忽略，不会凭空多出一首
  assert.equal(applied.length, 2);
  // 缺 position 或 position 非正整数的条目被忽略
  const partial = applyReleaseTracks(tracks, [
    { position: 0, title: 'bad' },
    { title: 'no position' },
    null,
  ]);
  assert.equal(partial[0].title, '', '无效条目不得覆盖既有值');
  // 原数组不被修改
  assert.equal(tracks[0].title, '');
});

// ---------- 任务构造与校验 ----------

function trackState(over = {}) {
  return {
    number: 1, start: 0, end: 10, duration: 10,
    title: '', mbArtist: '', selected: true, ...over,
  };
}

test('buildCdJob：只透传数据，未勾选的曲目不提交', () => {
  const job = buildCdJob({
    id: 'job-1',
    device: 'E:',
    outputDir: 'C:\\out',
    compression: '8',
    paranoiaMode: 'full',
    metadata: { album: 'A' },
    tracks: [trackState(), trackState({ number: 2, selected: false })],
  });
  assert.equal(job.id, 'job-1');
  assert.equal(job.device, 'E:');
  assert.equal(job.compression, 8, '字符串数字转为数值');
  assert.equal(job.paranoiaMode, 'full');
  assert.equal(job.tracks.length, 1, '未勾选的曲目不提交');
  assert.deepEqual(job.tracks[0], { number: 1, start: 0, end: 10, title: '' });
  // 不得夹带命令片段或 DOM 引用
  assert.ok(!JSON.stringify(job).includes('ffmpeg'));
  assert.ok(!JSON.stringify(job).includes('-c:a'));
});

test('buildMetadata：每轨覆盖优先，专辑级默认值兜底', () => {
  const metadata = buildMetadata([
    trackState({ number: 1, title: 'T1', mbArtist: 'G1' }),
    trackState({ number: 2, title: '', mbArtist: '', selected: false }),
  ], { album: 'Album', albumArtist: 'AA', artist: 'Default', date: '2024', genre: 'Pop' });
  assert.equal(metadata.album, 'Album');
  assert.equal(metadata.albumArtist, 'AA');
  assert.equal(metadata.artist, 'Default');
  assert.equal(metadata.date, '2024');
  assert.equal(metadata.genre, 'Pop');
  assert.deepEqual(metadata.tracks, { 1: { title: 'T1', artist: 'G1' } },
    '未勾选曲目不进入逐曲覆盖');
});

test('buildMetadata：曲目无自定义信息时不产生空条目', () => {
  const metadata = buildMetadata([trackState({ title: '', mbArtist: '' })], { album: 'A' });
  assert.deepEqual(metadata.tracks, {});
});

test('validateCdJob：合法任务无错误', () => {
  const job = buildCdJob({
    id: 'job-1', device: 'E:', outputDir: 'C:\\out', compression: 8,
    paranoiaMode: 'disable', metadata: null, tracks: [trackState()],
  });
  assert.deepEqual(validateCdJob(job), []);
});

test('validateCdJob：缺设备、缺目录、无曲目、非法档位都被拒', () => {
  const base = {
    id: 'job-1', device: 'E:', outputDir: 'C:\\out', compression: 8,
    paranoiaMode: 'disable', metadata: null, tracks: [trackState()],
  };
  assert.ok(validateCdJob({ ...base, device: '' }).includes('请先选择光驱'));
  assert.ok(validateCdJob({ ...base, outputDir: '' }).includes('请选择输出目录'));
  assert.ok(validateCdJob({ ...base, tracks: [] }).includes('请至少勾选一首曲目'));
  assert.ok(validateCdJob({ ...base, compression: 13 }).includes('压缩级别无效'));
  assert.ok(validateCdJob({ ...base, paranoiaMode: 'x' }).includes('纠错强度无效'));
  assert.deepEqual(validateCdJob(null).length, 1, '非对象任务只报一条');
  assert.deepEqual(validateCdJob('x').length, 1);
});

test('validateCdJob：轨的起止时间非法时报出曲目号', () => {
  const job = {
    id: 'job-1', device: 'E:', outputDir: 'C:\\out', compression: 8,
    paranoiaMode: 'disable', metadata: null,
    tracks: [{ number: 7, start: 10, end: 5, title: '' }],
  };
  const errors = validateCdJob(job);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /曲目 7/);
});

// ---------- 格式化 ----------

test('格式化：时长、字节、DiscID 缩短显示', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(-1), '--:--');
  assert.equal(formatDuration('x'), '--:--');
  // CD 单轨常见 3-4 分钟
  assert.equal(formatDuration(197.05), '03:17');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 700), '700 MB');

  const id = 'xUp1F2NkfP8s8jaeFn_Av3jNEI4-';
  assert.equal(shortId(id), id, '未超长时原样返回');
  assert.equal(shortId(id, 10), `${id.slice(0, 10)}…`);
  assert.equal(shortId(''), '');
});

// ---------- 页面安全约定 ----------

test('页面：CSP 不放行 media-src，脚本顺序 i18n → theme → 两侧脚本 → 类型控制器', () => {
  const csp = discHtml.match(/content="([^"]*)"/);
  assert.ok(csp, '须声明 CSP');
  assert.match(csp[1], /default-src 'self'/);
  assert.match(csp[1], /style-src 'self'/);
  assert.match(csp[1], /script-src 'self'/);
  // 本页不预览任何本地媒体
  assert.ok(!/media-src/.test(csp[1]), '光盘页不放行 media-src');
  assert.ok(!/img-src/.test(csp[1]), '光盘页不放行 img-src');

  // 合并页的脚本清单固定：i18n → theme → 视频侧 → CD 侧 → 类型控制器
  const scriptSrcs = [...discHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scriptSrcs, [
    'js/i18n.js', 'js/theme.js', 'js/disc.dvd.js', 'js/disc.cd.js', 'js/disc.type.js',
  ], 'CD 侧脚本须排在 i18n.js / theme.js 之后、类型控制器之前');

  const i18nIdx = discHtml.indexOf('js/i18n.js');
  const themeIdx = discHtml.indexOf('js/theme.js');
  const pageIdx = discHtml.indexOf('js/disc.cd.js');
  const typeIdx = discHtml.indexOf('js/disc.type.js');
  assert.ok(i18nIdx !== -1 && themeIdx !== -1 && pageIdx !== -1 && typeIdx !== -1);
  assert.ok(i18nIdx < themeIdx, 'i18n.js 必须最先加载');
  assert.ok(themeIdx < pageIdx, '加载顺序须为 i18n.js → theme.js → js/disc.cd.js');
  assert.ok(pageIdx < typeIdx, '类型控制器须在两侧脚本之后加载');
  const title = discHtml.match(/<html[^>]*data-i18n-title="([^"]+)"/);
  assert.ok(title, '<html> 须带 data-i18n-title');
  assert.equal(title[1], 'disc.title');
});

test('页面：不得把译文或盘上字符串拼进 innerHTML', () => {
  assert.ok(!/innerHTML\s*=/.test(cdSrc), '不得使用 innerHTML 写入内容');
  // 动态文本一律走 textContent
  assert.ok(/textContent/.test(cdSrc), '应使用 textContent 写入文本');
});

test('页面：引用的键都在词典里', () => {
  const zh = zhDict;
  const keys = new Set();
  // HTML 是两侧共用的，其中的视频侧与类型卡片键也一并校验（同一个词典文件）
  for (const m of discHtml.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
  for (const m of discHtml.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) {
      const idx = pair.indexOf(':');
      if (idx >= 0) keys.add(pair.slice(idx + 1).trim());
    }
  }
  for (const m of cdSrc.matchAll(/\bt\(\s*'([\w.-]+)'/g)) keys.add(m[1]);
  const missing = [...keys].filter((key) => dictLookup(zh, key) === undefined);
  assert.deepEqual(missing, [], 'HTML/JS 引用的键必须都在 zh-CN 词典里');
});

test('页面：CD 侧关键控件齐备、面板初始隐藏且引入 cd.css', () => {
  for (const id of [
    'cd-source-panel', 'cd-sel-drive', 'cd-btn-probe', 'cd-btn-refresh-drives',
    'cd-drive-wrap', 'cd-drive-hint', 'tracks-panel', 'track-list', 'btn-lookup',
    'cd-meta', 'mb-result', 'meta-panel', 'input-album', 'input-album-artist',
    'input-artist', 'input-date', 'input-genre', 'sel-compression',
    'cd-output-panel', 'sel-paranoia', 'cd-input-outdir', 'cd-btn-pick-dir',
    'cd-action-panel', 'cd-btn-start', 'cd-btn-cancel', 'cd-status-text',
    'cd-start-hint', 'cd-progress-bar', 'cd-log-area',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(discHtml), `缺少 CD 侧控件 ${id}`);
  }
  // CD 侧外壳面板（含 tracks-panel）初始隐藏，由 disc.type.js 按所选类型显隐
  for (const id of ['cd-source-panel', 'tracks-panel', 'meta-panel', 'cd-output-panel', 'cd-action-panel']) {
    assert.match(discHtml, new RegExp(`class="panel hidden" id="${id}"`),
      `CD 侧面板 ${id} 须初始隐藏`);
  }
  // CD 侧样式与视频侧样式分离，合并页两套都要引入
  assert.match(discHtml, /css\/cd\.css/, '须引用 cd.css');
  assert.ok(!/style="/.test(cdCss), 'cd.css 不得含内联样式');
  assert.ok(!/@import/.test(cdCss), 'cd.css 不得引入远程资源');
});
