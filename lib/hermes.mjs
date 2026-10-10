/**
 * hermes.mjs —— 一切以本地 Hermes 服务为准
 * ---------------------------------------------------------------------------
 * 这一版把「CC Switch 数据库」换成「Hermes 服务」，数据来源全部是 Hermes 自己写的东西：
 *
 *   1. 服务在不在 → C:\Hermes\gateway.pid + state\gateway.heartbeat（含 pid、30s 更新一次）
 *      —— 与 Hermes 自带的 gateway_watchdog.py 同一条判据，不猜、不轮询进程名当主判据。
 *   2. 用量 → state.db 的 sessions 表（input / output / cache_read / cache_write / api_call_count / estimated_cost_usd）
 *      ⚠ 这张表是**会话累计值**，不是逐日值：直接求和会把 8 月的历史算成"今天"（实测虚高）。
 *      所以「今日」用本地账本做增量：今日 = 当前累计 − 上一次跨天时记下的累计基线。
 *      账本落在 %LOCALAPPDATA%\dsh-pet\user\hermes-usage-ledger.json，跨天自动滚动。
 *   3. 余额 → DeepSeek 官方 /user/balance，凭证从 Hermes 的 .env 读（只读，不回显）。
 *   4. 碎碎念/对话 → DeepSeek /chat/completions（直连，不经 Hermes 网关；秒回、省钱）。
 *   5. 工作状态 → state.db 的 sessions.last_activity_at/_description + messages（谁在跑什么工具、
 *      带什么参数）→ 「这一轮在干什么」。判据全部实测，见本文件「工作状态」一节。
 *
 * 与 CC Switch 版的关键差异：那版是"逐请求日志"（天然按天切分），这版没有逐请求数据，
 * 所以宁可如实标注「自 HH:MM 起」也不虚报——数字纪律优先。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  STATE_DB, HERMES_HOME, HERMES_ENV, GATEWAY_PID, GATEWAY_HEARTBEAT, GATEWAY_LIFECYCLE,
  USAGE_LEDGER, ensureDirs,
} from './paths.mjs';

const pExecFile = promisify(execFile);

/** 心跳间隔 30s（gateway/shutdown_watchdog.py: DEFAULT_HEARTBEAT_INTERVAL_S）；
 *  超过 4 个周期没更新就认为"进程活着但可能卡住"，只提醒、不据此摘掉桌宠。 */
const HEARTBEAT_STALE_MS = 120_000;

