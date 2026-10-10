#!/usr/bin/env node
/**
 * probe-anim-switch.mjs —— 实测「同档位换任务时动画会不会被重播」
 * ---------------------------------------------------------------------------
 * 为什么必须量：events.js 的 work-anim-per-state 补丁（动画只在档位变化时切）是我加的，
 * 依据是「工作状态动画 10.04 秒 + 工具循环 2~4 秒一个事件」的推算。推算不等于事实，这里量它。
 *
 * 判据（直接读渲染进程，不猜）：
 *   ▪ front video 的 src —— 切档位必然换动画文件；同档位换任务**不应**换
 *   ▪ front video 的 currentTime —— 被重播就会归零；不重播则应单调增长
 *
 * 前提：宿主用 PET_ELECTRON_ARGS 开了调试口（Electron 本机需要 --in-process-gpu）：
 *   PET_ELECTRON_ARGS='--in-process-gpu --remote-debugging-port=9333' \
 *   HERMES_STATE_DB=<假库> node lib/host.mjs
 *
 * 用法：node tools/probe-anim-switch.mjs [--shot 输出.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DIR, FAKE, build, writeScene } from './drive-work-states.mjs';

const CDP_PORT = process.env.CDP_PORT || 9333;
const HOST = 'http://127.0.0.1:3080/dsh-pet-7340';
const shotIdx = process.argv.indexOf('--shot');
const SHOT = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;

const calls = (name, args) => JSON.stringify([{ id: 'c1', call_id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]);

build();
const seed = {
  session: JSON.parse(fs.readFileSync(path.join(DIR, 'seed-session.json'), 'utf8')),
  message: JSON.parse(fs.readFileSync(path.join(DIR, 'seed-message.json'), 'utf8')),
};
const db = new DatabaseSync(FAKE);

/** 写一个「working / 在写 <file>」场景（同档位、只换任务） */
function writeWorking(file) {
  writeScene(db, seed, {
    key: 'working',
    expect: 'working',
    over: (N) => ({ source: 'cli', title: '改一下脚本', last_activity_at: N, last_activity_description: '', ended_at: null }),
    msgs: (N) => [{ role: 'assistant', content: '', tool_calls: calls('write_file', { path: file }), finish_reason: 'tool_calls', timestamp: N }],
  });
}
/** 写一个「result」场景（换档位） */
function writeResult() {
  writeScene(db, seed, {
    key: 'result',
    expect: 'result',
    over: (N) => ({ source: 'cli', title: '跑一下', last_activity_at: N, last_activity_description: '', ended_at: null }),
    msgs: (N) => [{ role: 'tool', tool_name: 'write_file', content: JSON.stringify({ bytes_written: 771, exit_code: 0, error: null }), timestamp: N }],
  });
}

// ---- CDP ----
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
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
await call('Runtime.enable');
async function evalIn(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

const SAMPLER = `(function(){
  var vs = [].slice.call(document.querySelectorAll('video'));
  var f = vs.filter(function(v){ return v.classList.contains('is-front'); })[0];
  var b = document.querySelector('.pet-bubble');
  var base = '/dsh-pet-7340/thumb/';
  function name(v){ if(!v) return null; var s = v.currentSrc || v.src || ''; var i = s.indexOf(base); return i<0?null:decodeURIComponent(s.slice(i+base.length).replace(/^[^/]+\\//,'')); }
  return {
    anim: name(f),
    t: f ? +f.currentTime.toFixed(2) : null,
    ready: f ? f.readyState : null,
    paused: f ? f.paused : null,
    bubbleOn: !!(b && b.classList.contains('is-on')),
    text: b ? (b.innerText||'').replace(/\\n/g,' / ').slice(0,60) : ''
  };
})()`;

async function snapshot() {
  const dom = await evalIn(SAMPLER);
  let ws2 = null;
  try { ws2 = await (await fetch(`${HOST}/work-status`)).json(); } catch {}
  return { dom, ws: ws2 };
}

// ---- 先把状态推到 working，等动画起播 ----
writeWorking('C:\\Hermes\\a.md');
let s = null;
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 400));
  s = await snapshot();
  if (s.ws?.state === 'working' && s.dom.anim) break;
}
console.log(`起点：host=${s.ws?.state} / task=${s.ws?.task} / 前台动画=${s.dom.anim} / t=${s.dom.t}`);

const rows = [];
const plan = [];
for (let i = 0; i < 18; i++) plan.push(i);
const ACTION = {
  2: () => writeWorking('C:\\Hermes\\b.md'),   // 同档位，只换任务
  5: () => writeWorking('C:\\Hermes\\c-caption-plan.json'),
  8: () => writeWorking('（本地工作目录）\\RAG\\_captions.json'),
  12: () => writeResult(),                     // 换档位
};

for (const i of plan) {
  if (ACTION[i]) ACTION[i]();
  await new Promise((r) => setTimeout(r, 800));
  const snap = await snapshot();
  rows.push({ i, ...snap });
  console.log(`  #${String(i).padStart(2)}  host=${String(snap.ws?.state).padEnd(8)} 动画=${String(snap.dom.anim || '-').padEnd(26)} t=${String(snap.dom.t).padStart(6)}  气泡=${snap.dom.bubbleOn ? 'on ' : 'off'}  「${snap.dom.text}」`);
}

// ---- 断言 ----
let pass = 0, fail = 0;
const chk = (name, cond, detail) => { if (cond) { pass++; console.log(`  [ok] ${name}`); } else { fail++; console.log(`  [!!] ${name}  << ${detail}`); } };

const seg = (a, b) => rows.filter((r) => r.i >= a && r.i <= b);
const sameStateAnims = new Set(seg(2, 11).map((r) => r.dom.anim).filter(Boolean));
const sameStateTs = seg(2, 11).map((r) => r.dom.t);
let monotonic = true;
for (let i = 1; i < sameStateTs.length; i++) {
  if (sameStateTs[i] !== null && sameStateTs[i - 1] !== null && sameStateTs[i] < sameStateTs[i - 1] - 0.3) monotonic = false;
}

console.log('\n断言：');
chk('同档位（working）期间前台动画文件未变', sameStateAnims.size <= 1, `出现了 ${sameStateAnims.size} 个：${[...sameStateAnims].join(' / ')}`);
chk('同档位期间 currentTime 未被重置（动画没重播）', monotonic, `时间序列：${sameStateTs.join(', ')}`);

const before = rows.find((r) => r.i === 11);
const after = rows.find((r) => r.i === 12);
chk('换档位（working→result）前台动画确实换了', !!before?.dom.anim && !!after?.dom.anim && before.dom.anim !== after.dom.anim,
  `${before?.dom.anim} → ${after?.dom.anim}`);
chk('换档位后 currentTime 归零（新动画从头起）', (after?.dom.t ?? 99) < (before?.dom.t ?? 0), `${before?.dom.t} → ${after?.dom.t}`);

const texts = new Set(seg(2, 11).map((r) => r.dom.text).filter(Boolean));
chk('同档位期间气泡文案跟着任务变了（≥2 种）', texts.size >= 2, [...texts].join(' | '));

if (SHOT) {
  const r = await call('Page.enable');
  void r;
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = shot.result?.data;
  if (data) {
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    console.log(`\n已截图：${SHOT}`);
  } else { console.log('\n截图失败：' + JSON.stringify(shot).slice(0, 200)); }
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}   （前 4 条才是本次补丁的判据）`);
db.close();
ws.close();
process.exit(fail ? 1 : 0);
