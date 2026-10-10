#!/usr/bin/env node
/**
 * probe-webm-duration.mjs —— 读 webm 真实时长（无 ffprobe，直接解 EBML）
 * 用途：判断"工作状态"档位动画有多长 —— 决定 ts 变化导致的动画重启是否伤观感。
 * 用法：node tools/probe-webm-duration.mjs <目录> [关键词过滤]
 */
import fs from 'node:fs';
import path from 'node:path';

function readVint(buf, off) {
  const first = buf[off];
  if (first === undefined) return null;
  let len = 1;
  for (let i = 0; i < 8; i++) { if (first & (0x80 >> i)) { len = i + 1; break; } }
  if (first === 0) return null;
  let v = first & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
  return { value: v, len, id: buf.subarray(off, off + len).toString('hex') };
}

/** 深度优先找某个元素 ID 的负载 */
function findElement(buf, targetId, start = 0, end = buf.length, depth = 0) {
  let p = start;
  while (p < end && depth < 8) {
    const id = readVint(buf, p);
    if (!id) return null;
    const size = readVint(buf, p + id.len);
    if (!size) return null;
    const dataStart = p + id.len + size.len;
    const hexId = id.id.replace(/^0+/, '');
    if (hexId === targetId) return { start: dataStart, size: size.value };
    // 只用"已知容器"下钻，避免把随机字节当元素
    if (['18538067', '1549a966', '1a45dfa3', '1654ae6b', 'ae', 'e0'].includes(hexId) && size.value > 0) {
      const inner = findElement(buf, targetId, dataStart, Math.min(dataStart + size.value, end), depth + 1);
      if (inner) return inner;
    }
    if (size.value === 0x7fffffffffffffff) break; // 未知长度容器：无法线性跳过
    p = dataStart + size.value;
  }
  return null;
}

/**
 * ⚠ 坑：Matroska 的 Duration(0x4489) 是**浮点、单位是 TimecodeScale**，不是秒。
 *   TimecodeScale(0x2AD7B1) 默认 1000000（= 1ms），所以 10042 其实是 10.04 秒。
 *   不除就会把"10 秒动画"读成"10042 秒"。
 */
function durationOf(file) {
  const buf = fs.readFileSync(file);
  let scale = 1_000_000; // TimecodeScale 默认值（单位 ns）
  const ts = findElement(buf, '2ad7b1');
  if (ts && ts.size > 0 && ts.size <= 8) {
    let v = 0;
    for (let i = 0; i < ts.size; i++) v = v * 256 + buf[ts.start + i];
    if (v > 0) scale = v;
  }
  const el = findElement(buf, '4489');
  let dur = null;
  if (el) {
    if (el.size === 4) dur = buf.readFloatBE(el.start);
    else if (el.size === 8) dur = buf.readDoubleBE(el.start);
  }
  if (dur === null) {
    for (let i = 0; i + 9 < buf.length; i++) {
      if (buf[i] === 0x44 && buf[i + 1] === 0x89) {
        const asFloat = buf.readFloatBE(i + 3);
        if (asFloat > 0.2 && asFloat < 1e7) { dur = asFloat; break; }
      }
    }
  }
  if (dur === null) return { secs: null, scale };
  return { secs: (dur * scale) / 1e9, scale, raw: dur };
}

const dir = process.argv[2];
const filter = process.argv[3] || '';
if (!dir) { console.error('用法: node tools/probe-webm-duration.mjs <目录> [关键词]'); process.exit(2); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webm') && f.includes(filter));
if (!files.length) { console.error('没有匹配的 webm：' + dir + ' / ' + filter); process.exit(1); }
for (const f of files) {
  const abs = path.join(dir, f);
  const d = durationOf(abs);
  const size = (fs.statSync(abs).size / 1024).toFixed(0);
  const secs = d.secs === null ? '??' : d.secs.toFixed(2);
  console.log(`  ${secs.padStart(6)} s\t${size.padStart(5)} KB\tscale=${d.scale}\t${f}`);
}
