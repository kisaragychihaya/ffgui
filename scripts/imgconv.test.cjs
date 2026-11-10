'use strict';

// 运行：node --test scripts/imgconv.test.cjs
// 图片格式互转主进程测试：vm 沙箱加载 main/imgconv.js，注入假 electron、
// i18n、ffmpeg 与 child_process.spawn，覆盖八种格式的参数组装、画质档、
// 任务编排与 IPC 注册；最后一个用例在有 ffmpeg 时实跑 PNG → ICO。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'main', 'imgconv.js'), 'utf8');
const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-imgconv-'));
  tempRoots.push(dir);
  return dir;
}

const i18nKeys = [];
const i18n = {
  t: (key, vars) => {
    i18nKeys.push(key);
    return vars ? `${key} ${JSON.stringify(vars)}` : `文案:${key}`;
  },
};

function createFfmpegStub(options = {}) {
  const calls = { run: [], outputs: [], cancel: 0, reset: 0 };
  const stub = {
    calls,
    runFfmpegTask: async (task) => {
      calls.run.push(task);
      if (options.runTask) return options.runTask(task);
      return options.runResult || { ok: true, cancelled: false };
    },
    buildOutputPath: (input, outputDir, format, reserved) => {
      const dir = outputDir || path.dirname(input);
      const output = path.join(dir, `${path.basename(input, path.extname(input))}_ffgui.${format}`);
      calls.outputs.push({ input, outputDir, format, reserved, output });
      return output;
    },
    cancelCurrentTask: () => { calls.cancel += 1; },
    resetCancel: () => { calls.reset += 1; },
    isCancelled: () => Boolean(options.cancelled),
  };
  return stub;
}

function loadImgconv(options = {}) {
  const stub = options.ffmpeg || createFfmpegStub(options);
  const handlers = {};
  const spawns = [];
  const openedDialogs = [];
  const electron = {
    app: { isPackaged: false, getAppPath: () => repo },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    dialog: {
      showOpenDialog: async (win, opts) => {
        openedDialogs.push({ win, opts });
        return options.dialogResult || { canceled: false, filePaths: ['a.png', 'b.jpg'] };
      },
    },
    BrowserWindow: { fromWebContents: (sender) => ({ sender }) },
  };
  const ctx = {
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === './i18n') return i18n;
      if (name === './ffmpeg') return stub;
      if (name === 'child_process') {
        return {
          spawn: (cmd, args) => {
            spawns.push({ cmd, args });
            return new EventEmitter();
          },
        };
      }
      return require(name);
    },
    process, console: { log() {}, error() {} }, module: { exports: {} },
    __dirname: path.join(repo, 'main'),
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return {
    api: ctx.module.exports,
    stub,
    handlers,
    spawns,
    openedDialogs,
    electron,
  };
}

const { api } = loadImgconv();
const INPUT = 'C:\\pics\\source.png';
const OUTPUT = 'C:\\pics\\out.bin';

function argsFor(format, quality) {
  const job = quality === undefined ? { format } : { format, quality };
  return api.buildImageArgs(job, INPUT, OUTPUT);
}

function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `缺少参数 ${flag}`);
  return args[i + 1];
}

function assertCommon(args, fmt) {
  assert.equal(args[0], '-hide_banner', `${fmt}: 应以 -hide_banner 开头`);
  assert.ok(args.includes('-n'), `${fmt}: 必须带 -n 防止覆盖`);
  assert.ok(!args.includes('-y'), `${fmt}: 不得无条件覆盖`);
  assert.equal(args.indexOf('-i'), 2, `${fmt}: -i 应在基础参数之后`);
  assert.equal(valueAfter(args, '-i'), INPUT, `${fmt}: 输入路径`);
  assert.equal(valueAfter(args, '-frames:v'), '1', `${fmt}: 动图只取首帧`);
  assert.ok(args.includes('-nostats'), `${fmt}: 应关闭默认统计输出`);
  assert.equal(valueAfter(args, '-progress'), 'pipe:1', `${fmt}: 进度走 stdout`);
  assert.equal(args.at(-1), OUTPUT, `${fmt}: 输出路径须在末尾`);
}

test('导出：八种格式集合与画质档映射固定', () => {
  const expected = ['webp', 'jpg', 'png', 'ico', 'bmp', 'gif', 'tif', 'tga'];
  assert.equal(api.IMAGE_FORMATS.size, 8);
  for (const fmt of expected) assert.ok(api.IMAGE_FORMATS.has(fmt), `缺格式 ${fmt}`);
  assert.equal(api.QUALITY_MAP.jpg.high, '2', 'jpg 数值越小画质越高');
  assert.equal(api.QUALITY_MAP.jpg.medium, '5');
  assert.equal(api.QUALITY_MAP.jpg.low, '8');
  assert.equal(api.QUALITY_MAP.webp.high, '90', 'webp 数值越大画质越高');
  assert.equal(api.QUALITY_MAP.webp.medium, '75');
  assert.equal(api.QUALITY_MAP.webp.low, '60');
});

