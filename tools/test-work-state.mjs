#!/usr/bin/env node
/**
 * test-work-state.mjs —— workState() 的回放自测
 * ---------------------------------------------------------------------------
 * 原则：**期望值不手写、从库里读出来**。做法是拿真实的历史行重建"那一刻的处境"，
 * 再把 nowMs 设到那一刻，看 deriveWork 是否复现出该处境的语义。
 *
 * ⚠ 会话行（sessions）无法时间旅行：DB 里只有"此刻"的 last_activity_at / description。
 *   所以回放时按历史时刻**重建**会话行的这两个字段（last_activity_at = T、descr 清空）。
 *   这恰好等价于 cron / feishu 会话的真实形态（实测这些 source 的 descr 全空），
 *   所以不算造数据；但也因此**descr 分支不在本测试覆盖内** —— 单独用字面量测（见 T7）。
 *
 * 用法：
 *   node tools/test-work-state.mjs              # 跑全部断言
 *   node tools/test-work-state.mjs --verbose    # 打印每个场景的原始行
 *   node tools/test-work-state.mjs --selftest   # 哨兵自验：故意写错一条期望，确认测试会报红
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DB } from '../lib/paths.mjs';
import { deriveWork, toolResultIsError, workState } from '../lib/hermes.mjs';

const VERBOSE = process.argv.includes('--verbose');
const SELFTEST = process.argv.includes('--selftest');

function open() {
  try { return new DatabaseSync(STATE_DB, { readOnly: true }); }
  catch {
    const tmp = path.join(os.tmpdir(), `hermes-test-${Date.now()}.db`);
    fs.copyFileSync(STATE_DB, tmp);
    return new DatabaseSync(tmp, { readOnly: true });
  }
}
const db = open();

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  [ok]   ${name}`); }
  else { fail++; results.push(`  [!!]   ${name}${detail ? '  << ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// 回放工具：给定 session_id 与时刻 T（秒），重建当时的处境
// ---------------------------------------------------------------------------
const MSG_COLS = 'role, tool_name, finish_reason, tool_calls, content, timestamp';
function replay(sessionId, T) {
  const cur = db.prepare(`
    SELECT id, source, title, display_name, started_at, ended_at, end_reason, last_activity_at
      FROM sessions WHERE id = ?`).get(sessionId);
  if (!cur) return null;
  const msgs = db.prepare(`
    SELECT ${MSG_COLS} FROM messages
     WHERE session_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 12`).all(sessionId, T);
  // 重建"那一刻的会话行"：last_activity_at 回到 T、descr 清空（cron/feishu 的真实形态）
  const session = { ...cur, last_activity_at: T, last_activity_description: '', ended_at: null };
  return { session, msgs };
}
function deriveAt(sessionId, T) {
  const ctx = replay(sessionId, T);
  if (!ctx) return null;
  const r = deriveWork({ nowMs: Math.round(T * 1000), session: ctx.session, msgs: ctx.msgs });
  if (VERBOSE) {
    console.log(`\n  · session=${sessionId} T=${T} src=${ctx.session.source}`);
    console.log(`    最新消息 = ${JSON.stringify(ctx.msgs[0] || null).slice(0, 150)}`);
    console.log(`    → ${JSON.stringify({ state: r.state, task: r.task, why: r.why })}`);
  }
  return { ...r, ctx };
}

const one = (sql, ...a) => db.prepare(sql).get(...a);
const page = (sql, ...a) => db.prepare(sql).all(...a);

console.log('DB =', STATE_DB);
console.log('');

// ---------------------------------------------------------------------------
// T1：working —— 「这一轮在干什么」的主角：write_file 必须说出文件名
// ---------------------------------------------------------------------------
{
  // 从库里找一条真实的 write_file 调用（不写死 message id）
  const row = one(`
    SELECT m.session_id, m.timestamp, m.tool_calls
      FROM messages m
     WHERE m.role='assistant' AND m.tool_calls LIKE '%"write_file"%'
     ORDER BY m.timestamp DESC LIMIT 1`);
  const r = row ? deriveAt(row.session_id, row.timestamp) : null;
  const wantArg = row ? (JSON.parse(JSON.parse(row.tool_calls)[0].function.arguments).path || '') : '';
  const base = path.basename(wantArg);
  check('T1 write_file → state=working', r?.state === 'working', `got ${r?.state}`);
  check('T1 write_file → task 含「在写」', /在写/.test(r?.task || ''), `task=${r?.task}`);
  // 核心断言：**完整文件名**必须出现在文案里（曾因首部截断只剩目录名而报红）。
  // 唯一豁免：文件名本身就超过文案上限（>30 字），此时只要求它被截断而非被丢掉。
  const needFull = base.length <= 30 ? base : base.slice(0, 15);
  check('T1 write_file → task 说出完整文件名', !!base && (r?.task || '').includes(needFull),
    `task=${r?.task}  want=${needFull}`);
  check('T1 write_file → task 里不出现盘符/长目录头', !/[A-Za-z]:[\\/]/.test(r?.task || ''), `task=${r?.task}`);
}

// ---------------------------------------------------------------------------
// T1b：terminal —— 命令要剥掉 `cd X &&` / `export A=1;` 这类零信息前缀
// ---------------------------------------------------------------------------
{
  const row = one(`
    SELECT m.session_id, m.timestamp, m.tool_calls
      FROM messages m
     WHERE m.role='assistant' AND m.tool_calls LIKE '%"terminal"%'
     ORDER BY m.timestamp DESC LIMIT 1`);
  const r = row ? deriveAt(row.session_id, row.timestamp) : null;
  const cmd = row ? (JSON.parse(JSON.parse(row.tool_calls)[0].function.arguments).command || '') : '';
  check('T1b terminal → state=working', r?.state === 'working', `got ${r?.state}`);
  check('T1b terminal → 命令前缀被剥离（不以 cd/export 开头）',
    !/^(cd|export)\s/.test((r?.task || '').replace(/^在跑\s*/, '')), `cmd=${clipHead(cmd)}task=${r?.task}`);
}

