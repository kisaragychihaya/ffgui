'use strict';

// 运行：node --test scripts/cdrip.test.cjs
// CD 抓轨主进程测试：mock ffmpeg spawn 与 MusicBrainz 网络，不依赖 Electron、
// 真实光驱或 FFmpeg 二进制。覆盖设备名归一、TOC 解析、DiscID 与官方测试向量
// 一致性、任务校验、输出分配、FLAC 参数组装、进度与取消。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const repo = path.resolve(__dirname, '..');
const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-cd-main-'));
  tempRoots.push(dir);
  return dir;
}

// ---------- 纯函数：设备名归一 ----------

const {
  normalizeDevicePath, parseCdToc, musicbrainzDiscId, buildMusicbrainzToc,
  secondsToFrames, trackFileName, buildCdTrackArgs, buildMetadataArgs,
  validateCdJob,
} = require(path.join(repo, 'main', 'cdrip.js'));

test('设备名归一：三平台各自接受合法形态，拒绝非法形态', () => {
  // Windows：盘符（大小写、有无冒号、\\.\ 前缀均可）
  assert.equal(normalizeDevicePath('E:', 'win32'), 'E:');
  assert.equal(normalizeDevicePath('e:', 'win32'), 'E:');
  assert.equal(normalizeDevicePath('E', 'win32'), 'E:');
  assert.equal(normalizeDevicePath('e', 'win32'), 'E:');
  assert.equal(normalizeDevicePath('\\\\.\\E:', 'win32'), 'E:');
  // libcdio 的 cdio_is_device_win32 只认两位形态，CdRomN 打不开
  assert.equal(normalizeDevicePath('\\\\.\\CdRom0', 'win32'), '');
  assert.equal(normalizeDevicePath('EE:', 'win32'), '');
  assert.equal(normalizeDevicePath('C:\\', 'win32'), '');
  assert.equal(normalizeDevicePath('', 'win32'), '');
  // macOS：/dev/diskN 归一为 rdisk（绕过缓存的字符设备）
  assert.equal(normalizeDevicePath('/dev/disk1', 'darwin'), '/dev/rdisk1');
  assert.equal(normalizeDevicePath('/dev/disk2', 'darwin'), '/dev/rdisk2');
  assert.equal(normalizeDevicePath('/dev/rdisk2', 'darwin'), '/dev/rdisk2');
  assert.equal(normalizeDevicePath('/dev/disk', 'darwin'), '');
  assert.equal(normalizeDevicePath('/dev/cdrom', 'darwin'), '');
  assert.equal(normalizeDevicePath('/dev/sr0', 'darwin'), '');
  assert.equal(normalizeDevicePath('E:', 'darwin'), '');
  // Linux：libfreemkv 枚举出的 sg 字符设备按同号换成 sr 块设备
  // （libcdio 打不开 sg，sgN 与 srN 是同一光驱）
  assert.equal(normalizeDevicePath('/dev/sg0', 'linux'), '/dev/sr0');
  assert.equal(normalizeDevicePath('/dev/sg12', 'linux'), '/dev/sr12');
  // sr / cdrom / dvd 等块设备与符号链接原样接受
  assert.equal(normalizeDevicePath('/dev/sr0', 'linux'), '/dev/sr0');
  assert.equal(normalizeDevicePath('/dev/cdrom', 'linux'), '/dev/cdrom');
  assert.equal(normalizeDevicePath('/dev/dvd', 'linux'), '/dev/dvd');
  assert.equal(normalizeDevicePath('sr0', 'linux'), '');
  assert.equal(normalizeDevicePath('/tmp/sg0', 'linux'), '');
});

// ---------- TOC 解析 ----------

// ffmpeg -i <libcdio 设备> 的 stderr 里 libcdio 用 avpriv_new_chapter 建章节，
// 每轨一条，标题形如 "track 01"
const CD_STDERR = [
  'Guessed Channel Layout for Input Stream #0.0 : stereo',
  'Input #0, libcdio, from \'E:\':',
  '  Duration: N/A, start: 0.000000, bitrate: 1411 kb/s',
  '    Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s',
  'Chapters:',
  '    Chapter #0:0: start 0.000000, end 4.053333',
  '      Metadata:',
  '        title           : track 01',
  '    Chapter #0:1: start 4.053333, end 201.106667',
  '      Metadata:',
  '        title           : track 02',
  '  Program 0',
].join('\n');

