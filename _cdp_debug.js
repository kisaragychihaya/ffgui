// CDP 调试脚本：连到 Electron 渲染进程，导航到 clip.html，
// 模拟 loadFile 的核心步骤，观察 video 元素加载本地文件的状态与控制台报错
const WebSocket = require('ws');

const DEBUG_FILE = 'C:\\Users\\chen\\Desktop\\ffgui\\test_media\\_debug.mp4';

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

let msgId = 0;
function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMsg = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) {
        ws.off('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown' || msg.method === 'Log.entryAdded') {
        console.log('[浏览器]', msg.method, JSON.stringify(msg.params).slice(0, 500));
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expr, awaitPromise = false) {
  const res = await send(ws, 'Runtime.evaluate', {
    expression: expr, awaitPromise, returnByValue: true,
  });
  if (res.exceptionDetails) {
    return { __error: JSON.stringify(res.exceptionDetails).slice(0, 500) };
  }
  return res.result.value;
}

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('.html'));
  if (!page) { console.log('未找到页面 target', targets.map((t) => t.url)); process.exit(1); }
  console.log('连接到:', page.url);

  const ws = await connect(page.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Log.enable');
  await send(ws, 'Page.enable');

  // 导航到截取页
  await evaluate(ws, "location.href = 'clip.html'; 'navigating'");
  await new Promise((r) => setTimeout(r, 1500));
  console.log('当前页面:', await evaluate(ws, 'location.href'));

  // 模拟 loadFile：探测 + 设置 video.src
  const result = await evaluate(ws, `(async () => {
    const ffgui = window.ffgui;
    if (!ffgui) return { fatal: 'window.ffgui 不存在（preload 加载失败）' };
    const path = ${JSON.stringify(DEBUG_FILE)};
    const probes = await ffgui.probeMedia([path]);
    const url = ffgui.pathToFileUrl(path);
    const v = document.getElementById('video');
    v.src = url;
    await new Promise((r) => setTimeout(r, 4000));
    return {
      probe: probes[0],
      url,
      currentSrc: v.currentSrc,
      readyState: v.readyState,
      networkState: v.networkState,
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      videoWidth: v.videoWidth,
      duration: v.duration,
      paused: v.paused,
      overlay: document.getElementById('player-overlay').textContent,
      playableFlag可见: !!document.getElementById('player-panel'),
    };
  })()`, true);
  console.log('video 状态:', JSON.stringify(result, null, 2));

  // 尝试播放
  const playRes = await evaluate(ws, `(async () => {
    const v = document.getElementById('video');
    try {
      await v.play();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true, paused: v.paused, currentTime: v.currentTime, readyState: v.readyState };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  })()`, true);
  console.log('播放尝试:', JSON.stringify(playRes));

  process.exit(0);
})().catch((e) => { console.error('调试脚本失败:', e); process.exit(1); });
