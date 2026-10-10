/**
 * 「重载配置」有没有真的重建桌面 Helper？
 *
 * 主判据：**渲染进程的 `performance.timeOrigin`**
 *   - Helper 被重启 → 新进程、新页面 → timeOrigin 变成「刚才」
 *   - 空操作 → 还是原来那个页面 → timeOrigin 纹丝不动
 * 用 timeOrigin 而不是进程号：wmic 在本机没输出、tasklist 又查不到，都不可靠。
 *
 * 副判据（防止"窗口重建了但宠物没起来"）：新页面里 `.pet-sprite` 在不在、`__dshPetDebug.configOk` 是不是 true。
 *
 * 参考契约（原生 sprite.js `reloadDesktop()` 的注释）：
 *   宿主 POST /reload → syncDesktop：串行队列 + 等旧进程真正退出再起新的
 *
 * 前提：宿主带 `--remote-debugging-port=9333` 起
 *   PET_ELECTRON_ARGS='--in-process-gpu --remote-debugging-port=9333' node lib/host.mjs
 *
 * 用法：node tools/probe-reload.mjs
 */
const PORT = Number(process.env.CDP_PORT || 9333);
const HOST = process.env.HOST_URL || 'http://127.0.0.1:3080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连上某个页面并返回一个求值函数；页面会被重建，所以每次重连 */
async function connect(tries = 40) {
  let page = null;
  for (let i = 0; i < tries && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      page = list.find((t) => t.type === 'page' && /electron-helper/.test(t.url || ''));
    } catch { /* 端口还没起 */ }
    if (!page) await sleep(400);
  }
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const ev = async (expression) =>
    (await new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }))
      .result?.result?.value;
  return { ev, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

const snap = (c) => c.ev([
  'JSON.stringify({',
  '  t: performance.timeOrigin,',
  '  ageS: Math.round((Date.now() - performance.timeOrigin) / 1000),',
  '  sprites: document.querySelectorAll(".pet-sprite").length,',
  '  configOk: !!(window.__dshPetDebug && window.__dshPetDebug.configOk),',
  '})',
].join('\n'));

// ---------- ① 重载前 ----------
const c1 = await connect();
if (!c1) throw new Error('等不到桌宠页面');
const before = JSON.parse(await snap(c1));
console.log('① 重载前');
console.log(`   timeOrigin = ${new Date(before.t).toISOString()}  （页面已开 ${before.ageS}s）`);
console.log(`   精灵数 = ${before.sprites}   configOk = ${before.configOk}`);
c1.close();

// ---------- ② 触发 ----------
console.log('\n② POST /reload …');
const r = await (await fetch(`${HOST}/dsh-pet-7340/reload`, { method: 'POST' })).json();
console.log('   宿主立即回：' + JSON.stringify(r));

// ---------- ③ 等新页面出现（并等它 boot 完）----------
// ⚠ 页面一出现 ≠ 宠物已建好：新页面的 boot 是异步的（renderer.js 里还有个 5s 的 bootTimer 兜底），
//   所以"精灵数"要单独等，别拿刚建好的那一帧当结论（第一次就这么误判过）。
console.log('\n③ 等新页面出现、并等它把宠物建出来（最多 30s）…');
let after = null;
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  await sleep(700);
  const c = await connect(3);
  if (!c) continue;
  const s = JSON.parse(await snap(c));
  if (Math.abs(s.t - before.t) < 1) { c.close(); continue; }   // 还是旧页面 → 继续等
  if (s.sprites > 0) { after = s; c.close(); break; }
  after = s;                                                   // 记下最新的（可能还没建好）
  c.close();
}
if (!after) {
  console.log('   ✘ 30 秒内没等到新页面');
} else {
  console.log(`   timeOrigin = ${new Date(after.t).toISOString()}  （新页面开了 ${after.ageS}s）`);
  console.log(`   精灵数 = ${after.sprites}   configOk = ${after.configOk}`);
}

// ---------- ④ 判据 ----------
console.log('\n──── 结论 ────');
if (!before.sprites) {
  console.log('⚠ 重载前就没有精灵 —— 这次测量不作数（宠物本来没起来）');
  process.exit(2);
}
if (!after) {
  console.log('✘ 窗口没被重建：/reload 是空操作');
  process.exit(1);
}
const rebuilt = Math.abs(after.t - before.t) > 1;
const alive = after.sprites > 0;
console.log(`窗口重建：${rebuilt ? '✔' : '✘'}     宠物回来了：${alive ? '✔' : '✘'}（精灵 ${after.sprites} 只）`);
if (rebuilt && alive) {
  console.log('✔ /reload 有效：桌面 Helper 真的重启了，且新窗口里宠物正常');
  process.exit(0);
}
process.exit(1);