test('TOC 解析：从 ffmpeg stderr 提取每轨起止与标题', () => {
  const tracks = parseCdToc(CD_STDERR);
  assert.equal(tracks.length, 2, '应解析出两轨');
  assert.equal(tracks[0].number, 1);
  assert.equal(tracks[0].start, 0);
  assert.equal(tracks[0].end, 4.053333);
  assert.equal(tracks[0].duration, 4.053333);
  assert.equal(tracks[0].title, 'track 01');
  assert.equal(tracks[1].number, 2);
  assert.equal(tracks[1].start, 4.053333);
  assert.equal(tracks[1].title, 'track 02');
});

test('TOC 解析：空输入、无章节段、零长轨都被拒', () => {
  assert.deepEqual(parseCdToc(''), []);
  assert.deepEqual(parseCdToc('Duration: N/A, bitrate: 1411 kb/s'), []);
  // end == start 的零长轨不应出现（非法盘 / 空轨）
  const zero = [
    'Chapters:',
    '    Chapter #0:0: start 1.000000, end 1.000000',
    '  Program 0',
  ].join('\n');
  assert.deepEqual(parseCdToc(zero), []);
});

// ---------- MusicBrainz DiscID ----------

// libdiscid 官方测试向量（test/test_put.c）：22 轨 + lead-out 303602
const LIBDISCID_OFFSETS = [
  150, 9700, 25887, 39297, 53795, 63735, 77517, 94877, 107270,
  123552, 135522, 148422, 161197, 174790, 192022, 205545,
  218010, 228700, 239590, 255470, 266932, 288750,
];

test('DiscID：与 libdiscid 官方测试向量逐位一致', () => {
  // 槽位 0 放 lead-out、其后是各轨起始帧，这是 libdiscid 的数组布局，
  // 与 cyanrip 等工具查询 MusicBrainz 时用的 discid 必须一致
  assert.equal(
    musicbrainzDiscId(LIBDISCID_OFFSETS, 303602),
    'xUp1F2NkfP8s8jaeFn_Av3jNEI4-',
  );
});

test('DiscID：单轨盘与 99 轨上限都得到合法形态', () => {
  const single = musicbrainzDiscId([150], 303602);
  assert.match(single, /^[A-Za-z0-9._-]{28}$/, '28 字符（20 字节 base64 去等号）');
  const many = [];
  for (let i = 0; i < 99; i += 1) many.push(150 + i * 4500);
  const id = musicbrainzDiscId(many, 150 + 99 * 4500);
  assert.match(id, /^[A-Za-z0-9._-]{28}$/, '99 轨也应得到 28 字符');
  // 超过 99 轨按 libdiscid 的 100 槽位实现截断，不应抛错
  const tooMany = [];
  for (let i = 0; i < 120; i += 1) tooMany.push(150 + i * 100);
  assert.match(musicbrainzDiscId(tooMany, 150 + 120 * 100), /^[A-Za-z0-9._-]{28}$/);
});

test('DiscID：不同盘的 ID 不同（扇区换算不能塌缩成同值）', () => {
  const a = musicbrainzDiscId([150, 50000], 100000);
  const b = musicbrainzDiscId([150, 50001], 100000);
  assert.notEqual(a, b, '相邻扇区必须产生不同 ID');
});

test('TOC 查询串：与 MusicBrainz discid 接口要求的格式一致', () => {
  const toc = buildMusicbrainzToc(LIBDISCID_OFFSETS, 303602);
  const parts = toc.split(' ').map(Number);
  assert.equal(parts[0], 1, '首轨号');
  assert.equal(parts[1], 22, '末轨号');
  assert.equal(parts[2], 303602, 'lead-out 扇区');
  assert.equal(parts.length, 3 + 22, '总长度 = 3 + 轨数');
  assert.equal(parts[3], LIBDISCID_OFFSETS[0], '首个偏移');
});

test('扇区换算：75 帧/秒，与 44.1kHz/16bit/立体声的字节率一致', () => {
  assert.equal(secondsToFrames(1), 75);
  assert.equal(secondsToFrames(0), 0);
  // 4.053333s 是 CD 上常见的轨长（304 帧）
  assert.equal(secondsToFrames(4.053333), 304);
  // 2352 字节/帧 × 75 帧/秒 == 176400 字节/秒 == 44100 × 2 × 2
  assert.equal(75 * 2352, 176400);
});

// ---------- 输出文件名 ----------

test('输出文件名：专辑名 + 两位曲序，非法字符被替换', () => {
  assert.equal(trackFileName('My Album', 1), 'My Album - 01');
  assert.equal(trackFileName('My Album', 12), 'My Album - 12');
  // 专辑名缺失时退化为 CD，仍保证唯一可读
  assert.equal(trackFileName('', 3), 'CD - 03');
  // Windows 非法字符与路径分隔符一律换成下划线
  assert.equal(trackFileName('A/B:C*D?', 1), 'A_B_C_D_ - 01');
  // 超长专辑名被截断
  assert.ok(trackFileName('x'.repeat(200), 1).length <= 130);
});

