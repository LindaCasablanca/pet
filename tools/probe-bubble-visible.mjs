/**
 * 桌宠气泡「可见性」自证脚本（CDP）
 *
 * 判据只有一条：气泡在**屏幕坐标系**里的矩形，必须完整落在工作区内、且完整落在宠物窗口内。
 * 页面里两边都能拿到：
 *   - 气泡：getBoundingClientRect()（页面 CSS px）+ 窗口屏幕位置
 *   - 工作区：constants.js 的 VIEW（屏幕坐标，已 ÷scale）
 *
 * ⚠️ 单位坑（踩过）：Electron 里 window.screenX/screenY 返回的是**物理像素**，
 *    而 getBoundingClientRect / VIEW 是 **CSS px**（本机 zoomFactor=2、dpr=2，两者差 2 倍）。
 *    直接相加会算出「横向出屏」这种假故障。换算：screenCss = window.screenX / devicePixelRatio。
 *
 * ⚠️ 拖拽坑：不要用 CDP 合成鼠标事件拖这只宠物。窗口是跟着宠物走的，合成指针的**屏幕**坐标
 *    会随窗口一起漂移，而渲染端是按 e.screenX 的绝对偏移算位置的 → 退化成自反馈回路
 *    （实测注入 420px 只移动了 148px，还会把宠物带偏）。要测「宠物停在不同高度时气泡翻不翻」，
 *    正确做法是改配置里的 position 再重启，不要拖。
 *
 * 用法：node _pet_bubble_probe.mjs
 */
const PORT = process.env.CDP_PORT || 9333;
const HOST = 'http://127.0.0.1:3080';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /dsh-pet|electron-helper/.test(t.url || ''));
if (!page) throw new Error('找不到桌宠页面（调试口没开？先在 PET_ELECTRON_ARGS 里加 --remote-debugging-port）');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let seq = 0;
const call = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
await call('Runtime.enable');
async function evalIn(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result?.result?.value;
}

const SAMPLER = `
(function(){
  var b = document.querySelector('.pet-bubble');
  if (!b.classList.contains('is-on')) return null;      // 只取真正显示出来的那一帧
  var r = b.getBoundingClientRect();
  var s = document.querySelector('.pet-sprite').getBoundingClientRect();
  var k = window.devicePixelRatio;                       // 物理 → CSS
  var winX = window.screenX / k, winY = window.screenY / k;
  return {
    cls: (b.className || '').replace('pet-bubble', '').trim() || '(base)',
    rows: b.children.length,
    size: [Math.round(r.width), Math.round(r.height)],
    bubble: { x: Math.round(winX + r.x), y: Math.round(winY + r.y), r: Math.round(winX + r.x + r.width), b: Math.round(winY + r.y + r.height) },
    spriteTop: Math.round(winY + s.y),
    petPos: window.__dshPetDebug.dragPos,
    view: { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h },
    win: { y: Math.round(winY), h: innerHeight },
    text: b.innerText.replace(/\\n/g, ' / ').slice(0, 58)
  };
})()`;

function report(s) {
  const fitsX = s.bubble.x >= s.view.x && s.bubble.r <= s.view.x + s.view.w;
  const fitsY = s.bubble.y >= s.view.y && s.bubble.b <= s.view.y + s.view.h;
  const inWinY = s.bubble.y >= s.win.y && s.bubble.b <= s.win.y + s.win.h;
  const ok = fitsX && fitsY && inWinY;
  const flip = s.cls.includes('is-below') ? '垂脚下' : '在头顶';
  console.log(`  ${ok ? '✓' : '✗'} ${flip}  类=[${s.cls}]`);
  console.log(`      气泡 ${s.size[0]}x${s.size[1]}  屏幕 x ${s.bubble.x}..${s.bubble.r}  y ${s.bubble.y}..${s.bubble.b}`);
  console.log(`      工作区 x ${s.view.x}..${s.view.x + s.view.w}  y ${s.view.y}..${s.view.y + s.view.h}   |  宠物窗口 y ${s.win.y}..${s.win.y + s.win.h}`);
  console.log(`      宠物 pos.y=${s.petPos.y}（头顶上方余量 ${s.petPos.y}px）  sprite 顶 y=${s.spriteTop}`);
  if (!ok) console.log(`      ✗ ${[!fitsX && '横向出屏', !fitsY && '纵向出屏', !inWinY && '纵向出窗口'].filter(Boolean).join(' / ')}  文本: ${s.text}`);
  return ok;
}

console.log('\n=== 桌宠气泡可见性自证 ===\n');
console.log('宠物当前落位：', JSON.stringify(await evalIn('window.__dshPetDebug.dragPos')));
console.log('工作区(VIEW)：', JSON.stringify(await evalIn('({x:VIEW.x,y:VIEW.y,w:VIEW.w,h:VIEW.h})')));
console.log('');

const res = await fetch(`${HOST}/ctl/show`).catch(() => null);
console.log('触发用量气泡：', res ? res.status : '（宿主没响应）');

const seen = [];
const t0 = Date.now();
while (Date.now() - t0 < 14000) {
  const s = await evalIn(SAMPLER);
  if (s) { seen.push(s); await new Promise((r) => setTimeout(r, 600)); }
  else await new Promise((r) => setTimeout(r, 200));
}
if (!seen.length) {
  console.log('没抓到显示中的气泡');
} else {
  const mid = seen[Math.floor(seen.length / 2)];
  const ok = report(mid);
  console.log(`\n（共采到 ${seen.length} 帧，判定取中段；结论：${ok ? '完整可见 ✓' : '被裁切 ✗'}）\n`);
}
ws.close();
