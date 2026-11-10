'use strict';

// 图片格式互转主进程模块：逐文件调用内置 ffmpeg，复用 main/ffmpeg.js 的
// runFfmpegTask（spawn / -progress 解析 / 取消清理）与 buildOutputPath（输出命名避让），
// 因此也共用 cancelCurrentTask 的取消标记，取消转换同样能中止图片任务。
// 内置 ffmpeg 支持 webp/jpg/png/ico/bmp/gif/tif/tga 八种格式的编解码与封装。

const path = require('path');
const { t } = require('./i18n');
const {
  runFfmpegTask, buildOutputPath, cancelCurrentTask, resetCancel, isCancelled,
} = require('./ffmpeg');

const IMAGE_FORMATS = new Set(['webp', 'jpg', 'png', 'ico', 'bmp', 'gif', 'tif', 'tga']);
// jpg 的 -q:v 越小画质越高；webp 的 -quality 越大画质越高
const QUALITY_MAP = {
  jpg: { high: '2', medium: '5', low: '8' },
  webp: { high: '90', medium: '75', low: '60' },
};
const QUALITY_LEVELS = new Set(['high', 'medium', 'low']);

// 组装单张图片的 ffmpeg 参数；动图输入（GIF/WebP）只取首帧。
// 纯函数：不读文件、不 spawn，供测试直接校验各格式的参数组合。
function buildImageArgs(job, input, outPath) {
  const format = job && job.format;
  if (!IMAGE_FORMATS.has(format)) throw new Error(t('main.err.imgconvFormat'));
  const quality = job.quality == null || job.quality === '' ? 'medium' : job.quality;
  if (!QUALITY_LEVELS.has(quality)) throw new Error(t('main.err.imgconvQuality'));

  const args = ['-hide_banner', '-n', '-i', input, '-frames:v', '1'];
  if (format === 'jpg') {
    // image2 系封装器单文件输出必须 -update 1，否则会写成带序号的图片序列
    args.push('-c:v', 'mjpeg', '-q:v', QUALITY_MAP.jpg[quality], '-update', '1');
  } else if (format === 'png') {
    args.push('-c:v', 'png', '-update', '1');
  } else if (format === 'bmp') {
    args.push('-c:v', 'bmp', '-update', '1');
  } else if (format === 'tif') {
    args.push('-c:v', 'tiff', '-update', '1');
  } else if (format === 'tga') {
    args.push('-c:v', 'targa', '-update', '1');
  } else if (format === 'webp') {
    // webp 有独立封装器，不需要 -update
    args.push('-c:v', 'libwebp', '-quality', QUALITY_MAP.webp[quality]);
  } else if (format === 'gif') {
    args.push('-c:v', 'gif');
  } else if (format === 'ico') {
    // ico 封装器限制边长 ≤256（用内嵌 bmp 编码器；png 内嵌会报 header 错误）
    args.push('-vf', "scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease",
      '-c:v', 'bmp');
  }
  args.push('-nostats', '-progress', 'pipe:1', outPath);
  return args;
}

// 与 ffmpeg.js 的 reserved 用同一套路径归一规则，避免输出撞上其他源文件
function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

// 批量转换：输出名沿用 buildOutputPath，进度/错误事件走独立频道。
// 返回 { total, done, cancelled }；取消标记由 ffmpeg.js 模块共享，从任务结果推断。
async function runImgconv(sender, job) {
  const inputs = Array.isArray(job && job.inputs) ? job.inputs : [];
  // 连续两次任务不能被上一轮的取消标记污染
  resetCancel();
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send('ffgui:imgconv-event', evt);
  };

  if (inputs.length === 0) {
    send({ type: 'file-error', index: 0, input: '', error: t('main.err.imgconvNoInput') });
    return { total: 0, done: 0, cancelled: false };
  }

  // 任务级参数先校验一次，避免每个文件都重复报同一个格式/画质错误
  try {
    buildImageArgs(job, inputs[0], '');
  } catch (err) {
    send({ type: 'file-error', index: 0, input: inputs[0], error: err.message });
    return { total: inputs.length, done: 0, cancelled: false };
  }

  const reserved = new Set(inputs.map(pathKey));
  const outputs = inputs.map((input) => buildOutputPath(input, job.outputDir, job.format, reserved));
  console.log(`[ffgui] 开始图片转换：共 ${inputs.length} 个文件 → ${job.format}`);
  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    // 与 ffmpeg.js 的 runJob 一致：文件间隙检查取消标记，取消后不再起新进程
    if (isCancelled()) break;
    const input = inputs[i];
    let args;
    try {
      args = buildImageArgs(job, input, outputs[i]);
    } catch (err) {
      send({ type: 'file-error', index: i, input, error: err.message });
      results.push({ ok: false });
      continue;
    }
    const result = await runFfmpegTask({
      args,
      index: i,
      label: input,
      output: outputs[i],
      // 图片无时长，进度百分比恒为 0，仅用 file-start/file-done/file-error 表示状态
      getDuration: () => 0,
      send,
      taskName: '图片转换',
    });
    results.push(result);
    if (result.cancelled) break;
  }
  const done = results.filter((r) => r && r.ok).length;
  const cancelled = results.some((r) => r && r.cancelled);
  return { total: inputs.length, done, cancelled };
}

function registerImgconvIpc() {
  // 与 main/disc.js 一致：Electron 的 IPC 依赖在函数内取，便于测试用最小 mock 加载模块
  const { ipcMain, dialog, BrowserWindow } = require('electron');
  // 图片文件多选：扩展名覆盖 jpeg/tiff 等常见别名
  ipcMain.handle('ffgui:pickImageFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: t('main.dialog.pickImages'),
      filters: [
        {
          name: t('main.dialog.filterImages'),
          extensions: ['webp', 'jpg', 'jpeg', 'png', 'ico', 'bmp', 'gif', 'tif', 'tiff', 'tga'],
        },
        { name: t('main.dialog.filterAllFiles'), extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('ffgui:imgconv', (event, job) => runImgconv(event.sender, job));
  // 与音视频转换共用 ffmpeg.js 的取消标记和子进程句柄
  ipcMain.handle('ffgui:imgconv-cancel', () => {
    cancelCurrentTask();
  });
}

module.exports = {
  IMAGE_FORMATS,
  QUALITY_MAP,
  buildImageArgs,
  runImgconv,
  registerImgconvIpc,
};
