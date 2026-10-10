#!/usr/bin/env node
/**
 * check-patch.mjs —— 补丁体检：这个包能不能打在**目标 dsh-pet 版本**上？
 *
 * 场景：你把本包装到了别的 dsh-pet 版本（或上游又发新版了），想知道那 15 条规则
 * 还能认出几处原文。认不出的规则**不会报错、只会退化成原版行为** —— 所以必须主动体检。
 *
 * 用法：
 *   node tools/check-patch.mjs                    # 体检已安装的 plugin（只读，不写入）
 *   node tools/check-patch.mjs --apply            # 复制到临时目录 → 真打 → 语法校验（仍不碰原目录）
 *   node tools/check-patch.mjs <pluginDir> [--apply]
 *
 * 两层判据（缺一不可）：
 *   ① 锚点命中 —— dryRun 评估「可打 / 已打 / 认不出」
 *   ② 产物正确 —— 真打过之后每个 JS 文件必须是合法语法
 *   **① 全绿不等于 ② 全绿**：锚点可能命中但替换出坏代码，所以 --apply 才有结论。
 *
 * 退出码：0 = 全绿；1 = 有认不出的规则或有语法错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applyPatches } from '../lib/patch.mjs';
import { PLUGIN_DIR } from '../lib/paths.mjs';

const argv = process.argv.slice(2);
const doApply = argv.includes('--apply');
const target = argv.find((a) => !a.startsWith('--')) || PLUGIN_DIR;

if (!fs.existsSync(path.join(target, 'runtime', 'electron-helper'))) {
  console.error(`✘ 这不是一个 dsh-pet plugin 目录：${target}`);
  console.error('  （找不到 runtime/electron-helper/ —— 请指向 %LOCALAPPDATA%\\dsh-pet\\plugin）');
  process.exit(2);
}

/** JSONC 解析：剥行注释 / 块注释 / 尾随逗号。原生 config.jsonc 里有 160+ 行**行内**注释，
 *  只剥行首 `//` 的偷懒写法会连未改动的原生文件都判不过（= 校验器自己的误报）。 */
function stripJsonc(s) {
  let out = '', inStr = false, esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const HELPER_FILES = ['shared-core.js', 'sprite.js', 'main.js', 'events.js', 'renderer.js', 'preload.js'];

/** 语法校验：产物必须是合法 JS。返回不过的文件名数组。 */
function syntaxCheck(root) {
  const H = path.join(root, 'runtime', 'electron-helper');
  const bad = [];
  for (const f of HELPER_FILES) {
    const p = path.join(H, f);
    if (!fs.existsSync(p)) continue;
    try {
      new vm.Script(fs.readFileSync(p, 'utf8'), { filename: p }); // 渲染端就是 <script> 加载
      console.log(`  ✔ ${f}`);
    } catch (e) {
      bad.push(f);
      console.log(`  ✘ ${f}  ${e.message}`);
    }
  }
  const cfgPath = path.join(root, 'assets', 'config.jsonc');
  if (fs.existsSync(cfgPath)) {
    try {
      JSON.parse(stripJsonc(fs.readFileSync(cfgPath, 'utf8')));
      console.log('  ✔ assets/config.jsonc');
    } catch (e) {
      bad.push('config.jsonc');
      console.log(`  ✘ assets/config.jsonc  ${e.message}`);
    }
  }
  return bad;
}

/** 目标 dsh-pet 版本（plugin 目录里没有版本号，读同级的 package.json 碰碰运气） */
function guessVersion(root) {
  for (const rel of ['package.json', '../package.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
      if (j.version) return j.version;
    } catch { /* 没有就算了 */ }
  }
  return null;
}

const ver = guessVersion(target);
console.log('');
console.log('目标：' + target + (ver ? `  （dsh-pet ${ver}）` : ''));
console.log('-'.repeat(64));

// ---- 判据 ① 锚点命中 ----
const res = applyPatches({ quiet: true, pluginDir: target, dryRun: true });
const total = res.applied + res.skipped + res.failed;
console.log(`① 锚点命中：可打 ${res.applied} ｜ 已打 ${res.skipped} ｜ 认不出 ${res.failed} ｜ 共 ${total} 条`);
for (const d of res.details) console.log('     ' + d);

if (res.failed > 0) {
  console.log('');
  console.log(`⚠ 有 ${res.failed} 条认不出原文 —— 它们会**静默退化**成原版行为（不崩，但功能没了）。`);
  console.log('  上游大概改了这些位置；要么按新版本重对锚点，要么接受退化。');
}

// ---- 判据 ② 产物正确（需要真打一遍） ----
let bad = [];
if (doApply) {
  // 在临时副本上打，绝不动原目录
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-check-'));
  const copy = path.join(tmp, 'plugin');
  fs.cpSync(target, copy, { recursive: true });
  console.log('');
  console.log('（在临时副本上真打，不碰原目录：' + copy + '）');
  const ap = applyPatches({ quiet: true, pluginDir: copy, dryRun: false });
  console.log(`   已打 ${ap.applied} ｜ 跳过 ${ap.skipped} ｜ 认不出 ${ap.failed}`);
  console.log('');
  console.log('② 产物语法：');
  bad = syntaxCheck(copy);
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('');
  console.log('② 产物语法：跳过（只做只读评估不写入）。');
  console.log('  想看②请加 --apply —— 它会在临时副本上真打一遍再校验。');
}

console.log('');
console.log('-'.repeat(64));
const ok = res.failed === 0 && bad.length === 0;
if (doApply) console.log(ok ? '通过：锚点全命中、产物全合法' : '不通过：见上面的 ⚠ / ✘');
else console.log(res.failed === 0 ? '① 通过（未做②）' : '① 不通过');
process.exit(ok ? 0 : 1);
