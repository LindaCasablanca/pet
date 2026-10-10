/**
 * 气泡「文字装不装得下」自证脚本（CDP）
 *
 * 跟 probe-bubble-visible.mjs 是**互补**的两件事，别搞混：
 *   - probe-bubble-visible.mjs：气泡矩形 vs **屏幕工作区**（会不会跑到屏幕外）
 *   - 本脚本：文字行矩形 vs **气泡内容盒**（框内的字会不会被裁/溢出白底）
 *
 * 量法：逐行取 Range 的真实矩形，跟 padding 内边界比。
 *
 * ⚠️ 为什么不用 scrollHeight - clientHeight：自动高度的绝对定位元素上它天然差几像素
 *    （实测 1 行文案差 8px、2 行差 7px），看着像"溢出"，其实是被上下 padding 吸收了，
 *    加上 `overflow: visible` 根本不会切 —— 拿它当判据会报**假故障**。
 *
 * ⚠️ 别只找「直接子文本节点」：这只气泡里装字的其实是个 `<div class="pet-bub-row">`，
 *    只找文本节点会拿到 null → 量到 0 行 → 溢出列表为空 → **报"通过"**。
 *    空集断言恒真，这是最隐蔽的假绿（第一次写就踩了）。
 *
 * ⚠️ 也别只量**第一个**文本节点：用量气泡是「标签 + 数值」多行结构，一堆文本节点。
 *    只量第一个会拿一行短标签去"代表"整只气泡、还报通过（第二次踩，同一个病）。
 *    所以下面**遍历全部文本节点**，每个节点再按行拆，逐行比边界。
 *
 * 用法：
 *   node tools/probe-bubble-text-fit.mjs              # 触发今天该应的节，量它
 *   node tools/probe-bubble-text-fit.mjs 2026-02-17   # 假装今天是那天
 *   node tools/probe-bubble-text-fit.mjs --no-trigger # 不触发，量当前已经亮着的气泡
 *   node tools/probe-bubble-text-fit.mjs --selftest   # 哨兵：故意把文字撑出框，确认它真会报红
 * 前提：宿主带 --remote-debugging-port=9333 起
 */
const PORT = Number(process.env.CDP_PORT || 9333);
const HOST = process.env.HOST_URL || 'http://127.0.0.1:3080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const noTrigger = argv.includes('--no-trigger');
const dateArg = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

