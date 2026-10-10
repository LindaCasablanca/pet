/**
 * cdp-quit-pet.mjs —— 端到端验证「右键菜单 → 退出桌宠」
 *
 * 验的是整条真实链路：
 *   合成右键（在宠物命中区中心）→ 菜单 DOM 弹开 → 菜单里确实有「退出桌宠」
 *   → 触发它的 click → 渲染端 fetch(BASE + '/ctl/quit') → 宿主关宠物 + 退自己
 *   → Electron 的管道存亡守卫跟着退
 *
 * 几个"为什么这么写"：
 *   - 菜单叶子项绑的是 **click**（shared-core.js 的 buildPanel），所以直接 element.click() 就能触发，
 *     不需要合成鼠标坐标 —— 也就绕开了"合成指针在桌宠上不可靠"那个老坑。
 *   - 右键事件渲染端读的是 e.clientX/clientY（onContextMenu），CDP 的页面内坐标合成是对的；
 *     当初拖拽翻车是因为那边读 e.screenX（窗口一移动就自反馈退化），跟这里不是一回事。
 *   - 断言分两段：先"菜单里有没有这一项"，再"点了之后宿主是否真的退了"——前者失败说明补丁没打上，
 *     后者失败说明宿主路由或链路断了，能立刻分清是哪一层的问题。
 *
 * 前提：宿主以 PET_ELECTRON_ARGS='--no-sandbox --remote-debugging-port=9333' 启动
 * 用法：node tools/cdp-quit-pet.mjs
 */
const PORT = process.env.CDP_PORT || 9333;
const HOST = `http://127.0.0.1:${process.env.PET_HOST_PORT || 3080}`;
const PREFIX = '/dsh-pet-7340';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('找不到桌宠页面（宿主没开 --remote-debugging-port？）');
console.log('目标：' + page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); p(msg); }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

const checks = [];
const check = (name, ok, extra = '') => { checks.push([name, ok, extra]); console.log((ok ? '[ok] ' : '[!!] ') + name + (extra ? '  ' + extra : '')); };

// ---- 1) 宿主在跑吗（作为退出的基线） ----
const hostAliveBefore = await fetch(HOST + PREFIX + '/config', { method: 'GET' }).then(() => true).catch(() => false);
check('基线：宿主在跑', hostAliveBefore);

// ---- 2) 打开菜单：在命中区元素上派发 contextmenu ----
// ⚠ 别用 CDP 的 Input.dispatchMouseEvent 合成右键 —— 实测它不会让菜单弹出
//   （元素类名是 `.pet-hit`，且 OS 级输入合成在这套穿透窗口上不可靠）。
//   main.js 自带的菜单自检用的就是"拿到 .pet-hit 直接 dispatchEvent"这条路，照抄它。
const hit = await evalJs('JSON.stringify(window.__dshPetDebug.hitRect || null)');
const rect = hit ? JSON.parse(hit) : null;
if (!rect) throw new Error('拿不到 hitRect，无法定位宠物');
const cx = Math.round(rect.x + rect.w / 2);
const cy = Math.round(rect.y + rect.h / 2);
console.log(`宠物命中区中心：(${cx}, ${cy})  矩形=${JSON.stringify(rect)}`);

const dispatched = await evalJs(`(() => {
  const el = document.querySelector('.pet-hit');
  if (!el) return 'no-hit-element';
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2,
    clientX: ${cx}, clientY: ${cy}, screenX: ${cx}, screenY: ${cy},
  }));
  return 'dispatched';
})()`);
check('在 .pet-hit 上派发 contextmenu', dispatched === 'dispatched', dispatched !== 'dispatched' ? dispatched : '');
await sleep(400);

// ---- 3) 菜单开了吗 + 里有没有「退出桌宠」 ----
const menuOpen = await evalJs('!!window.__dshPetDebug.menuOpen');
check('右键后菜单已打开', menuOpen);

const labels = await evalJs(`JSON.stringify([...document.querySelectorAll('.dsh-pet-menu-item')].map(el => el.textContent.trim()))`);
const items = labels ? JSON.parse(labels) : [];
console.log('菜单项：' + JSON.stringify(items, null, 0));
check('菜单里有「退出桌宠」', items.includes('退出桌宠'));
if (!items.includes('退出桌宠')) {
  console.log('\n结论：补丁没生效或菜单结构变了 —— 先查 patch 是否 17/17');
  ws.close(); process.exit(1);
}

// ---- 4) 点它 ----
const clicked = await evalJs(`(() => {
  const el = [...document.querySelectorAll('.dsh-pet-menu-item')].find(x => x.textContent.trim() === '退出桌宠');
  if (!el) return 'not-found';
  el.click();
  return 'clicked';
})()`);
check('已触发「退出桌宠」的 click', clicked === 'clicked');

// ---- 5) 宿主是否真的退了 ----
await sleep(2000);
const hostAliveAfter = await fetch(HOST + PREFIX + '/config', { method: 'GET' }).then(() => true).catch(() => false);
check('宿主已退出（端口不再应答）', !hostAliveAfter);

const pageGone = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((j) => !j.some((t) => t.type === 'page')).catch(() => true);
check('桌宠页面已消失（Electron 跟着退了）', pageGone);

const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n结论：失败 ${failed} 项` : '\n结论：全部通过');
ws.close();
process.exit(failed ? 1 : 0);