// ---------- 任务校验 ----------

function validJob(over = {}) {
  return {
    id: 'job-1',
    device: 'E:',
    outputDir: 'C:\\out',
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'A', artist: 'B' },
    tracks: [
      { number: 1, start: 0, end: 4.05, title: '' },
      { number: 2, start: 4.05, end: 201.1, title: '' },
    ],
    ...over,
  };
}

// 错误对象把机器可读的码放在 err.code 上，message 是本地化文案，
// 因此断言一律按 code 判断（message 由 i18n 测试另行覆盖）。
function throwsCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err && err.code, code, `期望错误码 ${code}，实际 ${err && err.code}: ${err && err.message}`);
    return true;
  });
}

test('任务校验：合法任务原样通过（设备名被归一）', () => {
  const job = validateCdJob(validJob({ device: 'e:' }));
  assert.equal(job.device, 'E:');
  assert.equal(job.compression, 8);
  assert.equal(job.paranoiaMode, 'disable');
  assert.equal(job.tracks.length, 2);
  assert.equal(job.tracks[0].number, 1);
  assert.equal(job.tracks[0].start, 0);
});

test('任务校验：拒绝空任务、缺字段、非法设备与重复轨号', () => {
  throwsCode(() => validateCdJob(null), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ device: '' })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ device: 'nope' })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ outputDir: '' })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ tracks: [] })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({
    tracks: [{ number: 1, start: 0, end: 1 }, { number: 1, start: 1, end: 2 }],
  })), 'FFGUI_CD_INVALID_JOB');
});

test('任务校验：压缩级别与纠错模式走白名单', () => {
  for (const level of [0, 5, 8, 12]) {
    assert.equal(validateCdJob(validJob({ compression: level })).compression, level);
  }
  for (const bad of [13, -1, 4.5, 'x']) {
    throwsCode(() => validateCdJob(validJob({ compression: bad })), 'FFGUI_CD_INVALID_JOB');
  }
  assert.equal(validateCdJob(validJob({ compression: undefined })).compression, 8, '缺省用 8');
  for (const mode of ['disable', 'verify', 'overlap', 'neverskip', 'full']) {
    assert.equal(validateCdJob(validJob({ paranoiaMode: mode })).paranoiaMode, mode);
  }
  throwsCode(() => validateCdJob(validJob({ paranoiaMode: 'bogus' })), 'FFGUI_CD_INVALID_JOB');
});

test('任务校验：轨的起止时间必须合法（盘可能已被更换）', () => {
  throwsCode(() => validateCdJob(validJob({
    tracks: [{ number: 1, start: 10, end: 5 }],
  })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({
    tracks: [{ number: 1, start: -1, end: 5 }],
  })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({
    tracks: [{ number: 0, start: 0, end: 5 }],
  })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({
    tracks: [{ number: 100, start: 0, end: 5 }],
  })), 'FFGUI_CD_INVALID_JOB');
});

test('任务校验：元数据字段类型受检，逐曲覆盖按轨号归一', () => {
  throwsCode(() => validateCdJob(validJob({ metadata: 'x' })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ metadata: { album: 1 } })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ metadata: { tracks: [] } })), 'FFGUI_CD_INVALID_JOB');
  throwsCode(() => validateCdJob(validJob({ metadata: { tracks: { 1: 'x' } } })), 'FFGUI_CD_INVALID_JOB');
  const job = validateCdJob(validJob({
    metadata: { album: 'A', tracks: { 2: { title: 'T2' }, 99: { title: 'T99' } } },
  }));
  assert.equal(job.metadata.tracks['2'].title, 'T2');
  assert.equal(job.metadata.tracks['99'].title, 'T99');
});

test('任务校验：曲目按轨号排序提交（与抓取顺序无关）', () => {
  const job = validateCdJob(validJob({
    tracks: [
      { number: 3, start: 20, end: 30 },
      { number: 1, start: 0, end: 10 },
      { number: 2, start: 10, end: 20 },
    ],
  }));
  assert.deepEqual(job.tracks.map((t) => t.number), [1, 2, 3]);
});

// ---------- FLAC 命令组装 ----------

