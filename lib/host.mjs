#!/usr/bin/env node
/**
 * dsh-pet 独立宿主 —— 绑定本地 Hermes 服务
 * ---------------------------------------------------------------------------
 * 作用：顶替 DeepSeek Harness 的 Web 服务，只服务桌宠 dsh-pet 需要的那几个接口，
 *       并把「今日 token 增量 / 累计用量 / DeepSeek 余额」喂给桌宠的气泡。
 *
 * 与 CC Switch 版的区别：跟随信号从「cc-switch 进程」换成「Hermes 网关服务」，
 * 数字从「CC Switch 的逐请求日志」换成「Hermes state.db 的会话累计 + 本地增量账本」。
 *
 * 用法：
 *   node host.mjs              # 起宿主 + 拉起桌宠窗口（前台，Ctrl+C 退出）
 *   node host.mjs --no-pet     # 只起宿主（调试用）
 *   node host.mjs --port 3080  # 换端口
 *
 * 环境变量：
 *   PET_HOST_PORT      宿主端口（默认 3080）
 *   HERMES_HOME        Hermes 根目录（默认自动探测 C:\Hermes）
 *   PET_TIER_MAX       档位刻度上限（默认 300）：DeepSeek 余额到顶 = 第 0 档「钱袋满溢」
 *   PET_LLM_MODEL      碎碎念/对话用的模型（默认 deepseek-flash）
 *   PET_FOLLOW         设 0 关闭「跟随 Hermes 服务」
 *   PET_HERMES_FORCE   排障用：up/down 强制"服务在/不在"，不必真去动服务
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// 用量 / 余额 / 服务状态 / 模型通道 —— 一律以本地 Hermes 服务为准
import {
  todayUsage, deepseekBalance, balanceLine, serviceStatus, chatOnce, usageContextLine,
  humanTokens, humanDuration, LLM_MODEL, workState,
} from './hermes.mjs';
// 代码/数据分离；发现 hermes.exe 与面板地址（都不写死盘符）
import {
  HOME, PLUGIN_DIR as PLUGIN, USER_DIR as USERDIR, LOG_DIR as LOGDIR,
  HELPER_ENTRY as HELPER, electronBinary, ensureDirs, readRuntime, writeRuntime,
  HERMES_HOME, DASHBOARD_URL,
} from './paths.mjs';
import { findHermesExe } from './discover.mjs';
// JSONC 解析（配置是 JSONC，行内注释很多）—— 与 check-patch / 测试共用同一份实现
import { parseJsonc } from './jsonc.mjs';
// 器灵应节：今天是什么节、该播哪段动画、该说哪句话
import {
  todayFestival, bondDays, bondMilestone, todayStamp,
} from './festivals.mjs';

ensureDirs();
const ASSETS = path.join(PLUGIN, 'assets');
const ELECTRON = electronBinary();

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', process.env.PET_HOST_PORT || 3080));
const NO_PET = argv.includes('--no-pet');
/** 跟随 Hermes 服务生命周期（它在跑 → 桌宠出现；它停 → 桌宠消失）。默认开，--no-follow / PET_FOLLOW=0 关。 */
const FOLLOW = !argv.includes('--no-follow') && process.env.PET_FOLLOW !== '0';
/** 跟随轮询间隔（ms） */
const FOLLOW_INTERVAL_MS = Math.max(1000, Number(process.env.PET_FOLLOW_INTERVAL || 2000));

/** 档位刻度上限：DeepSeek 余额 ≥ 这个数 = 第 0 档「钱袋满溢」，归零 = 第 5 档「分文不剩」。
 *  默认 300（大致对应个人账户常见的余额量级），按自己的情况改环境变量 PET_TIER_MAX 即可。 */
const TIER_MAX = Number(process.env.PET_TIER_MAX || 300);

fs.mkdirSync(LOGDIR, { recursive: true });
const logFile = path.join(LOGDIR, 'host.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  if (process.env.PET_QUIET !== '1') console.log(line);
}

// ---------------------------------------------------------------------------
// JSONC → JSON：实现搬到 lib/jsonc.mjs（与 tools/ 下的体检、测试共用一份）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 配置：包内默认 ← user/main-config.json 覆盖；memes 只保留图片真实存在的条目
// ---------------------------------------------------------------------------
function loadConfig() {
  const defaults = parseJsonc(fs.readFileSync(path.join(ASSETS, 'config.jsonc'), 'utf8'));
  let user = {};
  const userFile = path.join(USERDIR, 'main-config.json');
  if (fs.existsSync(userFile)) {
    try { user = JSON.parse(fs.readFileSync(userFile, 'utf8')); }
    catch (e) { log('user/main-config.json 解析失败，忽略：' + e.message); }
  }
  const cfg = { ...defaults, ...user };

  if (cfg.memes && typeof cfg.memes === 'object') {
    const kept = {};
    for (const [k, v] of Object.entries(cfg.memes)) {
      const f = path.join(ASSETS, 'memes', k + '.png');
      if (fs.existsSync(f)) kept[k] = v;
      else log(`memes 条目「${k}」缺少图片，已剔除`);
    }
    cfg.memes = kept;
  }
  return cfg;
}

/** 宿主 /config 响应：按 pet id 分片（DSH 的原样约定） */
function configResponse() {
  const cfg = loadConfig();
  const out = {};
  const pets = Array.isArray(cfg.pets) && cfg.pets.length ? cfg.pets : [{ id: 'main', size: 462 }];
  for (const p of pets) out[String(p.id ?? 'main')] = cfg;
  return out;
}

/** 桌宠实例列表 → DSH_PET_PETS */
function petsEnv() {
  const cfg = loadConfig();
  const pets = Array.isArray(cfg.pets) ? cfg.pets : [];
  return JSON.stringify(
    pets
      .filter((p) => p && String(p.display ?? '').includes('desktop'))
      .map((p) => ({ id: String(p.id), size: Number(p.size) || 462 })),
  );
}

// ---------------------------------------------------------------------------
// 今日用量 + 余额 + 服务状态
// ---------------------------------------------------------------------------

