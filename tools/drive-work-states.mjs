#!/usr/bin/env node
/**
 * drive-work-states.mjs —— 端到端驱动 6 档（宿主 → 客户端 → 动画/气泡）
 * ---------------------------------------------------------------------------
 * 为什么需要它：真实 Hermes 现在空闲，不会自己产生活动；而 waiting / error 这两档
 * 真跑一次也很难稳定复现。所以这里造一条**可控时间线**，把 6 档在一个脚本里走一遍。
 *
 * ⚠ 这不是"造数据糊弄测试"：
 *   ▪ 目标库的 schema 从真库的 sqlite_master **逐条 DDL 抄过来**（不是手写建表）
 *   ▪ 每个场景的会话行/消息行都是从真库 **克隆真实行再改时间戳**（不是凭空捏 JSON）
 *   ▪ 被测的是**真管线**：宿主照常读库、照样算、照样写 host.log；只是数据换成了受控的
 * 判据逻辑本身的正确性由 tools/test-work-state.mjs 用真实历史行回放验证（T1~T10）。
 *
 * 用法：
 *   node tools/drive-work-states.mjs --build            只建假库，打印路径
 *   node tools/drive-work-states.mjs --run              驱动 6 档并断言 HTTP 返回
 *   node tools/drive-work-states.mjs --run --step 4000  每档停留 4s（默认 3500）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATE_DB } from '../lib/paths.mjs';

const HOST = process.env.PET_HOST_URL || 'http://127.0.0.1:3080/dsh-pet-7340';
const DIR = path.join(os.tmpdir(), 'hermes-drive');
const FAKE = path.join(DIR, 'state.db');
const iStep = process.argv.indexOf('--step');
const STEP_MS = iStep >= 0 ? Math.max(500, Number(process.argv[iStep + 1]) || 3500) : 3500;

const nowS = () => Math.floor(Date.now() / 1000);

/** 建假库：schema 来自真库 DDL，种子行来自真库真实行 */
function build() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.rmSync(FAKE, { force: true });

  const src = new DatabaseSync(STATE_DB, { readOnly: true });
  const dst = new DatabaseSync(FAKE);
  // WAL：宿主是另一个进程、每秒来读一次，默认 rollback journal 下写事务会挡住读
  try { dst.exec('PRAGMA journal_mode = WAL'); } catch {}

  // ① schema：只抄宿主真正会查的两张表的 DDL，且让被引用的表先建。
  //    不抄 FTS5 虚拟表及其触发器 —— 它们由 virtual table 自动派生 shadow 表（抄了会"已存在"），
  //    触发器又会反过来引用 FTS 表；而 workState() 只读 sessions / messages，与它们无关。
  const ddl = src.prepare(`
    SELECT name, sql FROM sqlite_master
     WHERE type='table' AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
       AND name IN ('system_prompts','sessions','messages')`).all();
  // 顺序必须是「被引用者在前」：sessions.system_prompt_hash → system_prompts.hash（外键默认开）
  const order = { system_prompts: 0, sessions: 1, messages: 2 };
  ddl.sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9));
  for (const r of ddl) dst.exec(r.sql);
  const made = ddl.map((r) => r.name).join(', ');
  console.log('  假库表：' + (made || '(空！)'));
  for (const need of ['system_prompts', 'sessions', 'messages']) {
    if (!ddl.some((r) => r.name === need)) throw new Error(`假库缺少 ${need}，后面没法测`);
  }

  // ② 种子：克隆真库真实行（避免手写 NOT NULL 字段，也避免我"以为"某字段长什么样）
  const sessRow = { ...src.prepare(`SELECT * FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1`).get() };
  const msgRow = { ...src.prepare(`SELECT * FROM messages WHERE role='assistant' LIMIT 1`).get() };
  // 外键：parent_session_id 指向别的不存在的会话 → 清掉（与工作状态无关）
  if ('parent_session_id' in sessRow) sessRow.parent_session_id = null;
  // 外键：system_prompt_hash 要能在 system_prompts 里找到父行 → 只克隆被引用的那一行（全表可能很大）
  if (sessRow.system_prompt_hash) {
    const sp = src.prepare(`SELECT * FROM system_prompts WHERE hash = ?`).get(sessRow.system_prompt_hash);
    if (sp) {
      dst.prepare(`INSERT INTO system_prompts (hash, prompt) VALUES (?, ?)`).run(sp.hash, sp.prompt);
    } else {
      sessRow.system_prompt_hash = null; // 父行不在 → 只能清空，否则外键拦
    }
  }
  fs.writeFileSync(path.join(DIR, 'seed-session.json'), JSON.stringify(sessRow));
  fs.writeFileSync(path.join(DIR, 'seed-message.json'), JSON.stringify(msgRow));

  src.close();
  dst.close();
  return { fake: FAKE, seedSession: sessRow, seedMsg: msgRow };
}