test('FLAC 参数：锁定 s16/44100/立体声，只传 -n 不传 -y', () => {
  const args = buildCdTrackArgs({
    device: 'E:',
    track: { number: 1, start: 4.053333, end: 201.106667, duration: 197.053334 },
    output: 'C:\\out\\A - 01.flac',
    compression: 8,
    paranoiaMode: 'disable',
  });
  assert.equal(args[0], '-hide_banner');
  assert.equal(args[1], '-f');
  assert.equal(args[2], 'libcdio');
  // -ss 必须在 -i 之前（libcdio 支持快速定位，避免从头读整盘）
  const ssIdx = args.indexOf('-ss');
  const iIdx = args.indexOf('-i');
  assert.ok(ssIdx > 2 && ssIdx < iIdx, '-ss 须在 -i 之前');
  assert.equal(args[ssIdx + 1], '4.053333');
  assert.equal(args[iIdx + 1], 'E:');
  assert.equal(args[args.indexOf('-c:a') + 1], 'flac');
  assert.equal(args[args.indexOf('-sample_fmt') + 1], 's16');
  assert.equal(args[args.indexOf('-ar') + 1], '44100');
  assert.equal(args[args.indexOf('-ac') + 1], '2');
  assert.equal(args[args.indexOf('-compression_level') + 1], '8');
  // 时长用本轨的 end-start
  assert.equal(args[args.indexOf('-t') + 1], '197.053334');
  assert.ok(args.includes('-n'), '必须传 -n 防止覆盖已有文件');
  assert.ok(!args.includes('-y'), '不能同时传 -y（与 -n 互斥，ffmpeg 直接失败）');
  assert.equal(args[args.length - 1], 'C:\\out\\A - 01.flac');
  assert.ok(args.includes('-progress') && args[args.indexOf('-progress') + 1] === 'pipe:1');
  // 关闭纠错时不出现 -paranoia_mode
  assert.ok(!args.includes('-paranoia_mode'));
});

// 这两条是端到端跑出来的回归：半成品后缀让 ffmpeg 推不出封装，
// 元数据放错侧会被当成输入选项，两者都会让抓取静默失败。
test('FLAC 参数：半成品输出必须显式 -f flac（扩展名推不出封装）', () => {
  const args = buildCdTrackArgs({
    device: 'E:',
    track: { number: 1, start: 0, end: 10, duration: 10 },
    output: 'C:\\out\\A - 01.flac.ffgui-partial',
    compression: 8,
    paranoiaMode: 'disable',
  });
  assert.ok(args.includes('-f'), '必须显式指定封装');
  // -f 出现两次：一次是输入的 libcdio，一次是输出的 flac
  const fIdx = [];
  args.forEach((a, i) => { if (a === '-f') fIdx.push(i); });
  assert.equal(fIdx.length, 2, '输入 -f libcdio 与输出 -f flac 各一次');
  assert.equal(args[fIdx[1] + 1], 'flac', '输出的 -f 必须是 flac');
  // 输出侧 -f 必须在最后一个 -i 之后
  assert.ok(fIdx[1] > args.indexOf('-i'), '输出 -f 须在 -i 之后');
});

test('FLAC 参数：元数据放在 -i 之后（否则被当成输入选项而失败）', () => {
  const args = buildCdTrackArgs({
    device: 'E:',
    track: { number: 1, start: 0, end: 10, duration: 10 },
    output: 'C:\\out\\A - 01.flac.ffgui-partial',
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'Album', artist: 'Artist', tracks: { 1: { title: 'T1' } } },
  });
  const iIdx = args.indexOf('-i');
  const metaIdx = args.indexOf('-metadata');
  assert.ok(metaIdx > iIdx, '所有 -metadata 都必须位于 -i 之后');
  // 且位于输出文件之前
  assert.ok(metaIdx < args.length - 1, '-metadata 须在输出路径之前');
  assert.ok(args.includes('album=Album'));
  assert.ok(args.includes('artist=Artist'));
  assert.ok(args.includes('title=T1'));
  assert.ok(args.includes('track=1'));
});

test('FLAC 参数：纠错模式开启时紧跟在 -f libcdio 之后', () => {
  const args = buildCdTrackArgs({
    device: '/dev/rdisk2',
    track: { number: 1, start: 0, end: 100, duration: 100 },
    output: '/tmp/a.flac',
    compression: 12,
    paranoiaMode: 'full',
  });
  const modeIdx = args.indexOf('-paranoia_mode');
  assert.ok(modeIdx > 2, '-paranoia_mode 须在 -f libcdio 之后');
  assert.equal(args[modeIdx + 1], 'full');
  assert.equal(args[args.indexOf('-compression_level') + 1], '12');
});