test('JPG：mjpeg 编码器、质量档与 -update 1', () => {
  for (const [quality, expected] of Object.entries(api.QUALITY_MAP.jpg)) {
    const args = argsFor('jpg', quality);
    assertCommon(args, `jpg/${quality}`);
    assert.equal(valueAfter(args, '-c:v'), 'mjpeg', `jpg/${quality}: 编码器`);
    assert.equal(valueAfter(args, '-q:v'), expected, `jpg/${quality}: 画质值`);
    assert.equal(valueAfter(args, '-update'), '1', `jpg/${quality}: 单文件输出`);
  }
});

test('PNG / BMP：各自编码器与 -update 1', () => {
  for (const [format, codec] of [['png', 'png'], ['bmp', 'bmp']]) {
    const args = argsFor(format);
    assertCommon(args, format);
    assert.equal(valueAfter(args, '-c:v'), codec, `${format}: 编码器`);
    assert.equal(valueAfter(args, '-update'), '1', `${format}: 单文件输出`);
  }
});

test('TIF / TGA：tiff / targa 编码器与 -update 1', () => {
  for (const [format, codec] of [['tif', 'tiff'], ['tga', 'targa']]) {
    const args = argsFor(format);
    assertCommon(args, format);
    assert.equal(valueAfter(args, '-c:v'), codec, `${format}: 编码器`);
    assert.equal(valueAfter(args, '-update'), '1', `${format}: 单文件输出`);
  }
});

test('WebP：libwebp 编码器、质量档且不带 -update', () => {
  for (const [quality, expected] of Object.entries(api.QUALITY_MAP.webp)) {
    const args = argsFor('webp', quality);
    assertCommon(args, `webp/${quality}`);
    assert.equal(valueAfter(args, '-c:v'), 'libwebp', `webp/${quality}: 编码器`);
    assert.equal(valueAfter(args, '-quality'), expected, `webp/${quality}: 画质值`);
    assert.ok(!args.includes('-update'), `webp/${quality}: 独立封装器不需要 -update`);
  }
});

test('GIF：gif 编码器，不带 -update', () => {
  const args = argsFor('gif');
  assertCommon(args, 'gif');
  assert.equal(valueAfter(args, '-c:v'), 'gif');
  assert.ok(!args.includes('-update'), 'gif 封装器不需要 -update');
});

test('ICO：scale 限制 256 边长、bmp 编码器且不带 -update', () => {
  const args = argsFor('ico');
  assertCommon(args, 'ico');
  const scale = valueAfter(args, '-vf');
  assert.match(scale, /min\(256,iw\)/, '宽度须限制到 256');
  assert.match(scale, /min\(256,ih\)/, '高度须限制到 256');
  assert.match(scale, /force_original_aspect_ratio=decrease/, '缩放须保持比例');
  assert.equal(valueAfter(args, '-c:v'), 'bmp');
  assert.ok(!args.includes('-update'), 'ico 封装器不需要 -update');
});

test('画质缺省按 medium，空串等同缺省，三档均合法', () => {
  const defaults = [
    api.buildImageArgs({ format: 'jpg' }, INPUT, OUTPUT),
    api.buildImageArgs({ format: 'jpg', quality: undefined }, INPUT, OUTPUT),
    api.buildImageArgs({ format: 'jpg', quality: null }, INPUT, OUTPUT),
    api.buildImageArgs({ format: 'jpg', quality: '' }, INPUT, OUTPUT),
    api.buildImageArgs({ format: 'jpg', quality: 'medium' }, INPUT, OUTPUT),
  ];
  for (const args of defaults) {
    assert.equal(valueAfter(args, '-q:v'), api.QUALITY_MAP.jpg.medium);
  }
  assert.equal(valueAfter(argsFor('webp'), '-quality'), api.QUALITY_MAP.webp.medium);
  for (const quality of ['high', 'medium', 'low']) {
    assert.equal(valueAfter(argsFor('jpg', quality), '-q:v'), api.QUALITY_MAP.jpg[quality]);
    assert.equal(valueAfter(argsFor('webp', quality), '-quality'), api.QUALITY_MAP.webp[quality]);
    assertCommon(argsFor('png', quality), `png/${quality}`);
  }
});