// ---------------------------------------------------------------------------
// 读文件小工具
// ---------------------------------------------------------------------------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Hermes 的 .env（KEY=VALUE，容忍 # 注释、引号、CRLF） */
export function envFileVars() {
  const out = {};
  try {
    for (const line of fs.readFileSync(HERMES_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* 没这个文件就当空 */ }
  return out;
}

/** DeepSeek 凭证：进程环境优先，其次 Hermes 的 .env（只读，绝不打印） */
export function deepseekKey() {
  return process.env.DEEPSEEK_API_KEY || envFileVars().DEEPSEEK_API_KEY || '';
}

export function humanTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万';
  return String(n);
}

export function humanDuration(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

// ---------------------------------------------------------------------------
// 服务状态（桌宠出现/消失的唯一判据）
// ---------------------------------------------------------------------------

/**
 * 进程存活检查。**不用 process.kill(pid, 0)**：
 * Hermes 自带的脚本里踩过坑——Python 的 os.kill(pid, 0) 在 Windows 上是被实现成
 * TerminateProcess 的，等于把网关杀掉。这里走 tasklist 查询，只读、零风险。
 */
export async function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    const { stdout } = await pExecFile('tasklist.exe', ['/FI', `PID eq ${n}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 });
    return String(stdout || '').includes(`"${n}"`);
  } catch {
    return false;
  }
}

/**
 * Hermes 服务状态。
 *   主判据：gateway.pid / heartbeat 里的 pid 还活着吗（进程在 = 服务在）
 *   辅助：heartbeat 新鲜度（30s 一跳）、lifecycle.phase
 * 排障/测试可用 PET_HERMES_FORCE=up|down 强制覆盖，不必真去启停服务。
 */
export async function serviceStatus() {
  const forced = process.env.PET_HERMES_FORCE || '';
  const hb = readJson(GATEWAY_HEARTBEAT);
  const pidFile = readJson(GATEWAY_PID);
  const life = readJson(GATEWAY_LIFECYCLE);

  const pid = Number(process.env.PET_HERMES_PID || 0)
    || Number(hb?.pid || 0) || Number(pidFile?.pid || 0) || Number(life?.pid || 0) || null;
  const hbAgeMs = hb?.updated_at ? Date.now() - Date.parse(hb.updated_at) : null;
  const phase = life?.phase || null;
  const startedIso = life?.started_at
    || (hb?.start_time ? new Date(Number(hb.start_time) * 1000).toISOString() : null);
  const startedAtMs = startedIso ? Date.parse(startedIso) : null;

  const base = {
    pid, phase, hbAgeMs,
    startedAt: startedIso,
    uptimeMs: startedAtMs ? Date.now() - startedAtMs : null,
    home: HERMES_HOME,
    pidFileExists: fs.existsSync(GATEWAY_PID),
    heartbeatExists: fs.existsSync(GATEWAY_HEARTBEAT),
  };

  if (forced === 'up') return { ...base, running: true, alive: true, healthy: true, forced: true };
  if (forced === 'down') return { ...base, running: false, alive: false, healthy: false, forced: true };

  const alive = pid ? await pidAlive(pid) : false;
  const fresh = hbAgeMs !== null && hbAgeMs >= 0 && hbAgeMs < HEARTBEAT_STALE_MS;
  return { ...base, alive, fresh, healthy: alive && fresh, running: alive };
}

// ---------------------------------------------------------------------------
// 用量：累计（唯一可读事实）+ 今日增量（本地账本）
// ---------------------------------------------------------------------------
let sqliteMod = null;
async function loadSqlite() {
  if (!sqliteMod) sqliteMod = await import('node:sqlite');
  return sqliteMod;
}

/** 打开 state.db；直读失败（被服务独占/锁住）就复制一份再读 */
export async function withDb(fn) {
  const { DatabaseSync } = await loadSqlite();
  let db, tmp = null;
  try {
    try {
      db = new DatabaseSync(STATE_DB, { readOnly: true });
    } catch {
      tmp = path.join(os.tmpdir(), `hermes-state-${Date.now()}.db`);
      await fsp.copyFile(STATE_DB, tmp);
      db = new DatabaseSync(tmp, { readOnly: true });
    }
    return await fn(db);
  } finally {
    try { db?.close(); } catch {}
    if (tmp) fsp.unlink(tmp).catch(() => {});
  }
}

/** 会话累计用量。tokens = input+output（不含缓存）；tokensWithCache 另算。 */
export async function cumulativeUsage() {
  return withDb((db) => {
    const r = db.prepare(`
      SELECT COUNT(*) AS sessions,
             COALESCE(SUM(input_tokens), 0)       AS input,
             COALESCE(SUM(output_tokens), 0)      AS output,
             COALESCE(SUM(cache_read_tokens), 0)  AS cache_read,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
             COALESCE(SUM(api_call_count), 0)     AS requests,
             COALESCE(SUM(estimated_cost_usd), 0) AS cost
        FROM sessions`).get();
    const input = Number(r.input) || 0;
    const output = Number(r.output) || 0;
    const cacheRead = Number(r.cache_read) || 0;
    const cacheWrite = Number(r.cache_write) || 0;
    return {
      input, output, cacheRead, cacheWrite,
      tokens: input + output,
      tokensWithCache: input + output + cacheRead + cacheWrite,
      requests: Number(r.requests) || 0,
      cost: Number(r.cost) || 0,
      sessions: Number(r.sessions) || 0,
    };
  });
}

/** 最近有活动的会话（doctor / status 用，便于人工对账） */
export async function recentSessions(limit = 5) {
  return withDb((db) => db.prepare(`
    SELECT id, source, model, api_call_count AS calls,
           input_tokens AS input, output_tokens AS output,
           estimated_cost_usd AS cost, last_activity_at AS last
      FROM sessions ORDER BY last_activity_at DESC LIMIT ?`).all(limit));
}

/**
 * 「今天开始过的」模型用量分组之和（session_model_usage 按 first_seen 过滤）。
 * 用途：首日没有账本基线时，用它估算今天的下界 —— first_seen 在今天的分组，
 * 它的计数器全部产生于今天；昨天就存在、今天继续用的分组则**没被算进来**（所以是下界）。
 */
export async function usageFirstSeenSince(epochSeconds) {
  return withDb((db) => {
    const r = db.prepare(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
             COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokensWithCache,
             COALESCE(SUM(input_tokens), 0) AS input,
             COALESCE(SUM(output_tokens), 0) AS output,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
             COALESCE(SUM(api_call_count), 0) AS requests,
             COALESCE(SUM(estimated_cost_usd), 0) AS cost
        FROM session_model_usage WHERE first_seen >= ?`).get(epochSeconds);
    return {
      tokens: Number(r.tokens) || 0,
      tokensWithCache: Number(r.tokensWithCache) || 0,
      input: Number(r.input) || 0,
      output: Number(r.output) || 0,
      cacheRead: Number(r.cacheRead) || 0,
      requests: Number(r.requests) || 0,
      cost: Number(r.cost) || 0,
    };
  });
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hhmm = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function readLedger() { return readJson(USAGE_LEDGER); }
function writeLedger(o) {
  try { ensureDirs(); fs.writeFileSync(USAGE_LEDGER, JSON.stringify(o, null, 2)); }
  catch { /* 写不进去只影响增量口径，不影响累计显示 */ }
}

/**
 * 今日用量 = 当前累计 − 今日基线。
 *   baseline 来源优先级：
 *     ① 跨天时用"昨天最后一次读到的累计"（source=prev-peak，exact=true，等价于全天在线统计）
 *     ② 首日没有历史 → 用「今天开始过的分组之和」把基线往下推（source=first-run-partial，
 *        exact=false，气泡标「今日 ≈」）：至少今天新开的会话是准的，昨天起的会话算不进来 = 下界
 *   peak 只增不减：即使 state.db 被清理/压缩导致累计回退，也不会算出负数。
 */
export async function todayUsage() {
  const cur = await cumulativeUsage();
  const today = localDate();
  let led = readLedger();
  let source;

  if (!led || led.date !== today || !led.baseline) {
    if (led && led.peak) {
      led = { date: today, baseline: led.peak, baselineAt: new Date().toISOString(), source: 'prev-peak', peak: cur };
      source = 'prev-peak';
    } else {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      let already = null;
      try { already = await usageFirstSeenSince(Math.floor(midnight.getTime() / 1000)); }
      catch { /* 拿不到就退回纯粹从此刻开始算 */ }
      const baseline = {};
      for (const k of Object.keys(cur)) {
        baseline[k] = already ? Math.max(0, (Number(cur[k]) || 0) - (Number(already[k]) || 0)) : cur[k];
      }
      led = {
        date: today, baseline, baselineAt: new Date().toISOString(),
        source: already ? 'first-run-partial' : 'first-run', peak: cur,
      };
      source = led.source;
    }
    writeLedger(led);
  } else {
    if (cur.tokens >= (led.peak?.tokens ?? -1)) {
      led.peak = cur;
      writeLedger(led);
    }
    source = led.source || 'prev-peak';
  }

  const diff = (k) => Math.max(0, (Number(cur[k]) || 0) - (Number(led.baseline[k]) || 0));
  return {
    today: {
      tokens: diff('tokens'),
      tokensWithCache: diff('tokensWithCache'),
      input: diff('input'),
      output: diff('output'),
      cacheRead: diff('cacheRead'),
      requests: diff('requests'),
      cost: diff('cost'),
    },
    total: cur,
    exact: source === 'prev-peak',
    approximate: source === 'first-run-partial',
    source,
    baselineAt: led.baselineAt,
    baselineLabel: `自 ${hhmm(led.baselineAt)}`,
    ledgerDate: led.date,
  };
}

// ---------------------------------------------------------------------------
// 余额：DeepSeek 官方接口（带一次重试，抗网络抖动）
// ---------------------------------------------------------------------------
const DS_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
let balCache = { at: 0, data: null, ttl: 0 };

function cacheBalance(v, ttl) {
  balCache = { at: Date.now(), data: v, ttl };
  return v;
}

export async function deepseekBalance({ force = false } = {}) {
  if (!force && balCache.data && Date.now() - balCache.at < balCache.ttl) return balCache.data;

  const key = deepseekKey();
  if (!key) {
    return cacheBalance({
      ok: false, name: 'DeepSeek', message: `没读到 DEEPSEEK_API_KEY（看 ${HERMES_ENV}）`,
    }, 60_000);
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800));
    try {
      const res = await fetch(`${DS_BASE}/user/balance`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) { lastErr = `HTTP ${res.status}`; continue; }
      if (body.error) { lastErr = body.error.message || '接口报错'; continue; }
      const info = Array.isArray(body.balance_infos) ? body.balance_infos[0] : null;
      if (!info) { lastErr = body.message || '余额结构不认识'; continue; }
      const sym = info.currency === 'CNY' ? '¥' : (info.currency === 'USD' ? '$' : `${info.currency} `);
      const total = Number(info.total_balance);
      return cacheBalance({
        ok: true,
        name: 'DeepSeek',
        planName: info.currency === 'CNY' ? '人民币账户' : `${info.currency} 账户`,
        remaining: Number.isFinite(total) ? total : null,
        currency: info.currency || null,
        granted: Number(info.granted_balance) || 0,
        toppedUp: Number(info.topped_up_balance) || 0,
        display: `${sym}${info.total_balance}`,
        isAvailable: body.is_available !== false,
      }, 3 * 60 * 1000);
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? '查询超时' : e.message;
    }
  }
  // 失败只缓存 30 秒，避免一次网络抖动显示三分钟"失败"
  return cacheBalance({ ok: false, name: 'DeepSeek', message: lastErr || '查询失败' }, 30_000);
}