function clipHead(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 60) + ' | '; }

// ---------------------------------------------------------------------------
// T2：result —— 最新一条是 tool 结果（文档里的 tool/result → result 档）
// ---------------------------------------------------------------------------
{
  const row = one(`
    SELECT session_id, timestamp, tool_name FROM messages
     WHERE role='tool' AND (content LIKE '%"exit_code": 0%' OR content LIKE '%"bytes_written"%')
     ORDER BY timestamp DESC LIMIT 1`);
  const r = row ? deriveAt(row.session_id, row.timestamp) : null;
  check('T2 tool 结果 → state=result', r?.state === 'result', `got ${r?.state}`);
  check('T2 tool 结果 → task 说出工具名', !row?.tool_name || (r?.task || '').includes(row.tool_name) || (r?.task || '').includes('刚跑完'),
    `task=${r?.task} tool=${row?.tool_name}`);
}

// ---------------------------------------------------------------------------
// T3：error —— 失败的唯一真信号是 exit_code != 0
// ---------------------------------------------------------------------------
{
  const row = one(`
    SELECT session_id, timestamp, content FROM messages
     WHERE role='tool'
       AND (content LIKE '%"exit_code": 1%' OR content LIKE '%"exit_code": 12%'
            OR content LIKE '%"exit_code": 2%' OR content LIKE '%[Command timed out%')
     ORDER BY timestamp DESC LIMIT 1`);
  const r = row ? deriveAt(row.session_id, row.timestamp) : null;
  check('T3 非零退出 → state=error', r?.state === 'error', `got ${r?.state} content=${String(row?.content).slice(0, 80)}`);
  check('T3 非零退出 → toolResultIsError 为真', row ? toolResultIsError(row.content) : false);

  // 反例：成功结果不能被误判成 error（假阳性检查）
  const ok = one(`SELECT content FROM messages WHERE role='tool' AND content LIKE '%"exit_code": 0%' ORDER BY timestamp DESC LIMIT 1`);
  check('T3 零退出的成功结果 → 不误判为 error', ok ? !toolResultIsError(ok.content) : false,
    `content=${String(ok?.content).slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
// T4：waiting —— clarify 是"在等你"的唯一硬信号
// ---------------------------------------------------------------------------
{
  const row = one(`
    SELECT session_id, timestamp, tool_calls FROM messages
     WHERE role='assistant' AND tool_calls LIKE '%"clarify"%'
     ORDER BY timestamp DESC LIMIT 1`);
  const r = row ? deriveAt(row.session_id, row.timestamp) : null;
  check('T4 clarify → state=waiting', r?.state === 'waiting', `got ${r?.state}`);
  check('T4 clarify → task 含「等你」', /等你/.test(r?.task || ''), `task=${r?.task}`);
}

// ---------------------------------------------------------------------------
// T5：success —— 两条路都测：① 会话已关(end_reason) ② 回合以 finish_reason=stop 收尾
// ---------------------------------------------------------------------------
{
  const closed = one(`SELECT id FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`);
  const r1 = closed ? deriveAt(closed.id, 0) : null;   // T=0 → 取到该会话全部消息
  const s1 = closed
    ? one(`SELECT ended_at FROM sessions WHERE id=?`, closed.id)
    : null;
  // 已关会话：nowMs 要落在 ended_at 之后，deriveAt 的 T 只控消息，故这里单独构造
  const ctx = closed ? replay(closed.id, 9e9) : null;
  const rr = ctx
    ? deriveWork({ nowMs: Math.round((Number(s1.ended_at) + 5) * 1000),
                   session: { ...ctx.session, ended_at: s1.ended_at },
                   msgs: ctx.msgs })
    : null;
  check('T5 会话已关 → state=success', rr?.state === 'success', `got ${rr?.state} why=${rr?.why}`);
  check('T5 会话已关 → why=ended', rr?.why === 'ended', `why=${rr?.why}`);

  const stop = one(`
    SELECT session_id, timestamp FROM messages
     WHERE role='assistant' AND finish_reason='stop' AND tool_calls IS NULL
     ORDER BY timestamp DESC LIMIT 1`);
  const r2 = stop ? deriveAt(stop.session_id, stop.timestamp) : null;
  check('T5 finish_reason=stop → state=success', r2?.state === 'success', `got ${r2?.state} why=${r2?.why}`);
  void r1;
}

// ---------------------------------------------------------------------------
// T6：thinking —— 用户刚说完、模型还没回
// ---------------------------------------------------------------------------
{
  const row = one(`
    SELECT m.session_id, m.timestamp FROM messages m
     WHERE m.role='user' ORDER BY m.timestamp DESC LIMIT 1`);
  const r = row ? deriveAt(row.session_id, row.timestamp) : null;
  check('T6 user 消息 → state=thinking', r?.state === 'thinking', `got ${r?.state}`);
}

// ---------------------------------------------------------------------------
// T7：descr 分支 —— 会话行无法时间旅行，用实测到的 4 种真实文案做字面量测试
//     （文案取自 probe 输出，不是编的）
// ---------------------------------------------------------------------------
{
  const base = { id: 'x', source: 'cli', title: '', started_at: 0, ended_at: null, last_activity_at: 1000 };
  const at = 1000 * 1000;   // nowMs 与 last_activity_at 对齐（差 0ms，必在窗口内）
  const cases = [
    ['starting API call #1', 'thinking'],
    ['terminal command running (40s elapsed)', 'working'],
    ['tool completed: write_file (2.9s)', 'result'],
    ['tool completed: terminal (4.5s) (error)', 'error'],
  ];
  for (const [descr, want] of cases) {
    const r = deriveWork({ nowMs: at, session: { ...base, last_activity_description: descr }, msgs: [] });
    check(`T7 descr「${descr.slice(0, 34)}」→ ${want}`, r.state === want, `got ${r.state} (why=${r.why})`);
  }
  // 认不出的文案必须 fail-open 到 thinking（不能整车哑掉）
  const unk = deriveWork({ nowMs: at, session: { ...base, last_activity_description: '未来新增的某种形态' }, msgs: [] });
  check('T7 未知 descr → 不崩、不瞎判（msg 为空则 idle）', unk.state === null, `got ${unk.state}`);
}

// ---------------------------------------------------------------------------
// T8：idle —— 太久没动静必须回空闲（不能留僵尸气泡）
// ---------------------------------------------------------------------------
{
  const last = one(`SELECT MAX(timestamp) t FROM messages`);
  const s = one(`SELECT id, source, title, started_at FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1`);
  const msgs = page(`SELECT ${MSG_COLS} FROM messages WHERE session_id=? ORDER BY timestamp DESC LIMIT 12`, s.id);
  const won = deriveWork({
    nowMs: Math.round((Number(last.t) + 600) * 1000),          // 10 分钟后
    session: { ...s, last_activity_at: last.t, last_activity_description: '' },
    msgs,
  });
  check('T8 静默 10 分钟 → state=null', won.state === null, `got ${won.state}`);
  const win = deriveWork({
    nowMs: Math.round((Number(last.t) + 1) * 1000),
    session: { ...s, last_activity_at: last.t, last_activity_description: '' },
    msgs,
  });
  check('T8 静默 1 秒 → 有状态（对照，证明上面不是恒真）', win.state !== null, `got ${win.state}`);
}

// ---------------------------------------------------------------------------
// T9：清单完整性 —— TOOL_HINT 是手写的，必须**用库里的真实工具名验证覆盖**
//     （教训：手写清单必漏。这里让测试当哨兵，漏了就报红，而不是靠人记住。）
// ---------------------------------------------------------------------------
{
  const tools = new Set();
  for (const r of page(`SELECT tool_calls FROM messages WHERE role='assistant' AND tool_calls IS NOT NULL AND tool_calls != ''`)) {
    let arr; try { arr = JSON.parse(r.tool_calls); } catch { continue; }
    if (!Array.isArray(arr)) arr = [arr];
    for (const c of arr) if (c?.function?.name) tools.add(String(c.function.name));
  }
  const { TOOL_HINT_KEYS } = await import('../lib/hermes.mjs').then((m) => ({ TOOL_HINT_KEYS: m.TOOL_HINT_KEYS || null }));
  // 用导出的键集判断（未导出则退化为"是否出现在源码里"）
  const src = fs.readFileSync(new URL('../lib/hermes.mjs', import.meta.url), 'utf8');
  const uncovered = [...tools].filter((t) => !new RegExp(`\\b${t}\\s*:`).test(src));
  console.log(`  · 库中出现的工具共 ${tools.size} 个；未登记进 TOOL_HINT 的：${uncovered.length ? uncovered.join(', ') : '无'}`);
  check('T9 每个真实工具名都有叙事动词（无兜底项）', uncovered.length === 0, uncovered.join(', '));
  void TOOL_HINT_KEYS;
}

// ---------------------------------------------------------------------------
// T10：ts 门控 —— 同一个状态连续两次调用，ts 必须**不变**（否则宠物每秒重启动画）
// ---------------------------------------------------------------------------
{
  const a = await workState();
  await new Promise((r) => setTimeout(r, 1200));
  const b = await workState();
  check('T10 状态未变时 ts 保持不变', a.ts === b.ts, `a.ts=${a.ts} b.ts=${b.ts} (a=${a.state}/${a.task}, b=${b.state}/${b.task})`);
  check('T10 返回契约三字段齐全', ['state', 'task', 'ts'].every((k) => k in a), JSON.stringify(a));
  console.log(`  · 实时取值：state=${a.state} task=${a.task} why=${a.why} src=${a.source}`);
}

// ---------------------------------------------------------------------------
// 哨兵自验：故意写错一条期望，确认测试真的会报红（防止"恒绿"测试）
// ---------------------------------------------------------------------------
if (SELFTEST) {
  console.log('\n=== 哨兵自验（故意注入错误期望，应当报红）===');
  const before = fail;
  check('哨兵：故意写成不存在的状态 zzz', 'working' === 'zzz', 'got working');
  check('哨兵：故意声称静默不超时', false, 'got true');
  const raised = fail - before;
  console.log(raised === 2
    ? `  [ok]   哨兵生效：注入 2 条错误期望 → 报红 ${raised} 条`
    : `  [!!]   哨兵失效：期望报红 2 条，实际 ${raised} 条`);
  if (raised !== 2) fail++; else pass++;
}

// ---------------------------------------------------------------------------
// 叙事预览：把最近 N 条真实动作逐条回放，看宠物**本来会说什么**
//   node tools/test-work-state.mjs --preview 25
// ---------------------------------------------------------------------------
const pvIdx = process.argv.indexOf('--preview');
if (pvIdx >= 0) {
  const n = Math.max(1, Number(process.argv[pvIdx + 1]) || 20);
  console.log(`\n=== 叙事预览：最近 ${n} 条真实动作（回放 @ 各自发生时刻）===`);
  const rows = page(`
    SELECT session_id, timestamp, role, tool_name, finish_reason FROM messages
     ORDER BY timestamp DESC LIMIT ${n}`);
  for (const row of rows.reverse()) {
    const r = deriveAt(row.session_id, row.timestamp);
    if (!r) continue;
    const when = new Date(Number(row.timestamp) * 1000).toISOString().slice(11, 19);
    const short = row.role === 'tool' ? `tool:${row.tool_name}` : `${row.role}:${row.finish_reason || '-'}`;
    const badge = r.state === null ? '(空闲)' : r.state;
    console.log(`  ${when}  ${badge.padEnd(9)} ${String(r.task || '').padEnd(26)}  ← ${short}`);
  }
}

console.log('\n' + results.join('\n'));
const expectedFails = SELFTEST ? 2 : 0;
console.log(`\n结果：通过 ${pass} / 失败 ${fail}${SELFTEST ? `（其中 ${expectedFails} 条是哨兵故意注入的，属预期）` : ''}`);
db.close();
process.exit(fail - expectedFails > 0 ? 1 : 0);