/** /balance 响应（桌宠气泡就吃这一份）
 *
 * 契约对着 dsh-pet **0.3.6** 的 `toBalanceState()` 写：
 *  - shape: 'money'                 → 必填。0.3.x 按 shape 分流，不写就整块返回 null、气泡消失。
 *  - total                          → ⚠ **余额金额**（0.3.x 的语义）。0.2.x 时代这里放的是今日 token，
 *                                     语义已被上游占走，所以今日用量只能另起字段名。
 *  - fullBalance                    → 额度上限；0.3.x 用它**自己**算档位百分比，我们不用算。
 *  - todayTokens/todayRequests/todayCost → 本包扩展，0.3.x 原生不认识，靠补丁 parse-balance 补进 state
 *  - balances                       → 中间几行（服务状态 / 余额 / 累计）
 *  - periodLabel                    → 首行口径：真·今日，还是"自 HH:MM 起"
 */
async function balanceResponse() {
  try {
    const svc = await serviceStatus();
    const t = await todayUsage();

    let bal = null;
    try { bal = await deepseekBalance(); } catch (e) { log('余额查询失败：' + e.message); }

    const lines = [];
    // 第 1 行：Hermes 服务状态（这是"绑定服务"之后最该一眼看到的东西）
    if (svc.running) {
      const up = svc.uptimeMs ? `，已运行 ${humanDuration(svc.uptimeMs)}` : '';
      lines.push(`Hermes 服务在线${up}${svc.healthy ? '' : '（心跳停滞）'}`);
    } else {
      lines.push('Hermes 服务未在线');
    }
    // 第 2 行：DeepSeek 余额
    lines.push(balanceLine(bal));
    // 第 3 行：累计用量（会话累计；括号里是含缓存的量，差距很大时能自证清白）
    lines.push(`累计 ${humanTokens(t.total.tokens)} token（含缓存 ${humanTokens(t.total.tokensWithCache)}）`);

    const balNum = bal && bal.ok && Number.isFinite(Number(bal.remaining)) ? Number(bal.remaining) : null;
    return {
      ok: true,
      provider: 'hermes',
      kind: 'deepseek',
      // dsh-pet ≥ 0.3 的余额模型按 shape 分流：
      //   windows = 有滚动/周/月额度窗口的服务（Claude 那类）
      //   money   = 单一货币余额  ← 我们是这种
      // 不写 shape 的话新版的 toBalanceState() 直接返回 null，气泡整块消失。
      shape: 'money',
      data: {
        // ---- 给 dsh-pet ≥ 0.3 的原生 "money" 契约 ----
        // ⚠ 语义变了：这里的 total 是「余额金额」，不是今日 token。
        //   0.2.x 时代 total 承载今日 token，0.3.x 把它定义为余额 —— 所以旧字段不能再复用。
        currency: 'CNY',
        total: balNum === null ? null : String(balNum),
        fullBalance: String(TIER_MAX), // 额度上限；新版用它自己算档位百分比，不需要我们算
        // ---- 本包扩展：0.3 的原生解析不认识这些字段，靠补丁 parse-balance 补进 state ----
        todayTokens: String(t.today.tokens),
        todayRequests: String(t.today.requests),
        todayCost: t.today.cost.toFixed(4),
        balances: lines,
        periodLabel: t.exact ? '今日' : (t.approximate ? '今日 ≈' : `今日（${t.baselineLabel}）`),
        _human: humanTokens(t.today.tokens),
        _totalHuman: humanTokens(t.total.tokens),
      },
    };
  } catch (e) {
    log('用量查询失败：' + e.message);
    return { ok: false, provider: 'hermes', reason: 'fetch-error', message: e.message };
  }
}

/** /hermes-status：给命令行 / 调试看全貌（桌宠不直接用） */
async function hermesStatusResponse() {
  const svc = await serviceStatus();
  let usage = null, bal = null;
  try { usage = await todayUsage(); } catch (e) { usage = { error: e.message }; }
  try { bal = await deepseekBalance(); } catch (e) { bal = { ok: false, message: e.message }; }
  return {
    ok: true,
    hermesHome: HERMES_HOME,
    dashboardUrl: DASHBOARD_URL,
    service: svc,
    usage,
    balance: bal,
    tierMax: TIER_MAX,
    llmModel: LLM_MODEL,
  };
}

// ---------------------------------------------------------------------------
// 碎碎念 / 对话：直连 DeepSeek（凭证来自 C:\Hermes\.env），秒回、省钱
// ---------------------------------------------------------------------------
let whisperCache = { ts: 0, text: '', image: '' };

/** 人设 + 宠物名 + 桌面实况（碎碎念与对话共用） */
async function persona() {
  const cfg = loadConfig();
  const petName = (cfg.pets && cfg.pets[0] && cfg.pets[0].name) || '桌宠';
  const p = cfg.whisperPrompt || '你是主人桌面上的小宠物。20 字以内，说人话，不要提你是 AI。';
  const ctx = await usageContextLine().catch(() => '');
  return {
    system: `你是本地 Hermes 服务的桌面小宠物（服务在跑你才在）。\n${p}\n你的名字是「${petName}」。\n${ctx}`,
    petName,
  };
}

async function generateWhisper() {
  const { system } = await persona();
  const { text, usage, model } = await chatOnce(system, [{ role: 'user', content: '说一句碎碎念' }]);
  log(`碎碎念生成成功（${model}，in ${usage.prompt_tokens ?? '?'} / out ${usage.completion_tokens ?? '?'} token）：${text}`);
  return text;
}

// ---------------------------------------------------------------------------
// 对话：带记忆（user/memory.json，与 dsh-pet 原本的存法一致：全存不删）
// ---------------------------------------------------------------------------
const MEMORY_FILE = path.join(USERDIR, 'memory.json');

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch { return {}; }
}
function saveMemory(m) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2)); }
  catch (e) { log('对话记忆写入失败：' + e.message); }
}
function memoryList(mem, petId) {
  mem[petId] = mem[petId] || {};
  mem[petId][petId] = mem[petId][petId] || { messages: [] };
  if (!Array.isArray(mem[petId][petId].messages)) mem[petId][petId].messages = [];
  return mem[petId][petId].messages;
}

