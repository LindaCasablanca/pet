#!/usr/bin/env node
/**
 * shot-pet.mjs —— 用 CDP 给桌宠窗口截一张图（视觉自证用）
 * 前提：宿主以 PET_ELECTRON_ARGS='--in-process-gpu --remote-debugging-port=9333' 启动。
 * 用法：node tools/shot-pet.mjs <输出.png>
 */
import fs from 'node:fs';
const out = process.argv[2];
if (!out) { console.error('用法: node tools/shot-pet.mjs <输出.png>'); process.exit(2); }
const PORT = process.env.CDP_PORT || 9333;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /dsh-pet|electron-helper/.test(t.url || ''));
if (!page) throw new Error('找不到桌宠页面（宿主没开 --remote-debugging-port？）');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const call = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const data = shot.result?.data;
if (!data) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 300));
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log('已截图：' + out + '（' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB）');

// 顺带把气泡几何/文案报出来（--facts）—— 比肉眼看截图可靠
if (process.argv.includes('--facts')) {
  const FACTS = `(function(){
    var b = document.querySelector('.pet-bubble');
    var s = document.querySelector('.pet-sprite');
    if (!b || !s) return {err:'找不到 .pet-bubble / .pet-sprite'};
    var r = b.getBoundingClientRect(), sr = s.getBoundingClientRect();
    var k = window.devicePixelRatio;                 // screenX/screenY 是物理像素，其余是 CSS px
    var winX = window.screenX / k, winY = window.screenY / k;
    var cs = getComputedStyle(b);
    return {
      on: b.classList.contains('is-on'),
      cls: (b.className||'').replace('pet-bubble','').trim() || '(base)',
      text: (b.innerText||'').replace(/\\n/g,' / '),
      len: (b.innerText||'').replace(/\\n/g,'').length,
      rows: b.children.length,
      size: [Math.round(r.width), Math.round(r.height)],
      screen: { x: Math.round(winX + r.x), y: Math.round(winY + r.y), r: Math.round(winX + r.x + r.width), b: Math.round(winY + r.y + r.height) },
      pad: cs.padding, maxW: cs.maxWidth, whiteSpace: cs.whiteSpace,
      win: { y: Math.round(winY), h: innerHeight, w: innerWidth, cx: Math.round(winX) },
      view: { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h },
      spriteTop: Math.round(winY + sr.y),
      petPos: window.__dshPetDebug && window.__dshPetDebug.dragPos
    };
  })()`;
  const r = await call('Runtime.enable');
  void r;
  const rr = await call('Runtime.evaluate', { expression: FACTS, returnByValue: true });
  const f = rr.result?.result?.value;
  if (!f || f.err) { console.log('读气泡失败：' + JSON.stringify(f || r).slice(0, 300)); }
  else {
    const fitsX = f.screen.x >= f.view.x && f.screen.r <= f.view.x + f.view.w;
    const fitsY = f.screen.y >= f.view.y && f.screen.b <= f.view.y + f.view.h;
    const inWin = f.screen.y >= f.win.y && f.screen.b <= f.win.y + f.win.h;
    console.log('\n气泡：' + (f.on ? '显示中' : '已收起') + `  类=[${f.cls}]  ${f.size[0]}x${f.size[1]}px  行块=${f.rows}`);
    console.log(`  文案（${f.len} 字）：${f.text}`);
    console.log(`  屏幕矩形 x ${f.screen.x}..${f.screen.r}  y ${f.screen.y}..${f.screen.b}`);
    console.log(`  工作区 x ${f.view.x}..${f.view.x + f.view.w}  y ${f.view.y}..${f.view.y + f.view.h}`);
    console.log(`  宠物窗口 y ${f.win.y}..${f.win.y + f.win.h}（宽 ${f.win.w}）  sprite 顶 y=${f.spriteTop}`);
    console.log(`  padding=${f.pad}  maxWidth=${f.maxW}  whiteSpace=${f.whiteSpace}`);
    console.log(`  判定：横向${fitsX ? '✓' : '✗'}  工作区纵向${fitsY ? '✓' : '✗'}  窗口内纵向${inWin ? '✓' : '✗'}`);
  }
}
ws.close();