let page = null;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((t) => t.type === 'page' && /dsh-pet|electron-helper/.test(t.url || ''));
  } catch { /* 端口还没起 */ }
  if (!page) await sleep(500);
}
if (!page) throw new Error(`等不到桌宠页面（CDP 端口 ${PORT} 没起？先在 PET_ELECTRON_ARGS 里加 --remote-debugging-port）`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const ev = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

if (!noTrigger) {
  const q = new URLSearchParams({ force: '1' });
  if (dateArg) q.set('date', dateArg);
  const trig = await (await fetch(`${HOST}/dsh-pet-7340/festival?${q}`, { method: 'POST' })).json();
  console.log('触发：' + JSON.stringify({ anims: trig.anims, line: trig.line, skipped: trig.skipped }));
  if (trig.skipped && trig.skipped !== 'today-already-said') {
    console.log('今天没有可触发的应节内容（' + trig.skipped + '）—— 用 --no-trigger 量当前气泡，或传一个节日日期');
  }
}

/**
 * 探针写成**单引号字符串数组**再 join。
 * ⚠ 别用模板字面量当外层：探针里也要用模板字面量拼提示语，嵌套反引号会把解析搞崩
 *   （踩过：SyntaxError: missing ) after argument list）。
 */
const PROBE = [
  '(() => {',
  '  const b = document.querySelector(".pet-bubble");',
  '  if (!b || !b.classList.contains("is-on")) return "";',
  '  const cs = getComputedStyle(b), box = b.getBoundingClientRect();',
  '  const pad = { l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight), t: parseFloat(cs.paddingTop), b: parseFloat(cs.paddingBottom) };',
  '  const inner = { l: box.left + pad.l, r: box.right - pad.r, t: box.top + pad.t, b: box.bottom - pad.b };',
  // 遍历**全部**文本节点（用量气泡是「标签+数值」多行，只量第一个会漏）
  '  const nodes = [];',
  '  const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);',
  '  let n;',
  '  while ((n = walker.nextNode())) if (n.textContent.trim()) nodes.push(n);',
  '  const lines = [];',
  '  for (const tn of nodes) {',
  '    const txt = tn.textContent;',
  '    let start = 0; while (start < txt.length && !txt[start].trim()) start++;',
  '    let prevTop = null, prevLeft = null;',
  '    for (let i = start + 1; i <= txt.length; i++) {',
  '      const rg = document.createRange(); rg.setStart(tn, start); rg.setEnd(tn, i);',
  '      const rr = rg.getBoundingClientRect();',
  '      if (prevTop === null) { prevTop = rr.top; prevLeft = rg.getBoundingClientRect().left; }',
  '      const broke = Math.abs(rr.top - prevTop) > 1;',
  '      if (broke || i === txt.length) {',
  '        const end = broke ? i - 1 : i;',
  '        const rg2 = document.createRange(); rg2.setStart(tn, start); rg2.setEnd(tn, end);',
  '        const r2 = rg2.getBoundingClientRect();',
  '        lines.push({ text: txt.slice(start, end), l: +r2.left.toFixed(1), r: +r2.right.toFixed(1), t: +r2.top.toFixed(1), b: +r2.bottom.toFixed(1) });',
  '        start = end; prevTop = rr.top;',
  '      }',
  '    }',
  '  }',
  '  const f = (x) => x.toFixed(1);',
  '  const problems = [];',
  '  if (!nodes.length) problems.push("没定位到任何文本节点（探针失效，不是通过）");',
  '  else if (!lines.length) problems.push("量到 0 行（探针失效，不是通过）");',
  '  lines.forEach((x, i) => {',
  '    if (x.l < inner.l - 0.6) problems.push("第" + (i + 1) + "行「" + x.text.slice(0, 12) + "」左超出内容区 " + f(inner.l - x.l) + "px");',
  '    if (x.r > inner.r + 0.6) problems.push("第" + (i + 1) + "行「" + x.text.slice(0, 12) + "」右超出内容区 " + f(x.r - inner.r) + "px");',
  '    if (x.t < inner.t - 0.6) problems.push("第" + (i + 1) + "行「" + x.text.slice(0, 12) + "」上超出内容区 " + f(inner.t - x.t) + "px");',
  '    if (x.b > inner.b + 0.6) problems.push("第" + (i + 1) + "行「" + x.text.slice(0, 12) + "」下超出内容区 " + f(x.b - inner.b) + "px");',
  '  });',
  '  const kid = b.firstElementChild;',
  '  return JSON.stringify({',
  '    text: b.textContent.trim(), cls: b.className, textNodes: nodes.length, linesCount: lines.length,',
  '    kid: kid ? { tag: kid.tagName, cls: kid.className, h: +f(kid.getBoundingClientRect().height) } : null,',
  '    css: { height: cs.height, fontSize: cs.fontSize, lineHeight: cs.lineHeight, whiteSpace: cs.whiteSpace, overflow: cs.overflow },',
  '    overflowBoxPx: b.scrollHeight - b.clientHeight,',
  '    box: { l: +f(box.left), r: +f(box.right), t: +f(box.top), b: +f(box.bottom), w: +f(box.width), h: +f(box.height) },',
  '    inner: { l: +f(inner.l), r: +f(inner.r), t: +f(inner.t), b: +f(inner.b) },',
  '    lines, problems,',
  '  });',
  '})()',
].join('\n');

const selftest = argv.includes('--selftest');

/** 等气泡亮起并量一次；等到就返回解析结果，等不到返回 null */
async function measure({ tries = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await ev(PROBE);
    if (r) return JSON.parse(r);
    await sleep(150);
  }
  return null;
}

const first = await measure();
if (!first) {
  console.log('没等到气泡（气泡可能已经淡出）—— 试试 --no-trigger 或换个节日日期');
  process.exit(2);
}
console.log(JSON.stringify(first, null, 2));
const bad0 = first.problems.length > 0;
console.log('\n' + (bad0
  ? '✘ 有问题：\n  ' + first.problems.join('\n  ')
  : `✔ ${first.textNodes} 个文本节点 / ${first.linesCount} 行文字全落在内容盒内（共 ${first.text.length} 字），没裁`));
console.log('  （注：overflowBoxPx=' + first.overflowBoxPx + ' 是内部行高余量，被上下 padding 吸收，不是裁字判据）');

if (!selftest) process.exit(bad0 ? 1 : 0);

// ---- 哨兵：把文字**故意**撑出框，确认上面那套判据真的会响 ----
// 不做这一步的话，"全落盒内"这句话是没有说服力的 —— 判据本身可能是死的。
// ⚠ 第一次注入写的是"放大字号"——**根本不会溢出**：气泡高度/宽度是 auto，
//   框会跟着字一起长大（实测 0 条溢出）。要造溢出必须**把框钉死**（nowrap + 固定宽度）。
console.log('\n〔哨兵〕把文字钉成 nowrap、宽度锁死 60px，让它必然溢出 ……');
await ev([
  '(() => {',
  '  const b = document.querySelector(".pet-bubble");',
  '  if (!b) return "no-bubble";',
  '  b.style.whiteSpace = "nowrap";',
  '  b.style.width = "60px";',
  '  b.style.maxWidth = "60px";',
  '  b.style.minWidth = "0";',
  '  b.style.overflow = "visible";',
  '  b.classList.add("is-on");',
  '  return "ok";',
  '})()',
].join('\n'));
await sleep(250);

const second = await measure({ tries: 40 });
if (!second) {
  console.log('✘ 哨兵失败：注入后量不到气泡，判据没被真正考验');
  process.exit(2);
}
const fired = second.problems.length > 0;
console.log('  注入后溢出项：' + (fired ? second.problems.length + ' 条' : '0 条'));
for (const p of second.problems) console.log('    · ' + p);

// ⚠ 一定要把注入的**行内样式清掉**：气泡 DOM 元素是**复用**的（不是每次新建），
//   行内样式会一直挂在那儿 —— 上一次哨兵跑完没清，下一次「正常」测量量到的
//   其实是 40px 的字，差点当成真实状态（当场踩到）。
await ev([
  '(() => {',
  '  const b = document.querySelector(".pet-bubble");',
  '  if (!b) return "no-bubble";',
  '  for (const k of ["whiteSpace", "width", "maxWidth", "minWidth", "overflow", "fontSize"]) b.style[k] = "";',
  '  return "cleaned";',
  '})()',
].join('\n'));
await sleep(200);
const third = await measure({ tries: 20 });
const restored = !third || third.problems.length === 0;
console.log('  清理后复量：' + (restored ? '✔ 恢复正常，行内样式已清' : '✘ 仍有 ' + third.problems.length + ' 条 —— 元素被改坏了，重启宿主'));

console.log('\n' + (fired
  ? '✔ 哨兵通过：判据真的会响（上面那些是故意造出来的，不是真故障）'
  : '✘ 哨兵失败：把文字撑出框了它还不报 —— 这套判据是死的，别信它的"通过"'));
process.exit(fired && restored ? 0 : 2);