/** 往假库里写一个场景（一个独立会话 + 若干消息）。
 *  ⚠ 时间必须是**写库那一刻**才算（N），不能在 scenes() 里一次性算好 ——
 *    否则所有场景的 last_activity_at 相同，宿主 ORDER BY 撞车会挑到别的会话。 */
function writeScene(dst, seed, sc) {
  const N = nowS();
  // 每个场景前清库：场景要代表"系统此刻的整体处境"，而不是"在上一场景之上再叠一个"。
  // （踩过：不清库时 idle 场景写的是 600 秒前的会话，结果宿主正确地挑了上一场景更新的会话 → 误报失败）
  dst.exec('DELETE FROM messages');
  dst.exec('DELETE FROM sessions');
  const over = typeof sc.over === 'function' ? sc.over(N) : sc.over;
  const msgs = typeof sc.msgs === 'function' ? sc.msgs(N) : sc.msgs;
  const s = { ...seed.session, ...over, id: sc.key };
  dst.prepare(`INSERT INTO sessions (${Object.keys(s).join(',')}) VALUES (${Object.keys(s).map(() => '?').join(',')})`)
     .run(...Object.values(s));
  for (const m of msgs) {
    // session_id 必须钉死成本场景的 id，否则克隆来的模板值会把消息挂到真会话上
    const row = { ...seed.message, ...m, session_id: sc.key };
    const cols = Object.keys(row).filter((c) => c !== 'id');
    dst.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
       .run(...cols.map((c) => row[c]));
  }
}

