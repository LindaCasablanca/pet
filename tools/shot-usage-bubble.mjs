/**
 * shot-usage-bubble.mjs —— 走真实用户路径截「5 行用量气泡」
 *
 * 路径：在宠物命中区合成 contextmenu → 菜单弹开 → 点「查看余额」
 *       → 渲染端 fetch /balance → showBalanceNow() → 气泡弹出 → 截图
 *
 * 为什么不改 DOM / 不注入假数据：这条路本身就是用户会走的（右键 → 查看余额），
 * 气泡内容是宿主 /balance 的真实返回，不做任何伪造。
 * （余额轮询默认 1800 秒一次，所以靠"等它自然弹"等不到 —— 菜单是主动触发的正路。）
 *
 * 前提：宿主以 PET_ELECTRON_ARGS='--no-sandbox --remote-debugging-port=9333' 启动
 * 用法：node tools/shot-usage-bubble.mjs <输出.png>
 *
 * ⚠ 别指望"等气泡自然弹出"：余额轮询默认 1800 秒一次（events.js 的 refreshSec.balance）。
 *   菜单是主动触发的正路，也正好顺带验了「查看用量与余额」这一项还活着。
 */
import fs from 'node:fs';

const out = process.argv[2];
if (!out) { console.error('用法: node shot-usage-bubble.mjs <out.png>'); process.exit(2); }
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /electron-helper/.test(t.url || ''));
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
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

// ---- 1) 打开右键菜单 ----
const hit = JSON.parse((await evalJs('JSON.stringify(window.__dshPetDebug.hitRect || null)')) || 'null');
if (!hit) throw new Error('拿不到 hitRect，无法定位宠物');
const cx = Math.round(hit.x + hit.w / 2);
const cy = Math.round(hit.y + hit.h / 2);
await evalJs(`(() => {
  const el = document.querySelector('.pet-hit');
  if (!el) return 'no-hit';
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2,
    clientX: ${cx}, clientY: ${cy}, screenX: ${cx}, screenY: ${cy},
  }));
  return 'ok';
})()`);
await sleep(500);

// ---- 2) 找到「余额」那一项 ----
const labels = JSON.parse((await evalJs(
  `JSON.stringify([...document.querySelectorAll('.dsh-pet-menu-item')].map(el => el.textContent.trim()))`,
)) || '[]');
console.log('菜单项：' + JSON.stringify(labels));

const want = labels.find((x) => /余额/.test(x));
if (!want) { console.error('菜单里找不到「余额」项 —— 先确认补丁 18/18'); ws.close(); process.exit(1); }

const clicked = await evalJs(`(() => {
  const el = [...document.querySelectorAll('.dsh-pet-menu-item')].find(x => x.textContent.trim() === ${JSON.stringify(want)});
  if (!el) return 'not-found';
  el.click();
  return 'clicked';
})()`);
console.log(`点了「${want}」→ ${clicked}`);

// ---- 3) 等气泡弹出（up to 12s） ----
const probe = `(() => {
  const b = document.querySelector('.pet-bubble');
  if (!b) return { found: false };
  const s = document.querySelector('.pet-sprite');
  const r = b.getBoundingClientRect(), sr = s ? s.getBoundingClientRect() : null;
  return { found: true, on: b.classList.contains('is-on'), rows: b.children.length,
           text: (b.innerText || '').replace(/\\n/g, ' / '),
           bubbleTop: Math.round(r.top), spriteTop: sr ? Math.round(sr.top) : null };
})()`;

let hitInfo = null;
for (let i = 0; i < 24; i++) {
  const v = await evalJs(probe);
  if (v && v.on) { hitInfo = v; break; }
  await sleep(500);
}
if (!hitInfo) { console.error('点了余额但气泡没弹出'); ws.close(); process.exit(1); }

console.log('气泡已弹出（真实链接通路）');
console.log('  行数：' + hitInfo.rows);
console.log('  文案：' + hitInfo.text);
console.log('  气泡 top=' + hitInfo.bubbleTop + '／sprite top=' + hitInfo.spriteTop);

// ---- 4) 截图 ----
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const data = shot.result?.result?.data ?? shot.result?.data;
if (!data) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 300));
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log('已截图：' + out + '（' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB）');
ws.close();