test('非法格式与画质抛本地化错误，且错误前不产生命令', () => {
  const before = i18nKeys.length;
  for (const value of ['', 'jpeg', 'JPG', 'mp4', null, undefined, 42, {}, []]) {
    assert.throws(() => api.buildImageArgs({ format: value }, INPUT, OUTPUT),
      (err) => Boolean(err && /main\.err\.imgconvFormat/.test(err.message)),
      `非法格式 ${JSON.stringify(value)} 应抛错`);
  }
  for (const value of ['best', 'HIGH', 0, 1, {}, []]) {
    assert.throws(() => api.buildImageArgs({ format: 'jpg', quality: value }, INPUT, OUTPUT),
      (err) => Boolean(err && /main\.err\.imgconvQuality/.test(err.message)),
      `非法画质 ${JSON.stringify(value)} 应抛错`);
  }
  assert.throws(() => api.buildImageArgs(null, INPUT, OUTPUT), /main\.err\.imgconvFormat/);
  const keys = i18nKeys.slice(before);
  assert.ok(keys.every((key) => key.startsWith('main.err.imgconv')),
    '错误文案须经 t() 取主进程词典键');
  assert.equal(keys.filter((key) => key === 'main.err.imgconvFormat').length, 10);
  assert.equal(keys.filter((key) => key === 'main.err.imgconvQuality').length, 6);
});

test('批量任务：重置取消标记、逐文件分配输出并复用 ffmpeg 任务执行器', async () => {
  const h = loadImgconv();
  const sender = { isDestroyed: () => false, send: () => {} };
  const job = { inputs: [INPUT, 'C:\\pics\\second.gif'], format: 'ico', outputDir: 'C:\\out' };
  const result = await h.api.runImgconv(sender, job);
  assert.equal(result.total, 2);
  assert.equal(result.done, 2);
  assert.equal(result.cancelled, false);
  assert.equal(h.stub.calls.reset, 1, '开始任务时须清掉上一轮取消标记');
  assert.equal(h.stub.calls.outputs.length, 2);
  assert.equal(h.stub.calls.outputs[0].format, 'ico');
  assert.equal(h.stub.calls.run.length, 2);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(h.stub.calls.outputs[i].outputDir, job.outputDir);
    assert.equal(h.stub.calls.outputs[i].output.startsWith(job.outputDir), true);
    assert.equal(h.stub.calls.run[i].label, job.inputs[i]);
    assert.equal(h.stub.calls.run[i].output, h.stub.calls.outputs[i].output);
    assert.equal(h.stub.calls.run[i].getDuration(), 0, '图片任务无时长');
    assert.equal(h.stub.calls.run[i].args.at(-1), h.stub.calls.run[i].output);
    assert.equal(h.stub.calls.run[i].args[3], job.inputs[i]);
    assert.equal(h.stub.calls.run[i].taskName, '图片转换');
  }
  assert.equal(h.spawns.length, 0, '本模块不得自行 spawn ffmpeg');
});

test('批量任务：事件走独立频道，销毁的发送者不再收到事件', async () => {
  const events = [];
  const h = loadImgconv({
    runTask: (task) => {
      task.send({ type: 'file-done', index: task.index, input: task.label, output: task.output });
      return { ok: true, cancelled: false };
    },
  });
  const sender = {
    isDestroyed: () => false,
    send: (channel, event) => events.push({ channel, event }),
  };
  // runFfmpegTask 桩通过 send 回调送一条事件，验证频道与透传
  await h.api.runImgconv(sender, { inputs: [INPUT], format: 'png' });
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'ffgui:imgconv-event');
  assert.equal(events[0].event.type, 'file-done');
  assert.equal(events[0].event.input, INPUT);

  const destroyed = loadImgconv();
  let sent = 0;
  await destroyed.api.runImgconv({ isDestroyed: () => true, send: () => { sent += 1; } },
    { inputs: [], format: 'png' });
  assert.equal(sent, 0, '窗口销毁后不得 send');
});

test('批量任务：无输入与非法格式各发一次错误事件，不启动转换', async () => {
  for (const job of [{ inputs: [], format: 'png' }, { inputs: [INPUT], format: 'foo' }]) {
    const h = loadImgconv();
    const events = [];
    const result = await h.api.runImgconv(
      { isDestroyed: () => false, send: (channel, event) => events.push({ channel, event }) }, job);
    assert.equal(result.done, 0);
    assert.equal(result.cancelled, false);
    assert.equal(h.stub.calls.run.length, 0, '参数不合法时不应启动 ffmpeg 任务');
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'ffgui:imgconv-event');
    assert.equal(events[0].event.type, 'file-error');
    assert.match(events[0].event.error, /main\.err\.imgconv(NoInput|Format)/);
  }
});