test('FLAC 元数据：专辑级字段 + 每轨覆盖，空值不写入', () => {
  const metadata = {
    album: 'Album', albumArtist: 'AA', artist: 'Default',
    date: '2024', genre: 'Pop', disc: '1', barcode: '123', comment: 'c',
    tracks: { 2: { title: 'Real Title', artist: 'Guest' } },
  };
  const args = buildMetadataArgs({ number: 2, title: '', duration: 0 }, metadata);
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], '-metadata');
    pairs.push(args[i + 1]);
  }
  assert.ok(pairs.includes('album=Album'));
  assert.ok(pairs.includes('album_artist=AA'));
  // 每轨演唱者优先于专辑默认值
  assert.ok(pairs.includes('artist=Guest'));
  assert.ok(pairs.includes('title=Real Title'));
  assert.ok(pairs.includes('track=2'));
  assert.ok(pairs.includes('date=2024'));
  assert.ok(pairs.includes('genre=Pop'));
  assert.ok(pairs.includes('disc=1'));
  assert.ok(pairs.includes('barcode=123'));
  assert.ok(pairs.includes('comment=c'));
  // 无元数据时不产生任何 -metadata
  assert.deepEqual(buildMetadataArgs({ number: 1 }, null), []);
  // 每轨未覆盖时用曲目自带标题
  const fallback = buildMetadataArgs({ number: 1, title: 'From Disc' }, metadata);
  assert.ok(fallback.includes('title=From Disc'));
  assert.ok(fallback.includes('artist=Default'));
});

test('FLAC 元数据：空专辑级字段被跳过', () => {
  const args = buildMetadataArgs({ number: 1, title: 'T' }, {
    album: '', artist: '', date: '', tracks: {},
  });
  assert.ok(args.includes('title=T'));
  assert.ok(args.includes('track=1'));
  assert.ok(!args.some((a) => a.startsWith('album=')));
  assert.ok(!args.some((a) => a.startsWith('artist=')));
});

// ---------- 抓取任务（mock spawn） ----------

function loadService(options = {}) {
  const dir = tempDir();
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const events = [];
  const spawned = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel, event) => {
      assert.equal(channel, 'ffgui:cd-event');
      events.push(event);
    },
  };

  // 用 vm 加载模块，替换 require('./ffmpeg') 与 child_process.spawn
  const ctx = {
    require: (name) => {
      if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => repo } };
      if (name === './i18n') return require(path.join(repo, 'main', 'i18n.js'));
      if (name === './ffmpeg') {
        return { getFfmpegPath: () => 'ffmpeg-mock' };
      }
      if (name === 'child_process') {
        return { spawn: (cmd, args) => spawnMock(cmd, args) };
      }
      return require(name);
    },
    process, console: { log() {}, error() {} }, module: { exports: {} },
    __dirname: path.join(repo, 'main'),
  };

  // 默认 mock：写出半成品文件，再立刻退出码 0 并补一条 progress=end
  function spawnMock(cmd, args) {
    const child = new EventEmitter();
    const record = { cmd, args, killed: false, child };
    spawned.push(record);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { record.killed = true; };
    const behavior = options.spawn || (() => {
      const output = record.args[record.args.length - 1];
      fs.writeFileSync(output, 'flac-bytes');
      return { code: 0, output };
    });
    setImmediate(() => {
      const result = behavior(record);
      if (result && result.progress !== false) {
        child.stdout.emit('data', Buffer.from('out_time=00:00:01.000000\nprogress=continue\n'));
        child.stdout.emit('data', Buffer.from('progress=end\n'));
      }
      child.emit('close', result && result.code !== undefined ? result.code : 0);
    });
    return child;
  }

  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(repo, 'main', 'cdrip.js'), 'utf8')
    + '\nmodule.exports = { createCdService, validateCdJob };',
    ctx,
  );
  const service = ctx.module.exports.createCdService({ fs });
  return { dir, out, events, spawned, sender, service };
}