/** 余额压成一行短文案，给气泡用 */
export function balanceLine(b) {
  if (!b) return '余额：未查询';
  if (!b.ok) return `DeepSeek 余额查询失败（${b.message}）`;
  const avail = b.isAvailable === false ? '（账户不可用）' : '';
  return `DeepSeek 余额 ${b.display}${avail}`;
}

// ---------------------------------------------------------------------------
// 碎碎念 / 对话：直连 DeepSeek（凭证取自 Hermes 的 .env）
// ---------------------------------------------------------------------------
export const LLM_MODEL = process.env.PET_LLM_MODEL || 'deepseek-flash';

/**
 * 调一次模型。⚠ 实测坑（2026-09-25）：deepseek-flash 是思考型模型，
 * max_tokens 给小了会被 reasoning 吃光、content 返回空串（实测 24 → 空回复）。
 * 所以这里给足额度，并且**真的空了就加倍重试一次**，而不是把空话丢给用户。
 */
export async function chatOnce(system, messages, { maxTokens = Number(process.env.PET_LLM_MAX_TOKENS || 400) } = {}) {
  const key = deepseekKey();
  if (!key) throw new Error(`没读到 DeepSeek 凭证（${HERMES_ENV} 里的 DEEPSEEK_API_KEY）`);

  let budget = maxTokens;
  let lastUsage = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${DS_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: budget, system, messages }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new Error(`模型通道 HTTP ${res.status} ${j?.error?.message || ''}`.trim());
    if (j.error) throw new Error(j.error.message || '模型通道报错');
    lastUsage = j.usage || {};
    const text = String(j.choices?.[0]?.message?.content || '').trim();
    if (text) return { text, usage: lastUsage, model: LLM_MODEL };
    budget = Math.min(2000, budget * 2);   // 被思考过程吃光 → 加倍再来
  }
  throw new Error(`模型只返回了思考过程（completion=${lastUsage?.completion_tokens ?? '?'} token）`);
}

