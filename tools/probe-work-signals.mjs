#!/usr/bin/env node
/**
 * probe-work-signals.mjs —— 核对 workState() 依赖的真实表结构/字段取值
 * ---------------------------------------------------------------------------
 * 写 SQL 之前先问数据库，不问记忆。用法：
 *   node tools/probe-work-signals.mjs            # 结构 + 样本
 *   node tools/probe-work-signals.mjs --live     # 只看最近 5 分钟，模拟判据输出
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DB } from '../lib/paths.mjs';

function open() {
  try { return new DatabaseSync(STATE_DB, { readOnly: true }); }
  catch {
    const tmp = path.join(os.tmpdir(), `hermes-probe-${Date.now()}.db`);
    fs.copyFileSync(STATE_DB, tmp);
    return new DatabaseSync(tmp, { readOnly: true });
  }
}

const db = open();
const show = (t) => {
  console.log(`\n=== ${t} ===`);
  try {
    console.log(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}`).join('  '));
  } catch (e) { console.log('ERR ' + e.message); }
};

console.log('DB =', STATE_DB);
console.log('tables =', db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(', '));
show('sessions');
show('messages');

console.log('\n=== sessions 最近 6 ===');
try {
  for (const r of db.prepare(`
    SELECT id, source, model, last_activity_at, ended_at, end_reason,
           substr(COALESCE(last_activity_description,''),1,70) AS descr
      FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 6`).all()) {
    console.log(' ', JSON.stringify(r));
  }
} catch (e) { console.log('ERR ' + e.message); }

console.log('\n=== messages 最近 10 ===');
try {
  for (const r of db.prepare(`
    SELECT id, session_id, role, tool_name, finish_reason, timestamp,
           display_kind, substr(COALESCE(content,''),1,50) AS c,
           substr(COALESCE(tool_calls,''),1,120) AS tc
      FROM messages ORDER BY timestamp DESC LIMIT 10`).all()) {
    console.log(' ', JSON.stringify(r));
  }
} catch (e) { console.log('ERR ' + e.message); }

console.log('\n=== tool_name 分布（近 200 条） ===');
try {
  for (const r of db.prepare(`
    SELECT tool_name, COUNT(*) c FROM (SELECT tool_name FROM messages ORDER BY timestamp DESC LIMIT 200)
     WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC`).all()) {
    console.log(`  ${r.tool_name}\t${r.c}`);
  }
} catch (e) { console.log('ERR ' + e.message); }

console.log('\n=== 每个工具的 arguments 真实键（全量扫，不抽样） ===');
try {
  const byTool = new Map();
  for (const r of db.prepare(`
    SELECT tool_calls FROM messages
     WHERE role='assistant' AND tool_calls IS NOT NULL AND tool_calls != ''`).all()) {
    let arr; try { arr = JSON.parse(r.tool_calls); } catch { continue; }
    if (!Array.isArray(arr)) arr = [arr];
    for (const c of arr) {
      const name = c?.function?.name;
      if (!name) continue;
      let keys = [];
      try { keys = Object.keys(JSON.parse(c.function.arguments || '{}')); } catch { keys = ['__unparsable__']; }
      if (!byTool.has(name)) byTool.set(name, { n: 0, keys: new Map() });
      const e = byTool.get(name);
      e.n += 1;
      for (const k of keys) e.keys.set(k, (e.keys.get(k) || 0) + 1);
    }
  }
  for (const [name, e] of [...byTool.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const ks = [...e.keys.entries()].map(([k, c]) => `${k}:${c}`).join(' ');
    console.log(`  ${name} (${e.n})\t${ks}`);
  }
} catch (e) { console.log('ERR ' + e.message); }

console.log('\n=== last_activity_description 样本 + provenance ===');
try {
  for (const r of db.prepare(`
    SELECT source, last_activity_provenance AS prov,
           substr(last_activity_description,1,60) AS d, COUNT(*) c
      FROM sessions WHERE last_activity_description IS NOT NULL AND last_activity_description != ''
     GROUP BY d ORDER BY c DESC LIMIT 25`).all()) {
    console.log(`  [${r.source}] prov=${r.prov} n=${r.c}  ${r.d}`);
  }
} catch (e) { console.log('ERR ' + e.message); }

console.log('\n=== 有多少会话填了 descr（按 source） ===');
try {
  for (const r of db.prepare(`
    SELECT source, COUNT(*) total,
           SUM(CASE WHEN last_activity_description IS NOT NULL AND last_activity_description != '' THEN 1 ELSE 0 END) filled
      FROM sessions GROUP BY source`).all()) {
    console.log(`  ${r.source}: ${r.filled}/${r.total}`);
  }
} catch (e) { console.log('ERR ' + e.message); }

if (process.argv.includes('--live')) {
  const since = new Date(Date.now() - 300_000).toISOString();
  console.log('\n=== 最近 5 分钟消息（timestamp >= ISO 比较） ===');
  try {
    for (const r of db.prepare(`
      SELECT role, tool_name, finish_reason, timestamp FROM messages
       WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 20`).all(since)) {
      console.log(' ', JSON.stringify(r));
    }
  } catch (e) { console.log('ERR ' + e.message); }
}

db.close();
