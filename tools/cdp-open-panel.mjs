/**
 * cdp-open-panel.mjs —— 用 CDP 在**真桌宠渲染进程**里触发一次「打开 Hermes 面板」
 *
 * 为什么：主进程那段代码我已经用 verify-open-site.cjs 验过（纯 node 执行产物代码），
 * 但那是"代码对不对"。这里要的是"**整条链路在真 Electron 里跑起来**"：
 *   渲染进程 → preload(petBridge) → IPC(pet:open-site) → 主进程 handler → shell.openExternal
 *
 * 渲染端实际发出的地址是 CONFIG.configUrl 的 origin（宿主 3080），这里**故意照样传**，
 * 看新实现会不会把它纠正成宿主注入的面板地址。
 *
 * 前提：宿主以 PET_ELECTRON_ARGS='--no-sandbox --remote-debugging-port=9333' 启动。
 * 用法：node tools/cdp-open-panel.mjs [发的地址]
 */
const PORT = process.env.CDP_PORT || 9333;
const SENT_URL = process.argv[2] || 'http://127.0.0.1:3080';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('找不到桌宠页面（宿主没开 --remote-debugging-port？）');
console.log('目标：' + page.title);
console.log('页面：' + page.url.slice(0, 80) + '…');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); p(msg); }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

// 0) 先看一眼渲染进程把什么当"网站地址"（= 这次 bug 的来源）
const origin = await evalJs('new URL(document.querySelector("script") ? location.href : location.href).searchParams.get("configUrl")');
console.log('渲染端 configUrl：' + origin);

// 1) 确认桥在
const hasBridge = await evalJs('!!(window.petBridge && window.petBridge.openDshSite)');
console.log('petBridge.openDshSite 存在：' + hasBridge);
if (!hasBridge) { console.log('结论：桥不在，无法触发'); process.exit(1); }

// 2) 触发 —— 等价于点右键菜单里的「打开 Hermes 面板」那一句
const t0 = Date.now();
const sent = await evalJs(`(() => { window.petBridge.openDshSite(${JSON.stringify(SENT_URL)}); return 'sent'; })()`);
console.log('已发送 pet:open-site，url=' + SENT_URL + '（' + sent + '）');
console.log('按 Ctrl+C 前，请看 host.log 里 [dsh-pet-desktop-helper] 那几行。');
console.log('耗时 ms（仅 IPC 发出）：' + (Date.now() - t0));
ws.close();
process.exit(0);