/** 给碎碎念/对话用的「桌面实况」一行，让宠物说的话跟用量/余额有关 */
export async function usageContextLine() {
  try {
    const t = await todayUsage();
    let bal = null;
    try { bal = await deepseekBalance(); } catch { /* 没有就算了 */ }
    const bits = [`今日已用 ${humanTokens(t.today.tokens)} token（${t.today.requests} 次请求）`];
    if (bal && bal.ok) bits.push(`DeepSeek 余额 ${bal.display}`);
    bits.push(`累计 ${humanTokens(t.total.tokens)} token`);
    if (!t.exact) bits.push(`今日统计${t.baselineLabel}起`);
    return `【桌面实况，需要时可自然引用，不必逐条念】${bits.join('；')}。`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 工作状态（L0 底座 + L1 叙事）——「这一轮在干什么」
// ---------------------------------------------------------------------------
/**
 * 契约（来自 plugin/runtime/electron-helper/shared-core.js，**不可改**）：
 *   WORK_STATUS_STATES = thinking | working | result | waiting | success | error
 *   GET /dsh-pet-7340/work-status → { state, task, ts }；客户端 1s 轮询、超时 10s。
 *   档位索引 thinking0 / working1 / result2 / waiting3 / success4 / error5，对应
 *   animations.events.workStatus 的 6 个槽位。
 *
 * ⚠⚠ ts 的语义是**事件戳**，不是「当前时间」。容器里 `ts !== workBaseline` 才 workTick++，
 *   而每一次 workTick 都会 `stopMove()` + 重新挑动画（events.js onWorkTick）。所以 ts 取
 *   Date.now() 会让宠物**每秒重启一遍动画**（永远播不完第一帧之后）。这里用 lastEmit 门控：
 *   key = `state|task`，只有它变了才把 ts 推到当前时间。既保住"状态/文案一变就刷新"，
 *   又不会因为轮询本身制造事件。
 *
 * 判据全部来自 state.db 实测（`node tools/probe-work-signals.mjs` 可复现）：
 *   ▪ 时间戳是 REAL 纪元**秒**（不是 ISO 字符串）—— 按字符串比大小会全错，必须 ×1000
 *   ▪ sessions.last_activity_description 只有 cli 会话填（实测 cli 6/16；cron 0/43、
 *     desktop 0/1、feishu 0/8）→ 只能当"更可信的覆盖信号"，绝不能当主源
 *   ▪ 失败判据是 tool 结果里的 `exit_code != 0`（`error` 字段成功时也是 null，光看它漏报）
 *   ▪ sessions.end_reason 实测取值域 = cron_complete(43) / cli_close(2) / agent_close(1) / null(22)
 *     —— **没有 error 变体**，所以不写 end_reason 的错误匹配（那是死代码）
 *   ▪ messages.finish_reason 实测 = tool_calls(1443) / stop(178) / null(16) / verification_required(2)
 */

/** 进行中状态的证据新鲜度窗口：超过就认为"最近没在动" → 空闲 */
const WORK_WINDOW_MS = 180_000;

/** 各档位证据的保鲜上限（ms）。早于它就过期、不再占着气泡 —— 防止"僵尸气泡"挂一整天。 */
const WORK_TTL_MS = {
  thinking: 180_000,
  working: 180_000,
  result: 180_000,
  waiting: 30 * 60_000,   // 等人回话可以等很久（实测 clarify 是唯一的"等你"真信号），但不是无限等
  success: 180_000,
  error: 300_000,
};

/**
 * 工具 → [动词, 叙事参数取键优先序]。
 * ⚠ 键名是从 state.db **全量导出**的真实 arguments 键里挑的，不是凭印象写的：
 *   同一个语义在不同工具上键名不同（patch 用 path、edit 用 file_path），写死一个必漏。
 *   表只影响措辞 —— 未登记的工具走「在调 X」兜底，判据不依赖它，所以缺项是降级不是故障。
 */
const TOOL_HINT = {
  write_file:     ['在写', ['path']],
  patch:          ['在改', ['path']],
  edit:           ['在改', ['file_path', 'path']],
  read_file:      ['在读', ['path']],
  search_files:   ['在翻', ['pattern', 'path']],
  terminal:       ['在跑', ['command']],
  execute_code:   ['在算', ['code']],
  browser_exec:   ['在开浏览器', ['code']],
  vision_analyze: ['在看图', ['question', 'image_url']],
  web_search:     ['在搜', ['query']],
  session_search: ['在翻历史', ['query']],
  memory:         ['在记笔记', ['content']],
  skill_view:     ['在查技能', ['name']],
  skill_manage:   ['在改技能', ['name']],
  cronjob:        ['在设定时任务', ['name', 'prompt']],
  process:        ['在看后台进程', ['command', 'session_id']],
  clarify:        ['在问你', ['question']],
  todo:           ['在列计划', []],
  tool_describe:  ['在查工具', ['name']],
  tool_search:    ['在搜工具', ['query']],
  tool_call:      ['在调', ['name']],
  text_to_speech: ['在配音', ['text']],
};

/** 未登记工具的参数兜底取键序（越靠前越"像目标"、越有信息量） */
const ARG_FALLBACK_KEYS = ['path', 'file_path', 'pattern', 'query', 'name', 'command', 'text', 'image_url'];

/** 这些键的值是路径 → 只说"末两段"，因为**文件名**才是信息，头部目录名谁都知道 */
const PATH_KEYS = new Set(['path', 'file_path', 'resolved_path', 'image_url', 'file_pattern', 'file_glob']);

/** 文案长度：气泡实测 286×183px（5 行），单行约 20 个汉字 —— 超过 2 行就该截 */
const TASK_MAX = 34;
const ARG_MAX = 30;

function clip(s, n = TASK_MAX) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * 把参数值压成"人会说出口的那一小段"。
 * 踩过的坑（tools/test-work-state.mjs T1 报红）：直接对完整路径做首部截断，
 * 得到 `在写 C:\Hermes\scripts\run…` —— 把**文件名**切掉了，等于没说。
 */
function shortArg(key, value) {
  let v = String(value).replace(/\s+/g, ' ').trim();
  if (!v) return '';
  if (PATH_KEYS.has(key)) {
    v = v.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
    const segs = v.split('/').filter(Boolean);
    const base = segs[segs.length - 1] || '';
    const two = segs.slice(-2).join('/');
    // 文件名优先（"在写 hermes.mjs" 比 "在写 lib/hermes.mjs" 更好读）；
    // 只有"父目录/文件名"也放得下时才带上父目录，否则宁可只要文件名。
    v = two.length <= ARG_MAX ? two : (base || two);
    return clip(v, ARG_MAX);
  }
  if (key === 'command') {
    // 剥掉无信息量的前缀（cd X && / export A=1;）—— 它们几乎每个命令都有，占了额度
    v = v.replace(/^\s*(?:cd\s+[^&;|]+(?:&&|;|\|\|)\s*)+/i, '')
         .replace(/^\s*(?:export\s+[^&;|]+(?:&&|;)\s*)+/i, '')
         .replace(/^\s*(?:set\s+-e\s*;?\s*)+/i, '')
         .trim();
    return clip(v, ARG_MAX);
  }
  return clip(v, ARG_MAX);
}

/** 从 arguments（JSON 字符串）里挑出最值得说出口的那个值 */
function narrateArg(raw, keys) {
  let o;
  try { o = JSON.parse(raw || '{}'); } catch { return ''; }
  if (!o || typeof o !== 'object') return '';
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return shortArg(k, v);
    if (Array.isArray(v) && v.length) return `${v.length} 项`;
  }
  return '';
}

/** assistant 消息的 tool_calls → [{name, rawArgs}]（实测结构：数组，元素 .function.name/.arguments） */
function parseCalls(raw) {
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) arr = [arr];
  const out = [];
  for (const c of arr) {
    const name = c?.function?.name || c?.name;
    if (name) out.push({ name: String(name), rawArgs: c?.function?.arguments ?? c?.arguments ?? '' });
  }
  return out;
}