test('批量任务：取消时停止后续文件并透传取消结果', async () => {
  const h = loadImgconv({ cancelled: true });
  const result = await h.api.runImgconv({ isDestroyed: () => true, send: () => {} },
    { inputs: [INPUT, 'C:\\pics\\second.png'], format: 'png' });
  assert.equal(result.cancelled, false, '尚未启动文件时不凭标记自行宣称已取消');
  assert.equal(h.stub.calls.run.length, 0, '取消标记生效后不应再启动文件');
  assert.equal(result.done, 0);

  const cancelled = loadImgconv({
    runResult: { ok: false, cancelled: true },
  });
  const outcome = await cancelled.api.runImgconv({ isDestroyed: () => true, send: () => {} },
    { inputs: [INPUT, 'C:\\pics\\second.png'], format: 'png' });
  assert.equal(outcome.cancelled, true);
  assert.equal(cancelled.stub.calls.run.length, 1, '首个文件取消后不得继续下一个');
});

test('IPC：注册三个通道，图片多选、转换与取消分别接入', async () => {
  const h = loadImgconv();
  h.api.registerImgconvIpc();
  assert.deepEqual(Object.keys(h.handlers).sort(), [
    'ffgui:imgconv', 'ffgui:imgconv-cancel', 'ffgui:pickImageFiles',
  ]);

  const sender = { isDestroyed: () => false, send: () => {} };
  const files = await h.handlers['ffgui:pickImageFiles']({ sender });
  assert.equal(files.length, 2);
  assert.equal(h.openedDialogs.length, 1);
  const opts = h.openedDialogs[0].opts;
  assert.equal(h.openedDialogs[0].win.sender, sender, '对话框须挂在发起窗口');
  assert.match(opts.title, /main\.dialog\.pickImages/);
  // vm 里构造的数组与宿主 realm 原型不同，按元素逐项断言
  assert.equal(opts.properties.length, 2);
  assert.equal(opts.properties[0], 'openFile');
  assert.equal(opts.properties[1], 'multiSelections');
  assert.ok(opts.filters[0].extensions.includes('jpeg'));
  assert.ok(opts.filters[0].extensions.includes('tiff'));
  assert.match(opts.filters[0].name, /main\.dialog\.filterImages/);

  const result = await h.handlers['ffgui:imgconv']({ sender }, { inputs: [INPUT], format: 'png' });
  assert.equal(result.done, 1);
  assert.equal(h.stub.calls.run.length, 1);
  h.handlers['ffgui:imgconv-cancel']();
  assert.equal(h.stub.calls.cancel, 1, '取消须复用 ffmpeg 的共享任务句柄');
});

test('IPC：取消对话框返回空数组', async () => {
  const h = loadImgconv({ dialogResult: { canceled: true } });
  h.api.registerImgconvIpc();
  assert.equal((await h.handlers['ffgui:pickImageFiles']({ sender: {} })).length, 0);
});

// 真实 ffmpeg 集成：纯参数断言无法发现封装器不接受某组参数；用 lavfi 生成 PNG
// 后实跑 ICO 命令，验证输出文件存在且能被 ffmpeg 当作 ICO 解码。
const REAL_FFMPEG = process.env.FFMPEG || path.join(repo, 'bin', 'ffmpeg.exe');
const hasRealFfmpeg = fs.existsSync(REAL_FFMPEG);

test('真实 ffmpeg：lavfi PNG 经 ICO 参数产出可解码的单帧 ICO',
  { skip: !hasRealFfmpeg && '未找到 FFMPEG 或 bin/ffmpeg.exe' }, () => {
    const dir = tempDir();
    const src = path.join(dir, 'source.png');
    const out = path.join(dir, 'out.ico');
    const gen = spawnSync(REAL_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-frames:v', '1', src],
    { encoding: 'utf8', timeout: 30000 });
    assert.equal(gen.status, 0, `生成测试 PNG 失败：${gen.error || gen.stderr}`);

    const args = api.buildImageArgs({ format: 'ico' }, src, out);
    const run = spawnSync(REAL_FFMPEG, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `PNG → ICO 失败：${run.error || (run.stderr || '').slice(-400)}`);
    assert.ok(fs.existsSync(out), '应写出 ICO 文件');
    assert.equal(fs.readFileSync(out).readUInt16LE(2), 1, 'ICO 头应标记类型 1');
    assert.match(String(run.stdout), /progress=end/, '应收到 progress=end');

    const decode = spawnSync(REAL_FFMPEG, ['-hide_banner', '-i', out, '-frames:v', '1',
      '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(decode.status, 0, `ICO 解码失败：${decode.error || (decode.stderr || '').slice(-400)}`);
    assert.match(String(decode.stderr), /Input #0, ico/);
    assert.match(String(decode.stderr), /Video: bmp, bgr24, 256x192/,
      'scale 滤镜应把 320x240 等比缩到 256x192');
  });