async function chatResponse(petId, text) {
  if (!text) return { ok: false, reason: 'bad-request', message: '空消息' };
  const cfg = loadConfig();
  const rounds = Math.max(1, Number(cfg.chatMemoryRounds) || 5);
  const mem = loadMemory();
  const list = memoryList(mem, petId);
  const history = list
    .slice(-rounds * 2)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  try {
    const { system } = await persona();
    const { text: reply, usage } = await chatOnce(system, [...history, { role: 'user', content: text }], { maxTokens: 600 });
    const ts = Date.now();
    list.push({ role: 'user', content: text, ts });
    list.push({ role: 'assistant', content: reply, ts });
    saveMemory(mem);
    log(`对话回复（in ${usage.prompt_tokens ?? '?'} / out ${usage.completion_tokens ?? '?'} token）：${reply}`);
    return { ok: true, reply };
  } catch (e) {
    log('对话生成失败：' + e.message);
    return { ok: false, reason: 'generate-error', message: e.message };
  }
}

async function whisperResponse(force) {
  if (!force && whisperCache.text) return { ...whisperCache, ok: true };
  try {
    const text = await generateWhisper();
    whisperCache = { ts: Date.now(), text, image: '' };
    return { ok: true, ...whisperCache };
  } catch (e) {
    log('碎碎念生成失败：' + e.message);
    return { ok: false, reason: 'generate-error', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// 素材：/thumb/<素材根>/<file>
// ---------------------------------------------------------------------------
const MIME = { '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.cur': 'image/x-icon' };

function resolveAsset(root, file) {
  const name = path.basename(decodeURIComponent(file));
  const candidates = [];
  if (root === 'main' || root === '') {
    candidates.push(path.join(USERDIR, 'main-animation', name));
  } else {
    candidates.push(path.join(USERDIR, 'pet', `${root}-animation`, name));
  }
  candidates.push(path.join(ASSETS, name));
  candidates.push(path.join(ASSETS, 'webm', name));
  candidates.push(path.join(ASSETS, 'pic', name));
  candidates.push(path.join(ASSETS, 'memes', name));
  candidates.push(path.join(ASSETS, 'fonts', name));
  candidates.push(path.join(USERDIR, 'main-animation', 'webm', name));
  candidates.push(path.join(USERDIR, 'main-animation', 'mov', name));
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const PREFIX = '/dsh-pet-7340';
let balanceTriggerCount = 0;
/** /work-status 的日志去重键（state|task）—— 变了才打一行 */
let lastWorkLogged = null;

// ---------------------------------------------------------------------------
// 状态仓库 S —— dsh-pet ≥ 0.3 的唯一数据出口
// ---------------------------------------------------------------------------
/**
 * 0.3 起客户端不再各自去拉 /balance、/work-status、/whisper，而是 **1s 轮询 `GET /state`**
 * 这一份「统一状态 S」（见 dsh-pet 的 `shared/state.d.ts`：`{ sections, pets }`）。
 *
 * 每个叶子是 `{ counter, data }`，客户端首拉只记基线，**之后 counter 变了才渲染** ——
 * 所以计数器必须由宿主维护，而且「同类数据没变就别碰 counter」：
 * 每次轮询都无脑 `next()`，宠物会每秒重弹一次气泡。写入一律**整体替换叶子对象**，
 * 消费端就不会读到写了一半的叶子（与官方 PollStateStore 同一套语义）。
 */
const emptyLeaf = () => ({ counter: 0, data: null });
const stateStore = {
  last: 0,
  sections: { balance: emptyLeaf(), workStatus: emptyLeaf() },
  pets: new Map(),
  /** 下一个 counter：`Date.now()` 与「上一个 +1」取大 —— 单调、不回退、同毫秒不重复 */
  next() {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  },
  writeSection(name, data) {
    this.sections[name] = { counter: this.next(), data };
  },
  /** 宠物条目不存在则自动建立，say/anim 两个槽位一起建好（形状恒定） */
  writePet(petId, leaf, data) {
    let entry = this.pets.get(petId);
    if (!entry) {
      entry = { say: emptyLeaf(), anim: emptyLeaf() };
      this.pets.set(petId, entry);
    }
    entry[leaf] = { counter: this.next(), data };
  },
  read() {
    return { sections: { ...this.sections }, pets: Object.fromEntries(this.pets) };
  },
};

/** 写「说话」叶子（碎碎念 / 对话回复共用同一个槽）：客户端按 `pets.<id>.say` 读 */
function publishSay(petId, text, image) {
  const id = String(petId || 'main');
  stateStore.writePet(id, 'say', image ? { text, image } : { text });
}

/** 写余额叶子。manual=true 表示「用户主动要的」—— 客户端据此决定不可用时要不要必弹说明 */
function publishBalance(result, manual) {
  stateStore.writeSection('balance', manual ? { ...result, manual: true } : result);
}

/** 上一次已发布的 workStatus 指纹：state / task 都没变就不写 S（不写 = 客户端不渲染） */
let publishedWork = null;

/** 推进工作状态到 S（变了才写、才记日志）。返回本次快照，方便 /work-status 复用。 */
async function publishWorkStatus() {
  const ws = await workState();
  const key = `${ws.state}|${ws.task}`;
  if (key === publishedWork) return ws;
  publishedWork = key;
  stateStore.writeSection('workStatus', { state: ws.state, task: ws.task });
  if (key !== lastWorkLogged) {
    lastWorkLogged = key;
    log(`workStatus state=${ws.state} task=${ws.task} (${ws.why}${ws.source ? ' src=' + ws.source : ''})`);
  }
  return ws;
}

/** 读配置里的刷新周期（秒）。非法/缺失 → 兜底，与 dsh-pet 官方口径一致 */
function refreshSec(name, fallback) {
  const ers = loadConfig().eventsRefreshSec;
  const n = Number(ers && ers[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * S 的三个后台推进器。
 *  - 工作状态：1s 一拍（只有 state|task 变了才写 S）
 *  - 余额：`eventsRefreshSec.balance`（默认 1800s），启动先来一次 —— 客户端首拉才有数据
 *  - 碎碎念：`eventsRefreshSec.whisper`（默认 300s），只对开了 whisperEnabled 的宠物。
 *    ⚠ 刻意**先等一个周期再开口**（官方是启动就说一句）：宿主每次开机自启/重装都会重启，
 *    一重启就让宠物开口太吵。
 */
function startStateLoops() {
  const workLoop = async () => {
    try { await publishWorkStatus(); } catch { /* 静默：下一拍再试 */ }
    setTimeout(workLoop, 1000);
  };
  void workLoop();

  const balLoop = async () => {
    let sec = 1800;
    try {
      sec = refreshSec('balance', 1800);
      const cfg = loadConfig();
      if ((cfg.pets || []).some((p) => p && p.balanceEnabled === true)) {
        publishBalance(await balanceResponse(), false);
      }
    } catch (e) { log('余额刷新失败：' + e.message); }
    setTimeout(balLoop, Math.max(1, sec) * 1000);
  };
  void balLoop();

  const whisperLoop = async () => {
    let sec = 300;
    try { sec = refreshSec('whisper', 300); } catch { /* 用兜底 */ }
    setTimeout(async () => {
      try {
        const cfg = loadConfig();
        for (const p of (cfg.pets || []).filter((x) => x && x.whisperEnabled === true)) {
          const r = await whisperResponse(true); // 周期到了就该换一句，不吃缓存
          if (r.ok && r.text) publishSay(p.id ?? 'main', r.text, '');
        }
      } catch (e) { log('周期碎碎念失败：' + e.message); }
      void whisperLoop();
    }, Math.max(1, sec) * 1000);
  };
  void whisperLoop();

  log('状态仓库 S 已接入（/state）—— 余额按 ' + refreshSec('balance', 1800) + 's、碎碎念按 ' + refreshSec('whisper', 300) + 's 刷新');
}

// ---------------------------------------------------------------------------
// 器灵应节 + 认主 —— 让节令动画跟着真实日历走
// ---------------------------------------------------------------------------
/**
 * 为什么要有这一段：
 *   dsh-pet 原生的「时节」随机池里装了 21 个节令动画，**代码里却没有任何日期逻辑** ——
 *   是一年 365 天随机播的（中秋可能堆雪人、端午可能吃月饼）。
 *   那 19 个有固定日期的已由补丁从随机链摘出（见 lib/patch.mjs 的 festival-* 三条规则），
 *   这里补的就是那块缺的日历：到了那天，由宿主主动把它调出来。
 *
 * 状态落在 user/pet-bond.json：
 *   { "since": "YYYY-MM-DD",  // 认主日（第一次装这个宿主那天）
 *     "saidOn": ["YYYY-MM-DD"] }  // 已经说过的日子
 *   存 saidOn 是为了**幂等** —— 宿主重启/重装都不会把同一句再说一遍。
 */
const BOND_FILE = path.join(USERDIR, 'pet-bond.json');
/** 应节动画之间的间隔（ms）。档位动画实测约 10 秒，留点余量别叠着播 */
const FESTIVAL_ANIM_GAP_MS = Math.max(1000, Number(process.env.PET_FESTIVAL_GAP || 12000));
/** 启动后先安静一会儿再开口 —— 宿主开机自启很频繁，一启动就吵不合适 */
const FESTIVAL_FIRST_DELAY_MS = Math.max(0, Number(process.env.PET_FESTIVAL_DELAY || 45000));
/** 检查周期（默认 30 分钟）：跨天、手动改系统时间都能被下一次捕捉到 */
const FESTIVAL_INTERVAL_MS = Math.max(60000, Number(process.env.PET_FESTIVAL_INTERVAL || 1800000));

function readBond() {
  try {
    const j = JSON.parse(fs.readFileSync(BOND_FILE, 'utf8'));
    if (j && typeof j.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.since)) {
      return { since: j.since, saidOn: Array.isArray(j.saidOn) ? j.saidOn.filter((x) => typeof x === 'string') : [] };
    }
  } catch { /* 不存在 / 解析失败 → 下面重建 */ }
  // 首次：认主日 = 今天。这里用**系统本地日期**（问的是"装上的那天"，跟时区无关）
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fresh = { since: process.env.PET_BOND_SINCE || today, saidOn: [] };
  writeBond(fresh);
  log(`认主日已记下：${fresh.since}（想改就编辑 user/pet-bond.json 的 since）`);
  return fresh;
}

function writeBond(b) {
  try {
    fs.mkdirSync(USERDIR, { recursive: true });
    fs.writeFileSync(BOND_FILE, JSON.stringify({ since: b.since, saidOn: b.saidOn.slice(-60) }, null, 2));
  } catch (e) { log('写 pet-bond.json 失败：' + e.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让桌宠播一段动画 —— 回显到 S 的 pets.<id>.anim，客户端靠 counter 变化触发 */
function playAnim(petId, name) {
  stateStore.writePet(petId, 'anim', { name });
  log(`器灵应节：让 ${petId} 播「${name}」`);
}

/**
 * 算出今天该不该开口、要播什么 —— **只算不做**，几毫秒返回。
 *
 * 为什么拆成"算"和"做"两步：演一整段要 sleep 好几十秒
 * （默认间隔 12s，春节有 4 段 → 一分钟），HTTP 请求绝不能被它堵住 ——
 * 客户端早就超时了，而且出错也没机会回话。
 * @param {{date?:string|null, force?:boolean}} opt
 *   date  假装今天是这天（`YYYY-MM-DD`）—— 排障/验收用，不必真去改系统时间
 *   force 无视 saidOn（手动触发用）
 */
function planFestival({ date = null, force = false } = {}) {
  const now = date ? new Date(`${date}T12:00:00+08:00`) : new Date();
  const bond = readBond();
  const stamp = todayStamp(now);
  if (!force && bond.saidOn.includes(stamp)) return { skipped: 'today-already-said', stamp };

  const fest = todayFestival(now);
  const ms = bondMilestone(bond.since, now);
  if (!fest && !ms) return { skipped: 'not-a-festival', stamp, note: '今天不是节日，也没有认主纪念' };

  const petId = String((loadConfig().pets || [{ id: 'main' }])[0].id ?? 'main');
  // 节日和认主纪念撞在同一天时，两句并置 ——
  // ⚠ 别退化成「今天还是我认你第 N 天」：那样会把 bondMilestone 专门写的
  //   「第 1 年了。我还在。」吃掉（周年反而说不出周年的话）。实测会真撞：
  //   认主日若落在固定公历节日（圣诞/万圣），每年纪念日必然也是那个节日。
  const line = fest
    ? (ms ? `${fest.line} ${ms.line}` : fest.line)
    : ms.line;

  return {
    stamp, petId, line, force,
    anims: fest ? fest.anims : [],
    festival: fest ? `${fest.name}（${fest.hint}）` : null,
    since: bond.since,
    bondDays: bondDays(bond.since, now),
    milestone: ms ? ms.days : null,
  };
}

/**
 * 按计划演：一段一段播动画（别叠着），最后开口说话。
 * ⚠ 会 sleep 几十秒 —— **调用方一律不要 await**（HTTP 立即回、推进器 fire-and-forget）。
 */
let festivalPlaying = false;
async function playFestival(plan) {
  if (festivalPlaying) { log('器灵应节：上一次还在播，这次先跳过'); return; }
  festivalPlaying = true;
  try {
    for (let i = 0; i < plan.anims.length; i++) {
      playAnim(plan.petId, plan.anims[i]);
      await sleep(FESTIVAL_ANIM_GAP_MS);     // 让这一段播完再上下一段
    }
    publishSay(plan.petId, plan.line, '');
    log(`器灵应节：${plan.festival || ''}${plan.milestone ? (plan.festival ? ' + ' : '') + `第 ${plan.milestone} 天` : ''} → 「${plan.line}」`);

    if (!plan.force) {
      const b = readBond();
      if (!b.saidOn.includes(plan.stamp)) { b.saidOn.push(plan.stamp); writeBond(b); }
    }
  } catch (e) {
    log('器灵应节出错：' + e.message);
  } finally {
    festivalPlaying = false;
  }
}

/** 推进器：启动先安静一会儿，之后定期看一眼 */
function startFestivalLoop() {
  if (process.env.PET_FESTIVALS === '0') { log('器灵应节：已按 PET_FESTIVALS=0 关闭'); return; }
  const tick = async () => {
    try {
      const plan = planFestival();
      if (!plan.skipped) void playFestival(plan);      // 不 await：播一分钟不能堵住下一拍
    } catch (e) { log('器灵应节出错：' + e.message); }
    setTimeout(tick, FESTIVAL_INTERVAL_MS);
  };
  setTimeout(() => {
    const b = readBond();
    log(`器灵应节已接入 —— 认主 ${b.since}（今天第 ${bondDays(b.since)} 天）；今天 ${todayStamp()}`);
    void tick();
  }, FESTIVAL_FIRST_DELAY_MS);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function serveFile(abs, res, send) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return send(404, 'not found: ' + path.basename(abs), 'text/plain; charset=utf-8');
  }
  const st = fs.statSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(abs).pipe(res);
}

/**
 * 心跳类端点：客户端**每秒**在轮询，逐条记日志只会把有用的话淹掉。
 * 实测：老版（0.2.x）的 /broadcast + /balance + /work-status 三个端点写了 43 万行，
 * 占整份 host.log 的 99.9% —— 想找一行"为什么没播动画"得翻几万行噪声。
 * 0.3.x 换成轮询 /state 之后同样：一秒一行 ≈ 5.5MB/天。
 * 想看轮询本身设 PET_LOG_POLLS=1 即可恢复全量。
 */
const POLL_PATHS = new Set(['/state', '/work-status', '/broadcast', '/balance', '/config', '/thumb', '/font']);
const LOG_POLLS = process.env.PET_LOG_POLLS === '1';
/** POST 动作端点（手动触发）一律照记 —— 那才是"谁点了什么" */
function shouldLogRequest(method, fullPath) {
  if (LOG_POLLS) return true;
  return !(method === 'GET' && POLL_PATHS.has(fullPath.slice(PREFIX.length)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  if (shouldLogRequest(req.method, p)) log(`${req.method} ${p}`);

  const send = (code, body, type = 'application/json; charset=utf-8') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  };

  try {
    if (p === `${PREFIX}/config` || p === `${PREFIX}/config.jsonc`) {
      return send(200, configResponse());
    }
    // ---- 统一状态 S：dsh-pet ≥ 0.3 里客户端 1s 轮询的唯一数据源 ----
    if (p === `${PREFIX}/state`) {
      return send(200, stateStore.read());
    }
    if (p === `${PREFIX}/balance`) {
      // 0.3：POST = 「刷新余额」动作（写进 S，数据本身仍从 /state 读）
      if (req.method === 'POST') {
        publishBalance(await balanceResponse(), true);
        log('手动触发余额刷新（写 S）');
        return send(200, { ok: true });
      }
      // GET 保留：返回原始数据，排障/自验直接看这一份
      return send(200, await balanceResponse());
    }
    if (p === `${PREFIX}/hermes-status`) {
      return send(200, await hermesStatusResponse());
    }
    if (p === `${PREFIX}/balances`) {
      // 兼容原契约：这里返回同一份用量/余额数据（Hermes 只有一家服务商，不再有"多 provider"列表）
      return send(200, await balanceResponse());
    }
    if (p === `${PREFIX}/balance/trigger`) {
      return send(200, { count: balanceTriggerCount });
    }
    if (p === `${PREFIX}/work-status`) {
      // GET 保留供排障；客户端 0.3 起改从 /state 的 sections.workStatus 读，
      // 日志由 publishWorkStatus() 在"叙事真的变了"时打（这里不再重复打）。
      return send(200, await workState());
    }
    if (p === `${PREFIX}/broadcast`) {
      return send(200, { ts: 0 });
    }
    if (p === `${PREFIX}/whisper`) {
      // 0.3：POST = 「现在说一句」动作（生成 → 写 S 的 pets.<id>.say）
      if (req.method === 'POST') {
        const petId = url.searchParams.get('pet') || 'main';
        const r = await whisperResponse(true);
        if (!r.ok) return send(200, { ok: false, reason: r.reason, message: r.message });
        publishSay(petId, r.text, r.image || '');
        return send(200, { ok: true });
      }
      return send(200, await whisperResponse(false)); // GET 保留：老行为，排障用
    }
    if (p === `${PREFIX}/whisper/trigger`) {
      return send(200, await whisperResponse(true)); // 右键「碎碎念」点了要立刻说一句
    }
    if (p === `${PREFIX}/reload` && req.method === 'POST') {
      // 右键菜单「重载配置」：请宿主**重启桌面 Helper**（原生契约，见 restartPet 的注释）。
      // 立即回 200、重建放后台 —— 原生那边发这个请求的进程正是要被换掉的那个，它本来也不 await。
      void restartPet('重载配置（右键菜单）');
      return send(200, { ok: true, restarting: true });
    }
    if (p === `${PREFIX}/festival`) {
      // 器灵应节。**GET 只报告、POST 才动作** —— 排障时先看它算得对不对，再决定要不要真播。
      // POST 立即返回"打算播什么"，真正的演出在后台跑（演一分钟，不能堵住这个请求）。
      //   ?date=YYYY-MM-DD  假装今天是那天（验收/排障，不必改系统时间）
      //   ?force=1          无视"今天已经说过"
      const date = url.searchParams.get('date');
      const force = url.searchParams.get('force') === '1';
      const plan = planFestival({ date, force });
      if (req.method !== 'POST' || plan.skipped) return send(200, plan);
      void playFestival(plan);
      return send(200, { ok: true, ...plan, note: '已在后台开始演' });
    }
    if (p === `${PREFIX}/chat` && req.method === 'POST') {
      const body = await readJsonBody(req);
      const petId = url.searchParams.get('pet') || String((loadConfig().pets || [{ id: 'main' }])[0].id ?? 'main');
      const r = await chatResponse(petId, String(body.text || '').trim());
      // 回复走 S（与碎碎念同一条展示链路），响应体里也捎一份供排障
      if (r.ok) publishSay(petId, r.reply, '');
      return send(200, r);
    }
    if (p.startsWith(`${PREFIX}/chat`)) {
      return send(400, { ok: false, reason: 'bad-request', message: '请用 POST' });
    }
    if (p.startsWith(`${PREFIX}/pic/`)) {
      const rel = p.slice(`${PREFIX}/pic/`.length);
      const abs = rel.startsWith('memes/')
        ? path.join(ASSETS, 'memes', path.basename(rel))
        : path.join(ASSETS, 'pic', path.basename(rel));
      return serveFile(abs, res, send);
    }
    if (p.startsWith(`${PREFIX}/font/`)) {
      return serveFile(path.join(ASSETS, 'fonts', path.basename(p.slice(`${PREFIX}/font/`.length))), res, send);
    }
    if (p === '/ctl/show') {
      balanceTriggerCount += 1;
      log('手动触发用量展示，count=' + balanceTriggerCount);
      return send(200, { ok: true, count: balanceTriggerCount });
    }
    // 右键菜单「退出桌宠」：先把桌宠关掉，再退掉自己。
    // ⚠ 为什么不只关桌宠：宿主会留在跑 → 状态变成「宿主在跑、但宠物不在」，
    //   下次启动时 cmdStart 一看 hostAlive 就报「宿主已在运行」，而桌宠不会再出现（`announced` 已经翻过了）——
    //   用户双击启动图标却什么都不发生。一起退掉，下次启动才是干净的。
    // 顺序：先回 HTTP 响应（渲染端的 fetch 能正常结束），再收摊。
    if (p === `${PREFIX}/ctl/quit`) {
      log('收到退出指令（右键菜单）→ 关闭桌宠并退出宿主');
      send(200, { ok: true });
      setTimeout(() => {
        stopPet('右键菜单选择退出');
        setTimeout(() => process.exit(0), 300); // 给 stopPet 一点时间把子进程收干净
      }, 60);
      return;
    }
    if (p.startsWith(`${PREFIX}/thumb/`)) {
      const rest = p.slice(`${PREFIX}/thumb/`.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return send(400, 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>', 'text/plain; charset=utf-8');
      const root = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      const abs = resolveAsset(root, file);
      if (!abs) return send(404, 'not found', 'text/plain; charset=utf-8');
      const st = fs.statSync(abs);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(abs).pipe(res);
    }
    return send(404, 'dsh-pet: unknown route ' + p, 'text/plain; charset=utf-8');
  } catch (e) {
    log('handler error: ' + (e && e.stack ? e.stack : e));
    return send(500, { ok: false, message: String((e && e.message) || e) });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// 重复启动保护：端口被占说明宿主已经在跑，本次安静退出（避免开机自启与手动启动打架）
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 被占用 —— 宿主已在运行，本次退出`);
    process.exit(0);
  }
  log('宿主错误：' + e.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 桌宠窗口：启动 / 跟随 Hermes 服务生命周期
// ---------------------------------------------------------------------------
let petChild = null;
let lastPetExitAt = 0;
let petGpuFailures = 0;

/**
 * 桌宠 Electron 的启动参数阶梯（实测 2026-09-25）：
 *   某些受限进程树里（例如从 IDE/WorkBuddy 的集成终端拉起），Chromium 自身的
 *   sandbox 初始化不了 → GPU/渲染进程直接 0xC0000005 崩，Electron 报
 *   `FATAL: GPU process isn't usable. Goodbye.` 后整体退出（窗口一闪就没）。
 *   实测：裸 Electron（跟 dsh-pet 无关）同样崩；`--disable-gpu` / `--use-angle=swiftshader`
 *   都没用；**`--no-sandbox` 和 `--in-process-gpu` 能救活**。
 * 所以先按原生参数起，连续崩两次才逐级降级 —— 正常桌面会话用不到，不白降安全性。
 * 想固定参数：设 PET_ELECTRON_ARGS（例如 "--no-sandbox"），设了就不再自动降级。
 */
const petArgsEnv = String(process.env.PET_ELECTRON_ARGS || '').trim();
const ARG_LADDER = petArgsEnv
  ? [petArgsEnv.split(/\s+/).filter(Boolean)]
  : [[], ['--in-process-gpu'], ['--no-sandbox']];
let petArgStep = 0;

/**
 * 桌宠 Electron 子进程的环境。
 * ⚠ 必须摘掉 ELECTRON_RUN_AS_NODE：不摘的话 Electron 会以「纯 Node 模式」启动，
 * helper 直接报 `Cannot find module 'electron'` 并退出（code=3）。
 * **必须 delete，不能设空串** —— 设成空串 Electron 会直接 abort（dsh-pet 自己的报错里就写了这句）。
 * 实测来源：在 Electron 系的宿主里（IDE / WorkBuddy）跑本宿主时，环境会带着这个变量。
 */
function electronChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_OPTIONS;
  return env;
}

function startPet() {
  if (petChild && petChild.exitCode === null) return petChild;
  if (!fs.existsSync(ELECTRON)) { log('找不到 electron：' + ELECTRON); return null; }
  if (!fs.existsSync(HELPER)) { log('找不到桌宠程序：' + HELPER); return null; }
  // 刚失败过就缓一拍，别每 2s 撞一次墙（日志会刷屏）
  if (Date.now() - lastPetExitAt < 5000) return null;
  // 连续崩两次（且崩因是 GPU/sandbox）→ 沿阶梯降级后重试
  if (petGpuFailures >= 2 && petArgStep < ARG_LADDER.length - 1) {
    petArgStep++;
    petGpuFailures = 0;
    log(`Electron 的 GPU/渲染进程起不来（Chromium sandbox 受限）→ 换参数重试：${JSON.stringify(ARG_LADDER[petArgStep])}`);
  }
  const petArgs = ARG_LADDER[petArgStep];
  const hermesExe = readRuntime().hermesExe || '';
  petChild = spawn(ELECTRON, [...petArgs, HELPER], {
    cwd: path.join(PLUGIN, 'runtime', 'electron-helper'),
    env: electronChildEnv({
      DSH_PET_CONFIG_URL: `http://127.0.0.1:${PORT}${PREFIX}/config`,
      DSH_PET_PETS: petsEnv(),
      DSH_PET_ELECTRON_PATH: ELECTRON,
      // 菜单「打开 Hermes 面板」用：exe 路径 + 面板地址 + HERMES_HOME（补丁在 main.js 里读）
      HERMES_HOME,
      HERMES_DASHBOARD_URL: DASHBOARD_URL,
      ...(hermesExe ? { HERMES_EXE: hermesExe } : {}),
    }),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mine = petChild;
  mine.stdout.on('data', (d) => log('[pet] ' + String(d).trim()));
  mine.stderr.on('data', (d) => {
    const s = String(d);
    if (/GPU process isn't usable|gpu_process_host|gpu_data_manager/.test(s)) petGpuFailures++;
    log('[pet:err] ' + s.trim());
  });
  mine.on('exit', (code, signal) => {
    lastPetExitAt = Date.now();
    if (petChild === mine) petChild = null;
    log(`桌宠窗口退出（code=${code}${signal ? ' signal=' + signal : ''}）`);
  });
  log('桌宠窗口已拉起' + (petArgs.length ? `（参数 ${petArgs.join(' ')}）` : ''));
  return mine;
}

function stopPet(reason) {
  if (!petChild || petChild.exitCode !== null) { petChild = null; return; }
  log('关闭桌宠窗口' + (reason ? `（${reason}）` : ''));
  try { petChild.kill(); } catch (e) { log('关闭桌宠失败：' + e.message); }
  petChild = null;
}

/**
 * 「重载配置」：把桌面 Helper 整个重启一遍 —— 这是**原生契约**，
 * 见 dsh-pet `runtime/electron-helper/sprite.js` 的 `reloadDesktop()`：
 * 「请宿主重启桌面 Helper，与设置页『保存』同一条重启路径」。
 *
 * 为什么必须重建进程，而不是"就地重读配置"：
 *   ① 宠物列表与 size 是 `startPet()` 通过 **DSH_PET_PETS 环境变量**塞进子进程的 —— 进程起来就改不了；
 *   ② 页面里的余额/工作状态轮询是**一次性启动**的（events.js 的 loopsStarted 门控），
 *      就地重建 sprite 会漏启新循环、或留下旧定时器。
 *
 * ❗曾经这里是空的（只打一行日志），理由写的是「loadConfig 每次现读，所以无事可做」——
 *   **这个推理漏了一半**：宿主确实每次现读、也确实把新配置吐给 `GET /config`，
 *   但**没人再去问它**：渲染端的 `loadConfig()`（renderer.js）只在 `boot()` 里调一次。
 *   "换一个新页面"就是那个"第二次问"。
 *
 * ⚠ 反例提醒（实测过）：判据用渲染进程的 `performance.timeOrigin` ——
 *   窗口真被重建，它就是"刚才"；空操作的话它纹丝不动。别用 tasklist/wmic 数进程。
 */
let reloadBusy = false;
function restartPet(reason, done) {
  if (reloadBusy) { log('重载配置：上一次还在重启，这次跳过'); return; }
  reloadBusy = true;

  const finish = (ok, msg) => { reloadBusy = false; log('重载配置：' + msg); if (done) done(ok); };

  const doStart = () => {
    // ⚠ 必须清掉 lastPetExitAt：startPet 开头有「刚失败过缓一拍」的守卫
    //   （`Date.now() - lastPetExitAt < 5000` 就直接 return null），
    //   而旧进程退出时 exit 处理器刚把它写成"现在" —— 不清的话，这次**主动**重启会被自己挡住。
    lastPetExitAt = 0;
    const c = startPet();
    finish(!!c, c ? '桌宠窗口已按最新配置重建' : '重建失败（原因见上一行日志）');
  };

  const dead = (p) => !p || p.exitCode !== null || p.signalCode !== null;
  const old = petChild;
  if (dead(old)) { doStart(); return; }          // 本来就没窗口（服务没跑等）→ 直接起

  log('重载配置：先关掉旧窗口，等它**真正退出**再起新的');
  try { old.kill(); } catch (e) { log('关闭桌宠失败：' + e.message); }
  if (petChild === old) petChild = null;          // 别让跟随循环在这段空档里抢着又起一个

  const t0 = Date.now();
  const waitExit = () => {
    if (!dead(old)) {
      // 旧进程没退就起新的 → 会出现两只宠物窗口叠着
      if (Date.now() - t0 > 10000) return finish(false, '旧窗口 10 秒还没退出，放弃这次（跟随检查会自己补上）');
      setTimeout(waitExit, 150);
      return;
    }
    doStart();
  };
  setTimeout(waitExit, 150);
}

/**
 * 跟随模式：以「Hermes 服务（网关）在不在」为唯一判据 ——
 * 读它自己写的 pid/心跳文件，跟它装在哪、怎么升级都无关。
 */
function startFollow() {
  const MISS_LIMIT = 3; // 连续探不到几次才算真退出（容忍重启抖动）
  let misses = 0;
  let announced = false;
  let staleWarned = false;
  const tick = async () => {
    let s;
    try { s = await serviceStatus(); } catch (e) { log('服务探测失败：' + e.message); s = { running: false }; }
    if (s.running) {
      misses = 0;
      if (s.pid && s.pid !== readRuntime().hermesGatewayPid) writeRuntime({ hermesGatewayPid: s.pid });
      if (!announced) {
        log(`检测到 Hermes 服务在运行（pid ${s.pid}${s.phase ? '，' + s.phase : ''}）→ 拉起桌宠`);
        announced = true;
      }
      if (!s.healthy && !staleWarned) {
        log(`提醒：服务进程在，但心跳已 ${Math.round((s.hbAgeMs ?? 0) / 1000)}s 未更新（可能卡住）`);
        staleWarned = true;
      }
      if (s.healthy) staleWarned = false;
      // ⚠ 重载期间别抢：restartPet 要等旧进程真退出才起新的，
      //   这里插一杠会起出第二只宠物窗口（叠在一起）
      if (!reloadBusy && (!petChild || petChild.exitCode !== null)) startPet();
    } else {
      if (announced) log('Hermes 服务不在运行，等待…');
      announced = false;
      staleWarned = false;
      misses++;
      if (misses === MISS_LIMIT) stopPet('Hermes 服务已退出');
    }
    setTimeout(tick, FOLLOW_INTERVAL_MS);
  };
  log(`跟随模式已开启（每 ${FOLLOW_INTERVAL_MS / 1000}s 检查一次 Hermes 服务）`);
  tick();
}

// ---------------------------------------------------------------------------
// 命令行小工具：不起服务、只回答一个问题
//   node lib/host.mjs --festival              今天该不该应节？（只算不做）
//   node lib/host.mjs --festival --date 2026-10-18   假装今天是那天
// ---------------------------------------------------------------------------
if (argv.includes('--festival')) {
  const i = argv.indexOf('--date');
  const date = i >= 0 ? argv[i + 1] : null;
  const r = planFestival({ date });           // 只算不做：命令行不做演出
  const b = readBond();
  console.log('');
  // ⚠ 认主信息一律按**真实今天**报，免得跟 --date 假装的那天混在一起看不懂
  // ⚠ bondDays 对"早于认主日"的日期返回 null（问不出"第几天"）—— 别把 null 直接印出来
  const days = bondDays(b.since);
  console.log(`认主：${b.since}   （真实今天 ${todayStamp()}，${days === null ? '还没到认主日' : `第 ${days} 天`}）`);
  if (date) console.log(`⚠ 以下结果是把今天假装成 ${date} 算出来的`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

if (argv.includes('--bond')) {
  const b = readBond();
  const days = bondDays(b.since);
  console.log('');
  console.log(`认主日：${b.since}   ${days === null ? '（还没到认主日）' : `今天第 ${days} 天`}   文件：${BOND_FILE}`);
  console.log(`已说过：${b.saidOn.length ? b.saidOn.join(', ') : '（还没有）'}`);
  process.exit(0);
}

server.listen(PORT, '127.0.0.1', async () => {
  log(`宿主已启动  http://127.0.0.1:${PORT}${PREFIX}/config`);
  log(`Hermes：${HERMES_HOME}   面板：${DASHBOARD_URL}   档位刻度：余额 0 ~ ${TIER_MAX}`);
  const cfg = loadConfig();
  const pets = (cfg.pets || []).map((x) => `${x.name || x.id}(${x.display})`).join(', ');
  log(`宠物：${pets}`);
  try {
    const s = await serviceStatus();
    log(`服务状态：${s.running ? `在线（pid ${s.pid}${s.uptimeMs ? '，已运行 ' + humanDuration(s.uptimeMs) : ''}）` : '未在线'}` +
        `${s.pidFileExists ? '' : '（没找到 gateway.pid）'}`);
  } catch (e) { log('服务状态查询失败：' + e.message); }
  try {
    const t = await todayUsage();
    log(`用量：今日 ${humanTokens(t.today.tokens)} token / ${t.today.requests} 次 / $${t.today.cost.toFixed(4)}` +
        `${t.exact ? '（真·今日）' : `（${t.baselineLabel}起）`}   累计 ${humanTokens(t.total.tokens)} token / ${t.total.requests} 次`);
  } catch (e) { log('用量查询失败：' + e.message); }
  try {
    const b = await deepseekBalance();
    log(`余额：${b.ok ? b.display : '查询失败——' + b.message}（模型通道 ${LLM_MODEL}）`);
  } catch (e) { log('余额查询失败：' + e.message); }

  findHermesExe().then((exe) => { if (exe) log(`hermes.exe：${exe}`); else log('没找到 hermes.exe（「打开 Hermes 面板」会退化成打开链接）'); });

  if (NO_PET) return;
  // 状态仓库的后台推进器：客户端 1s 轮询 /state，宿主负责把数据"推进去"
  startStateLoops();
  // 器灵应节：节令动画跟着真实日历走（认主日也在这里读）
  startFestivalLoop();
  if (FOLLOW) startFollow();
  else startPet();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到 ' + sig + '，退出');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