/**
 * tool 结果算不算失败。实测形状：
 *   成功 {"output": "...", "exit_code": 0, "error": null}
 *   失败 {"output": "...", "exit_code": 124, "error": null}   ← error 仍是 null，只能看 exit_code
 *   超时 {"output": "[Command timed out after 120s]", "exit_code": 124, ...}
 */
export function toolResultIsError(content) {
  const s = String(content || '');
  if (!s) return false;
  if (/\[Command timed out/i.test(s)) return true;
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object') {
      if (o.error !== null && o.error !== undefined && String(o.error).trim() !== '') return true;
      const ec = Number(o.exit_code);
      if (Number.isFinite(ec) && ec !== 0) return true;
      return false;
    }
  } catch { /* 不是 JSON：退到正则 */ }
  const m = s.match(/"exit_code"\s*:\s*(-?\d+)/);
  return !!m && Number(m[1]) !== 0;
}

/**
 * 纯函数：由「当前时间 + 会话行 + 该会话最近的若干消息」推出 {state, task, tsMs, why}。
 * 抽成纯函数是为了能拿**真实历史行**做回放自测（tools/test-work-state.mjs），不必起服务。
 */
export function deriveWork({ nowMs, session, msgs }) {
  const idle = { state: null, task: null, tsMs: 0, why: 'idle' };
  if (!session) return idle;

  const list = Array.isArray(msgs) ? msgs : [];
  const newest = list[0] || null;
  const lastActMs = Math.round((Number(session.last_activity_at) || Number(session.started_at) || 0) * 1000);
  const newestMs = newest ? Math.round(Number(newest.timestamp) * 1000) : 0;
  const evidenceMs = Math.max(lastActMs, newestMs);
  if (!evidenceMs) return idle;
  if (nowMs - evidenceMs > WORK_WINDOW_MS) return idle; // 最近连动都没动 → 空闲

  const isCron = String(session.source || '') === 'cron';
  const title = clip(session.title || session.display_name || '', 18);
  /** 刚接了用户消息：在琢磨怎么回答 */
  const thinkReply = title ? `在想怎么回：${title}` : '在想怎么回你';
  /** 回合中途在思考（等模型返回）：跟"回谁的话"无关 */
  const thinkNext = title ? `在想：${title}` : '在想下一步';
  const ended = Number(session.ended_at) || 0;

  let res = idle;

  if (ended) {
    // ① 会话已关：这一轮真的结束了（end_reason 实测只有 cron_complete / cli_close / agent_close）
    const endedMs = Math.round(ended * 1000);
    const bad = !!newest && newest.role === 'tool' && toolResultIsError(newest.content);
    res = bad
      ? { state: 'error', task: '收尾时出错了', tsMs: endedMs, why: 'ended-error' }
      : { state: 'success', task: isCron ? '定时任务跑完一轮' : '这一轮搞定了', tsMs: endedMs, why: 'ended' };
  } else {
    const calls = newest && newest.role === 'assistant' ? parseCalls(newest.tool_calls) : [];

    // ② 最新动作是 clarify → 真的在等你回话（waiting 唯一的硬信号）
    const ask = calls.find((c) => c.name === 'clarify');
    if (ask) {
      const q = narrateArg(ask.rawArgs, ['question']);
      res = { state: 'waiting', task: clip(q ? `在等你回话：${q}` : '在等你回话'), tsMs: newestMs, why: 'clarify' };
    } else {
      // ③ 会话自述比消息更新时才信它（只有 cli 会话填，实测 6/16）
      const descr = String(session.last_activity_description || '').trim();
      const byDescr = descr && lastActMs >= newestMs ? describeState(descr, thinkNext) : null;
      if (byDescr) {
        res = { ...byDescr, tsMs: lastActMs, why: 'descr' };
      } else if (!newest) {
        res = idle;
      } else if (newest.role === 'user') {
        // 用户刚说完，模型还没回 → 在想
        res = { state: 'thinking', task: thinkReply, tsMs: newestMs, why: 'user' };
      } else if (newest.role === 'tool') {
        // 工具刚交结果 —— 这正是文档里的 tool/result → result 档
        const nm = newest.tool_name || '工具';
        const bad = toolResultIsError(newest.content);
        res = {
          state: bad ? 'error' : 'result',
          task: clip(bad ? `${nm} 出错了` : `刚跑完 ${nm}`),
          tsMs: newestMs,
          why: `tool:${nm}`,
        };
      } else if (newest.role === 'assistant') {
        if (calls.length > 1) {
          res = { state: 'working', task: `在连做 ${calls.length} 个动作`, tsMs: newestMs, why: 'multi' };
        } else if (calls.length === 1) {
          // ★ L1 的主角：说出"在写 xxx.md"
          const c = calls[0];
          const hint = TOOL_HINT[c.name];
          const verb = hint ? hint[0] : `在调 ${c.name}`;
          const arg = narrateArg(c.rawArgs, hint ? hint[1] : ARG_FALLBACK_KEYS);
          res = { state: 'working', task: clip(arg ? `${verb} ${arg}` : verb), tsMs: newestMs, why: `call:${c.name}` };
        } else if (String(newest.finish_reason || '') === 'stop') {
          // 纯文本收尾（没有工具调用）→ 这一轮完成
          res = { state: 'success', task: isCron ? '定时任务跑完一轮' : '这一轮搞定了', tsMs: newestMs, why: 'stop' };
        } else {
          res = { state: 'thinking', task: thinkNext, tsMs: newestMs, why: 'assistant' };
        }
      }
    }
  }

  if (!res.state) return idle;
  const ttl = WORK_TTL_MS[res.state] ?? WORK_WINDOW_MS;
  return nowMs - res.tsMs > ttl ? idle : res;
}

