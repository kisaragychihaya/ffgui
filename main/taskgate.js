'use strict';

// 窗口关闭拦截用的任务状态聚合层：index.js 在 close 事件里询问「是否忙」，
// 用户确认退出后调用 cancelAll() 取消全部活动任务。
// 单向依赖：本模块 require 各任务模块，各任务模块不得 require 本模块（防循环）。
const ffmpeg = require('./ffmpeg');
const disc = require('./disc');
const cdrip = require('./cdrip');
const dub = require('./dub');

// 转码/合并/截取/预览/录屏转 MP4 共用 ffmpeg 的 currentChild；
// 录屏写盘、光盘抓取、CD 抓轨、字幕配音各有自己的活动任务状态
function isBusy() {
  return ffmpeg.isTaskRunning()
    || ffmpeg.isRecording()
    || disc.isRunning()
    || cdrip.isRunning()
    || dub.isRunning();
}

// 依次取消全部任务：先杀 ffmpeg 子进程，再丢弃未完成的录制，
// 最后取消光盘/CD/配音（各自转调现有 cancel，负责清理自身半成品）
function cancelAll() {
  const steps = [
    ['ffmpeg', () => ffmpeg.cancelCurrentTask()],
    ['recording', () => ffmpeg.discardOpenRecords()],
    ['disc', () => disc.cancelActive()],
    ['cdrip', () => cdrip.cancelActive()],
    ['dub', () => dub.cancelActive()],
  ];
  for (const [name, run] of steps) {
    try {
      run();
    } catch (err) {
      // 单项取消失败不阻断其余任务，错误留给控制台诊断
      console.log(`[ffgui] 关闭窗口时取消 ${name} 任务失败: ${err && err.message ? err.message : err}`);
    }
  }
  console.log('[ffgui] 关闭窗口：已取消全部运行中任务');
}

module.exports = { isBusy, cancelAll };