test('抓取任务：逐轨生成 FLAC，进度与完成事件齐全', async () => {
  const h = loadService();
  const result = await h.service.start(h.sender, {
    id: 'job-1',
    device: 'e:',
    outputDir: h.out,
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'Album' },
    tracks: [
      { number: 1, start: 0, end: 4.05 },
      { number: 2, start: 4.05, end: 201.1 },
    ],
  });
  assert.equal(result.total, 2);
  assert.equal(result.done, 2);
  assert.equal(result.cancelled, false);
  // vm 里构造的数组原型与本 realm 不同，deepEqual 会误判，按长度断言
  assert.equal(result.errors.length, 0);
  assert.equal(h.spawned.length, 2, '两轨各 spawn 一次');

  // ffmpeg 写的是 .ffgui-partial 半成品，成功后由主进程改名为最终输出
  assert.equal(path.basename(h.spawned[0].args[h.spawned[0].args.length - 1]), 'Album - 01.flac.ffgui-partial');
  assert.equal(path.basename(h.spawned[1].args[h.spawned[1].args.length - 1]), 'Album - 02.flac.ffgui-partial');
  assert.equal(h.spawned[1].args[h.spawned[1].args.indexOf('-ss') + 1], '4.05');

  const types = h.events.map((e) => e.type);
  assert.equal(types[0], 'start');
  assert.ok(types.includes('track-start'));
  assert.ok(types.includes('progress'));
  assert.equal(types[types.length - 1], 'done');
  const done = h.events.filter((e) => e.type === 'track-done');
  assert.equal(done.length, 2);
  // 半成品改名后输出真实存在，且不残留 .ffgui-partial
  assert.ok(fs.existsSync(path.join(h.out, 'Album - 01.flac')));
  assert.ok(fs.existsSync(path.join(h.out, 'Album - 02.flac')));
  assert.ok(!fs.existsSync(path.join(h.out, 'Album - 01.flac.ffgui-partial')));
});

test('抓取任务：已有同名文件时追加编号，不覆盖', async () => {
  const h = loadService();
  // 预置两个同名目标，第三个才落到新名字
  fs.writeFileSync(path.join(h.out, 'Album - 01.flac'), 'existing');
  const result = await h.service.start(h.sender, {
    id: 'job-1',
    device: 'E:',
    outputDir: h.out,
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'Album' },
    tracks: [{ number: 1, start: 0, end: 4.05 }],
  });
  assert.equal(result.done, 1);
  assert.equal(fs.readFileSync(path.join(h.out, 'Album - 01.flac'), 'utf8'), 'existing',
    '已存在的文件不得被覆盖');
  assert.ok(fs.existsSync(path.join(h.out, 'Album - 01_2.flac')), '应落到 _2 编号');
});

test('抓取任务：ffmpeg 失败时记录错误并清理半成品', async () => {
  const h = loadService({
    spawn: (record) => {
      const output = record.args[record.args.length - 1];
      // 写出半成品但从未收到 progress=end（模拟 -n 拒绝覆盖或中途失败）
      fs.writeFileSync(output, 'partial');
      return { code: 1, output };
    },
  });
  const result = await h.service.start(h.sender, {
    id: 'job-1',
    device: 'E:',
    outputDir: h.out,
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'Album' },
    tracks: [{ number: 1, start: 0, end: 4.05 }],
  });
  assert.equal(result.done, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'FFGUI_CD_RIP_FAILED');
  const errorEvent = h.events.find((e) => e.type === 'track-error');
  assert.ok(errorEvent, '应发 track-error 事件');
  // 半成品与最终输出都不该残留
  assert.ok(!fs.existsSync(path.join(h.out, 'Album - 01.flac')));
  assert.ok(!fs.existsSync(path.join(h.out, 'Album - 01.flac.ffgui-partial')));
});

test('抓取任务：取消时 kill 子进程并清理半成品', async () => {
  let capturedService = null;
  const h = loadService({
    spawn: (record) => {
      // 不自动结束：等外部 cancel
      capturedService = h.service;
      return { code: 0, progress: false };
    },
  });
  const promise = h.service.start(h.sender, {
    id: 'job-1',
    device: 'E:',
    outputDir: h.out,
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'Album' },
    tracks: [{ number: 1, start: 0, end: 4.05 }],
  });
  // 轮询等 spawn 真正发生（start 内部有 await，两个 setImmediate 不够稳）
  for (let i = 0; i < 200 && h.spawned.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(h.spawned.length, 1, '应已 spawn');
  assert.equal(h.service.cancel('job-1'), true, 'cancel 应命中当前任务');
  assert.equal(h.spawned[0].killed, true, '子进程应被 kill');
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.done, 0);
  assert.ok(!fs.existsSync(path.join(h.out, 'Album - 01.flac')), '取消后不得留下输出');
});

test('抓取任务：并发第二个任务被拒（全局单任务）', async () => {
  const h = loadService({ spawn: () => ({ code: 0, progress: false }) });
  const first = h.service.start(h.sender, {
    id: 'job-1', device: 'E:', outputDir: h.out, compression: 8,
    paranoiaMode: 'disable', metadata: null,
    tracks: [{ number: 1, start: 0, end: 4.05 }],
  });
  await assert.rejects(() => h.service.start(h.sender, {
    id: 'job-2', device: 'E:', outputDir: h.out, compression: 8,
    paranoiaMode: 'disable', metadata: null,
    tracks: [{ number: 1, start: 0, end: 4.05 }],
  }), (err) => {
    assert.equal(err.code, 'FFGUI_CD_BUSY');
    return true;
  });
  h.service.cancel('job-1');
  await first;
});

