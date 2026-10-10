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
 *  默认 300（贴合她的实际余额量级 ¥200~300），改环境变量 PET_TIER_MAX 即可。 */
const TIER_MAX = Number(process.env.PET_TIER_MAX || 300);

fs.mkdirSync(LOGDIR, { recursive: true });
const logFile = path.join(LOGDIR, 'host.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  if (process.env.PET_QUIET !== '1') console.log(line);
}

// ---------------------------------------------------------------------------
// JSONC → JSON（去注释与尾逗号；用状态机，避免误伤字符串里的 // 和 URL）
// ---------------------------------------------------------------------------
function parseJsonc(text) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
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
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

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
 *  - total / granted / toppedUp → 首行「今日 X token」、尾行「今日 N 次请求 · $花费」
 *  - balances                   → 中间几行（服务状态 / 余额 / 累计）
 *  - balanceValue / tierMax     → 档位动画（余额 ÷ 刻度）
 *  - periodLabel                → 首行口径：真·今日，还是"自 HH:MM 起"
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
      data: {
        total: String(t.today.tokens),
        granted: t.today.cost.toFixed(4),
        toppedUp: String(t.today.requests),
        balances: lines,
        balanceValue: balNum === null ? null : String(balNum),
        tierMax: String(TIER_MAX),
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
/** /work-status 的日志去重键（state|task）—— 1s 轮询，变了才打一行 */
let lastWorkLogged = null;

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  log(`${req.method} ${p}`);

  const send = (code, body, type = 'application/json; charset=utf-8') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  };

  try {
    if (p === `${PREFIX}/config` || p === `${PREFIX}/config.jsonc`) {
      return send(200, configResponse());
    }
    if (p === `${PREFIX}/balance`) {
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
      // 工作状态（L0 底座 + L1 叙事）：state 6 档 + task 说清"在干什么"+ ts 只在状态/文案变化时前进
      // （ts 语义见 lib/hermes.mjs 文件头 —— 取 Date.now() 会让宠物每秒重启动画）。
      // 客户端 1s 轮询，所以日志只在"叙事真的变了"时打一行，避免刷屏。
      const ws = await workState();
      const logKey = `${ws.state}|${ws.task}`;
      if (logKey !== lastWorkLogged) {
        lastWorkLogged = logKey;
        log(`workStatus state=${ws.state} task=${ws.task} (${ws.why}${ws.source ? ' src=' + ws.source : ''})`);
      }
      return send(200, ws);
    }
    if (p === `${PREFIX}/broadcast`) {
      return send(200, { ts: 0 });
    }
    if (p === `${PREFIX}/whisper`) {
      return send(200, await whisperResponse(false));
    }
    if (p === `${PREFIX}/whisper/trigger`) {
      return send(200, await whisperResponse(true)); // 右键「碎碎念」点了要立刻说一句
    }
    if (p === `${PREFIX}/chat` && req.method === 'POST') {
      const body = await readJsonBody(req);
      const firstPet = (loadConfig().pets || [{ id: 'main' }])[0];
      return send(200, await chatResponse(String(firstPet.id ?? 'main'), String(body.text || '').trim()));
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
      if (!petChild || petChild.exitCode !== null) startPet();
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
