/**
 * sync-open-site-patch.mjs —— 把**已打过**的 open-site 补丁就地升级到 lib/patch.mjs 的最新实现
 *
 * 为什么需要它：applyPatches 的幂等判定只看 marker（产物里含 `[hermes 改造:open-site]` 就跳过），
 * 所以规则实现改了之后，重跑 patch / install **不会**更新已打过的产物 —— 它会走了 skipped 分支。
 * 这个脚本负责那段「换实现」的活：直接取 lib/patch.mjs 里当前规则的 next，
 * 整体替换产物中的旧段落，保证**源码与运行副本逐字一致**。
 *
 * 用法：
 *   node tools/sync-open-site-patch.mjs --check   # 只报告一致性（退出码 0=一致 / 1=需同步）
 *   node tools/sync-open-site-patch.mjs --write   # 就地替换（自动备份 + 语法校验）
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { ruleById } from '../lib/patch.mjs';

// 旧段落边界：起始锚点有两个候选 ——
//   ① 原版那句过时注释（说的是"打开 DSH 网站"）② 上一次同步写入的 next 首行
// 之所以要 ②：替换会把 ① 吃掉，只有 ② 才能让这个脚本**可以反复跑**（第二次同步也认得出边界）。
// 结束锚点是紧随其后的下一个注释块，落在替换范围之外，始终有效。
const START_CANDIDATES = [
  '  // 右键菜单「打开网站」：交给**系统默认浏览器**打开',
];
const END = '  // 显示器热更新：';
// 旧实现（点击即冷启动 CLI）的特征串：出现过就说明产物里还是那版
const OLD_MARK = "spawn(HERMES_EXE, ['dashboard'], {";

const args = process.argv.slice(2);
const doCheck = args.includes('--check');
const doWrite = args.includes('--write');
if (!doCheck && !doWrite) {
  console.error('用法：node tools/sync-open-site-patch.mjs --check | --write');
  process.exit(2);
}

const rule = ruleById('open-site');
if (!rule) {
  console.error('[!!] lib/patch.mjs 里找不到 open-site 规则');
  process.exit(2);
}
const file = rule.file;
const next = rule.next;

if (!fs.existsSync(file)) {
  console.error('[!!] 产物不存在：' + file);
  process.exit(2);
}
const src = fs.readFileSync(file, 'utf8');
const rel = file;

// ---- 一致性判定：next 必须作为**整块子串**出现 ----
if (src.includes(next)) {
  console.log('[ok] 已是最新，与 lib/patch.mjs 逐字一致');
  console.log('     ' + rel);
  process.exit(0);
}

if (doCheck) {
  console.log('[!!] 产物里的 open-site 实现与源码不一致 —— 需要同步');
  console.log('     ' + rel);
  console.log('     旧实现特征 ' + JSON.stringify(OLD_MARK) + ' 出现：' + src.includes(OLD_MARK));
  process.exit(1);
}

// ---- 就地替换 ----
const startCandidates = [...START_CANDIDATES, next.split('\n')[0]];
let i = -1;
let hitStart = '';
for (const s of startCandidates) {
  const k = s ? src.indexOf(s) : -1;
  if (k >= 0) { i = k; hitStart = s; break; }
}
const j = i >= 0 ? src.indexOf(END, i) : -1;
if (i < 0 || j < 0) {
  console.error('[!!] 认不出旧段落边界：START=' + (i >= 0) + ' END=' + (j >= 0));
  console.error('     上游可能改过这段，别硬替换 —— 人工看一眼 ' + rel);
  process.exit(2);
}

const out = src.slice(0, i) + next + '\n\n' + src.slice(j);

// ---- 自验：新内容必须在位、旧实现必须消失 ----
const must = [
  '[hermes 改造:open-site]',
  'HERMES_DASHBOARD_URL',
  'panelAlive',
  "'--no-open'",
  "'--skip-build'",
  'HERMES_EXE 不可用',
];
const miss = must.filter((m) => !out.includes(m));
if (miss.length || !out.includes(next)) {
  console.error('[!!] 替换结果自验失败，未写盘。缺：' + miss.join(', ') + (out.includes(next) ? '' : ' [+next 整块]'));
  process.exit(2);
}
if (out.includes(OLD_MARK)) {
  console.error('[!!] 旧实现仍在（' + OLD_MARK + '），未写盘');
  process.exit(2);
}

// ---- 备份 + 写盘 + 语法校验（语法不过就回滚）----
// 用 vm.compileFunction 做校验：它就是 CJS 的包装语义（允许顶层 return），
// 且不需要 spawn 外部进程 —— 在受限沙箱里 `node --check` 会 EBUSY。
const syntaxOk = (text) => {
  try {
    vm.compileFunction(text, [], { filename: file });
    return null;
  } catch (error) {
    return error;
  }
};

const bad = syntaxOk(out);
if (bad) {
  console.error('[!!] 语法校验失败，未写盘：' + String(bad.message || bad));
  process.exit(2);
}
if (syntaxOk(src) && !syntaxOk(out)) {
  console.error('[!!] 替换前语法正常、替换后失败 → 是这次替换的问题，未写盘');
  process.exit(2);
}

const bak = file + '.bak-open-site';
fs.copyFileSync(file, bak);
fs.writeFileSync(file, out);

console.log('[ok] 已同步 open-site 补丁（' + (out.length - src.length >= 0 ? '+' : '') + (out.length - src.length) + ' 字符）');
console.log('     边界锚点：' + JSON.stringify(hitStart.slice(0, 40) + '…'));
console.log('     备份：' + bak);
console.log('     语法校验：通过（vm.compileFunction）');