test('抓取任务：输出目录不可用时报 FFGUI_CD_OUTPUT_DIR', async () => {
  const h = loadService();
  await assert.rejects(() => h.service.start(h.sender, {
    id: 'job-1', device: 'E:', outputDir: path.join(h.dir, 'no-such-dir'),
    compression: 8, paranoiaMode: 'disable', metadata: null,
    tracks: [{ number: 1, start: 0, end: 4.05 }],
  }), (err) => {
    assert.equal(err.code, 'FFGUI_CD_OUTPUT_DIR');
    return true;
  });
});

// ---------- 探测 ----------

test('探测：无光盘时给出 FFGUI_CD_NO_DISC', async () => {
  const dir = tempDir();
  const ctx = {
    require: (name) => {
      if (name === './i18n') return require(path.join(repo, 'main', 'i18n.js'));
      if (name === './ffmpeg') return { getFfmpegPath: () => 'ffmpeg-mock' };
      if (name === 'child_process') {
        return {
          spawn: () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => {
              child.stderr.emit('data', Buffer.from('++ WARN: could not read TOC\n'));
              child.emit('close', 1);
            });
            return child;
          },
        };
      }
      return require(name);
    },
    process, console: { log() {}, error() {} }, module: { exports: {} },
    __dirname: path.join(repo, 'main'),
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(repo, 'main', 'cdrip.js'), 'utf8')
    + '\nmodule.exports = { createCdService };',
    ctx,
  );
  const service = ctx.module.exports.createCdService({ fs });
  await assert.rejects(() => service.probe({ device: 'E:' }), (err) => {
    assert.equal(err.code, 'FFGUI_CD_NO_DISC');
    return true;
  });
});

// ---------- 光驱枚举（mock 侧车） ----------
// listCdDrives 定义在 registerCdIpc 内部，只能经 vm 加载捕获
// ffgui:cd-list-drives handler 来调；侧车 createDiscService 被桩成假实现，
// electron 桩负责收集 ipcMain.handle 注册的 handler 表。

function loadCdIpcHandlers(options = {}) {
  const handlers = {};
  const ctx = {
    require: (name) => {
      if (name === 'electron') {
        return {
          app: { isPackaged: false, getAppPath: () => repo },
          ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
        };
      }
      if (name === './i18n') return require(path.join(repo, 'main', 'i18n.js'));
      if (name === './ffmpeg') {
        return { getFfmpegPath: () => 'ffmpeg-mock' };
      }
      if (name === './disc') {
        return {
          createDiscService: () => ({
            listDrives: options.listDrives || (async () => ({ drives: [] })),
          }),
        };
      }
      if (name === 'child_process') {
        return { spawn: () => { throw new Error('光驱枚举不应 spawn ffmpeg'); } };
      }
      return require(name);
    },
    process, console: { log() {}, error() {} }, module: { exports: {} },
    __dirname: path.join(repo, 'main'),
  };

  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(repo, 'main', 'cdrip.js'), 'utf8')
    + '\nmodule.exports = { registerCdIpc };',
    ctx,
  );
  ctx.module.exports.registerCdIpc();
  return handlers;
}

test('光驱枚举：侧车 path 换算为 libcdio 设备名（本机 win32）', async () => {
  const handlers = loadCdIpcHandlers({
    listDrives: async () => ({
      drives: [
        { kind: 'drive', path: '\\\\.\\E:', label: 'Audio CD' },
        { kind: 'drive', path: '\\\\.\\F:', label: '' },        // CdRomN 形态 libcdio 打不开，换算为空、整行跳过
        { kind: 'drive', path: '\\\\.\\CdRom0', label: 'CdRom0' },
        // label 不是字符串时回退 device，不让界面拿到 undefined
        { kind: 'drive', path: '\\\\.\\G:' },
      ],
    }),
  });
  const result = await handlers['ffgui:cd-list-drives']();
  // vm 里构造的对象原型与本 realm 不同，deepEqual 会误判，按字段断言
  assert.equal(result.drives.length, 3);
  assert.equal(result.drives[0].device, 'E:');
  assert.equal(result.drives[0].label, 'Audio CD');
  assert.equal(result.drives[0].vendor, '');
  assert.equal(result.drives[0].model, '');
  assert.equal(result.drives[1].device, 'F:');
  // label 是字符串（哪怕是空串）就原样采用，只有非字符串才回退 device
  assert.equal(result.drives[1].label, '');
  assert.equal(result.drives[2].device, 'G:');
  assert.equal(result.drives[2].label, 'G:');
});