/** 把 Hermes 自己写的 last_activity_description 翻成档位（实测只有这 4 种形态） */
function describeState(descr, thinkTask) {
  if (/^starting api call/i.test(descr)) return { state: 'thinking', task: thinkTask };
  const elapsed = descr.match(/running \(([^)]*elapsed)\)/i);
  if (elapsed) return { state: 'working', task: `在跑命令（${elapsed[1]}）` };
  if (/^tool completed:/i.test(descr)) {
    const m = descr.match(/^tool completed:\s*(\S+)/i);
    const nm = m?.[1] || '工具';
    const bad = /\(error\)/i.test(descr);
    return { state: bad ? 'error' : 'result', task: bad ? `${nm} 出错了` : `刚跑完 ${nm}` };
  }
  return null;
}

/**
 * 跨调用记住"上一次发出去的状态"，用来把 ts 稳定成事件戳。
 * state/task 没变 → ts 不动 → 客户端不 tick → 不重启动画。
 */
let lastEmit = { key: null, ts: 0, state: null, task: null };

/** 读 state.db 推出当前工作状态（含 ts 门控）。任何异常都 fail-soft：保持上次状态，不清空气泡。 */
export async function workState() {
  const nowMs = Date.now();

  let res;
  try {
    res = await withDb((db) => {
      const session = db.prepare(`
        SELECT id, source, title, display_name, started_at, ended_at, end_reason,
               last_activity_at, last_activity_description, cwd
          FROM sessions
         ORDER BY COALESCE(last_activity_at, started_at) DESC
         LIMIT 1`).get();
      if (!session) return null;
      const msgs = db.prepare(`
        SELECT role, tool_name, finish_reason, tool_calls, content, timestamp
          FROM messages
         WHERE session_id = ?
         ORDER BY timestamp DESC
         LIMIT 12`).all(session.id);
      return { ...deriveWork({ nowMs, session, msgs }), sessionId: session.id, source: session.source };
    });
  } catch (e) {
    // 读不到库（被锁 / 被清）→ 原样维持上次结论，别把气泡抖没了
    return { state: lastEmit.state, task: lastEmit.task, ts: lastEmit.ts, why: 'db-error',
      error: e.message, sessionId: null, source: null };
  }

  const r = res || { state: null, task: null, tsMs: 0, why: 'idle' };
  const key = r.state ? `${r.state}|${r.task}` : '';
  if (key !== lastEmit.key) lastEmit = { key, ts: nowMs, state: r.state ?? null, task: r.task ?? null };
  return {
    state: r.state ?? null,
    task: r.task ?? null,
    ts: lastEmit.ts,
    why: r.why,
    sessionId: r.sessionId ?? null,
    source: r.source ?? null,
  };
}