const calls = (name, args) => JSON.stringify([{ id: 'c1', call_id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]);

/** 6 档 + descr 覆盖 + cron 结束 + 空闲。over/msgs 都收「写库时刻 N」当参数 */
function scenes() {
  return [
    {
      key: 'thinking', expect: 'thinking',
      over: (N) => ({ source: 'cli', title: '帮我看一下这个报错', last_activity_at: N, last_activity_description: '', ended_at: null }),
      msgs: (N) => [{ role: 'user', content: '帮我看一下这个报错', timestamp: N }],
    },
    {
      key: 'working', expect: 'working',
      over: (N) => ({ source: 'cli', title: '改一下配置', last_activity_at: N, last_activity_description: '', ended_at: null }),
      msgs: (N) => [
        { role: 'assistant', content: '', tool_calls: calls('write_file', { path: 'C:\\Hermes\\scripts\\run-dsh-pet-install.cmd', content: 'x' }), finish_reason: 'tool_calls', timestamp: N },
      ],
    },
    {
      key: 'result', expect: 'result',
      over: (N) => ({ source: 'cli', title: '跑一下脚本', last_activity_at: N, last_activity_description: '', ended_at: null }),
      msgs: (N) => [
        { role: 'tool', tool_name: 'write_file', content: JSON.stringify({ bytes_written: 771, exit_code: 0, error: null }), timestamp: N },
        { role: 'assistant', content: '', tool_calls: calls('write_file', { path: 'a.md' }), finish_reason: 'tool_calls', timestamp: N - 3 },
      ],
    },
    {
      key: 'waiting', expect: 'waiting',
      over: (N) => ({ source: 'cli', title: '要不要删掉这些文件', last_activity_at: N, last_activity_description: '', ended_at: null }),
      msgs: (N) => [
        { role: 'assistant', content: '', tool_calls: calls('clarify', { question: '这 8 个 plugin.bak-* 要清理吗？', choices: ['清理', '留着'] }), finish_reason: 'tool_calls', timestamp: N },
      ],
    },
    {
      key: 'error', expect: 'error',
      over: (N) => ({ source: 'cli', title: '装一下依赖', last_activity_at: N, last_activity_description: '', ended_at: null }),
      msgs: (N) => [{ role: 'tool', tool_name: 'terminal', content: JSON.stringify({ output: 'npm error code EALLOWGIT', exit_code: 1, error: null }), timestamp: N }],
    },
    {
      key: 'success', expect: 'success',
      over: (N) => ({ source: 'cli', title: '把 README 补一下', last_activity_at: N, last_activity_description: '', ended_at: null }),
      msgs: (N) => [{ role: 'assistant', content: '已经写好了。', tool_calls: null, finish_reason: 'stop', timestamp: N }],
    },
    {
      key: 'descr-thinking', expect: 'thinking',
      over: (N) => ({ source: 'cli', title: '聊聊下一步', last_activity_at: N, last_activity_description: 'starting API call #1', ended_at: null }),
      msgs: (N) => [{ role: 'user', content: '聊聊下一步', timestamp: N - 30 }],
    },
    {
      key: 'cron-success', expect: 'success',
      over: (N) => ({ source: 'cron', title: '每日小结 · Sep 25 21:10', last_activity_at: N, last_activity_description: '', ended_at: N }),
      msgs: (N) => [{ role: 'assistant', content: '日志已生成', tool_calls: null, finish_reason: 'stop', timestamp: N - 5 }],
    },
    {
      key: 'idle', expect: null,
      over: (N) => ({ source: 'cli', title: '早就结束了', last_activity_at: N - 600, last_activity_description: '', ended_at: null }),
      msgs: (N) => [{ role: 'assistant', content: '好了', tool_calls: null, finish_reason: 'stop', timestamp: N - 600 }],
    },
  ];
}

const mode = process.argv.includes('--build') ? 'build'
  : process.argv.includes('--run') ? 'run'
  : process.argv.includes('--hold') ? 'hold'
  : 'help';
const holdIdx = process.argv.indexOf('--hold');
const HOLD_KEY = holdIdx >= 0 ? process.argv[holdIdx + 1] : null;
export { build, writeScene, scenes, FAKE, DIR };

// 直接跑本文件时才执行 CLI 分支（被 import 当模块用时不要执行）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (!isMain) {
  // 被当作模块 import：什么都不做，只导出
} else if (mode === 'help') { console.log('用法: node tools/drive-work-states.mjs --build | --run [--step ms] | --hold <场景key>'); process.exit(0); }
else if (mode === 'build') {
  const b = build();
  console.log('假库已建：' + b.fake);
  console.log('（schema 抄自真库 DDL，种子行克隆自真库真实行）');
  process.exit(0);
} else if (mode === 'hold') {
  // 只写一个场景就停住 —— 便于外部对着这一帧量气泡 / 截图
  if (!fs.existsSync(FAKE)) build();
  const seedFile = path.join(DIR, 'seed-session.json');
  const seed = {
    session: JSON.parse(fs.readFileSync(seedFile, 'utf8')),
    message: JSON.parse(fs.readFileSync(path.join(DIR, 'seed-message.json'), 'utf8')),
  };
  const want = scenes().find((s) => s.key === HOLD_KEY);
  if (!want) {
    console.log('没有这个场景：' + HOLD_KEY);
    console.log('可选：' + scenes().map((s) => s.key).join(', '));
    process.exit(2);
  }
  const dst = new DatabaseSync(FAKE);
  writeScene(dst, seed, want);
  dst.close();
  console.log(`已写入场景「${HOLD_KEY}」，期望 state=${want.expect}`);
  process.exit(0);
} else {
  // ---- run：逐场景写库 → 等一拍 → 打 HTTP 看宿主说了什么 ----
  // 每次都重建假库：场景用的是固定 key，复用旧库会撞主键
  build();
  {
  const seedFile = path.join(DIR, 'seed-session.json');
  const seed = {
    session: JSON.parse(fs.readFileSync(seedFile, 'utf8')),
    message: JSON.parse(fs.readFileSync(path.join(DIR, 'seed-message.json'), 'utf8')),
  };
  const dst = new DatabaseSync(FAKE);

  let okCount = 0, badCount = 0;
  console.log(`\n驱动 6 档（每个场景写库后等 ${STEP_MS}ms 再问宿主）`);
  console.log(`宿主：${HOST}\n`);
  console.log('  场景               期望      实际      task                         why');
  console.log('  ' + '-'.repeat(92));

  for (const sc of scenes()) {
    writeScene(dst, seed, sc);
    await new Promise((r) => setTimeout(r, STEP_MS));
    let got = null;
    try {
      const res = await fetch(`${HOST}/work-status`);
      got = await res.json();
    } catch (e) {
      console.log(`  ${sc.key.padEnd(18)} 请求失败：${e.message}`);
      console.log('  （宿主没在跑？先用 HERMES_STATE_DB 指向假库把它起起来）');
      dst.close();
      process.exit(1);
    }
    const pass = got.state === sc.expect;
    if (pass) okCount++; else badCount++;
    console.log(`  ${pass ? '[ok]' : '[!!]'} ${sc.key.padEnd(15)} ${String(sc.expect).padEnd(8)} ${String(got.state).padEnd(8)} ${String(got.task || '').padEnd(28)} ${got.why}`);
  }

  // ts 门控：不动库，连问两次，ts 必须一样（否则每秒重启动画）
  const a = await (await fetch(`${HOST}/work-status`)).json();
  await new Promise((r) => setTimeout(r, 1300));
  const b = await (await fetch(`${HOST}/work-status`)).json();
  const tsOk = a.ts === b.ts;
  if (tsOk) okCount++; else badCount++;
  console.log(`  ${tsOk ? '[ok]' : '[!!]'} ${'ts-门控'.padEnd(15)} 不变     ${a.ts === b.ts ? '不变' : '变了'}     ts=${a.ts} vs ${b.ts}`);

  dst.close();
  console.log(`\n结果：通过 ${okCount} / 失败 ${badCount}`);
  process.exit(badCount ? 1 : 0);
  }
}