test('光驱枚举：侧车返回结构化 code 时原样透传', async () => {
  const handlers = loadCdIpcHandlers({
    listDrives: async () => ({ drives: [], code: 'FFGUI_UNSUPPORTED' }),
  });
  const result = await handlers['ffgui:cd-list-drives']();
  assert.equal(result.drives.length, 0);
  assert.equal(result.code, 'FFGUI_UNSUPPORTED');
});

test('光驱枚举：侧车调用抛错时归一为 FFGUI_CD_DRIVES_FAILED', async () => {
  const handlers = loadCdIpcHandlers({
    listDrives: async () => { throw new Error('sidecar gone'); },
  });
  const result = await handlers['ffgui:cd-list-drives']();
  assert.equal(result.drives.length, 0);
  assert.equal(result.code, 'FFGUI_CD_DRIVES_FAILED');
  assert.equal(result.message, 'sidecar gone');
});

// ---------- 真实 ffmpeg 集成 ----------
// 上面全部测试都 mock 了 spawn，看不见「命令根本跑不通」这类问题
// （半成品后缀推不出封装、元数据放错侧都会被 mock 掩盖）。
// 这里用真实 ffmpeg 实跑一次：没有光驱，所以拿一个 CD 规格的音频文件
// 代替 libcdio 设备，验证的是除 `-f libcdio -i <device>` 之外的整条命令链。
const { execFileSync, spawnSync } = require('node:child_process');
const REAL_FFMPEG = process.env.FFMPEG || path.join(repo, 'bin', 'ffmpeg.exe');
const hasRealFfmpeg = fs.existsSync(REAL_FFMPEG);
// 与 main/cdrip.js 的 PARTIAL_SUFFIX 保持一致
const PARTIAL_SUFFIX = '.ffgui-partial';

test('真实 ffmpeg：整条抓取命令链能产出带标签的 FLAC', { skip: !hasRealFfmpeg && '未找到 bin/ffmpeg.exe' }, () => {
  const dir = tempDir();
  const src = path.join(dir, 'source.wav');
  // 生成 CD 规格测试源：44.1kHz / 16bit / 立体声，5 秒
  execFileSync(REAL_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=5:sample_rate=44100',
    '-ac', '2', '-c:a', 'pcm_s16le', '-y', src]);

  const out = path.join(dir, 'Album - 01.flac');
  let args = buildCdTrackArgs({
    device: src, // 真实环境是 libcdio 设备名；这里用文件路径验证其余参数
    track: { number: 1, start: 1, end: 4, duration: 3 },
    output: `${out}${PARTIAL_SUFFIX}`,
    compression: 8,
    paranoiaMode: 'disable',
    metadata: { album: 'E2E Album', artist: 'E2E Artist', date: '2024', genre: 'Pop', tracks: { 1: { title: 'E2E Track' } } },
  });
  // 去掉输入侧的 -f libcdio，改用普通文件输入
  args.splice(args.indexOf('-f'), 2);

  const run = spawnSync(REAL_FFMPEG, args, { encoding: 'utf8' });
  assert.equal(run.status, 0, `ffmpeg 应成功，stderr: ${(run.stderr || '').slice(-400)}`);
  assert.ok(fs.existsSync(`${out}${PARTIAL_SUFFIX}`), '应写出半成品文件');

  // 半成品改名后即为最终输出（与主进程 rename 逻辑一致）
  fs.renameSync(`${out}${PARTIAL_SUFFIX}`, out);
  const probe = spawnSync(REAL_FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' });
  const text = probe.stderr || '';
  // 规格必须是 CD 原生参数：FLAC / 44100Hz / 立体声 / s16
  assert.match(text, /Audio: flac, 44100 Hz, stereo, s16/);
  // 时长按 -ss 1 -t 3 截取
  assert.match(text, /Duration: 00:00:03\.00/);
  // 全部标签都要真的写进文件
  for (const tag of ['album', 'artist', 'title', 'track', 'date', 'genre']) {
    assert.match(text, new RegExp(`^\\s+${tag}\\s+:`, 'm'), `标签 ${tag} 必须写入`);
  }
  assert.match(text, /album\s+:\s+E2E Album/);
  assert.match(text, /title\s+:\s+E2E Track/);
});
