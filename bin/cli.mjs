#!/usr/bin/env node
/**
 * dsh-pet-hermes —— 桌宠 × 本地 Hermes 服务
 *
 * 把 dsh-pet 从 DeepSeek Harness 里摘出来独立跑，数据全部取自 Hermes 自己的
 * state.db 与 .env，并让桌宠跟着 **Hermes 网关服务** 的生命周期起落。
 *
 * 用法：
 *   npx dsh-pet-hermes install     一次性准备（还原原生包 / 打补丁 / 备好 Electron / 注册开机自启）并启动
 *   npx dsh-pet-hermes start|stop|status|restart
 *   npx dsh-pet-hermes patch [--restore]   重新打补丁（--restore 先从原生包还原）
 *   npx dsh-pet-hermes doctor      自检：Hermes 在哪、库能不能读、服务在不在、缺什么
 *   npx dsh-pet-hermes uninstall   移除开机自启（--purge 连运行数据一起删）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  CODE_DIR, HOME, PLUGIN_DIR, ELECTRON_DIR, USER_DIR, LOG_DIR, HOST_LOG,
  HELPER_ENTRY, electronBinary, ensureDirs, HERMES_HOME, STATE_DB, GATEWAY_PID,
  GATEWAY_HEARTBEAT, GATEWAY_LIFECYCLE, GATEWAY_LAUNCHER, HERMES_ENV, USAGE_LEDGER,
  DASHBOARD_URL,
} from '../lib/paths.mjs';
import { applyPatches, patchesInPlace } from '../lib/patch.mjs';
import {
  serviceStatus, cumulativeUsage, todayUsage, deepseekBalance, humanTokens,
  humanDuration, deepseekKey, LLM_MODEL, recentSessions,
} from '../lib/hermes.mjs';
import { findHermesExe, findHermesProcesses, pickGatewayProcess, dashboardListening, launchGateway } from '../lib/discover.mjs';

const pExecFile = promisify(execFile);
const APP_DIR = path.join(HOME, 'app');           // install 时把代码拷这里，npx 临时目录没了也能跑
const DEFAULT_PORT = 3080;
const isWin = process.platform === 'win32';
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const ok = (s) => `✓ ${s}`;
const bad = (s) => `✗ ${s}`;
const dot = (s) => `- ${s}`;

async function ps(script, timeout = 20000) {
  const { stdout } = await pExecFile('powershell.exe', ['-NoProfile', '-Command', script],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  return String(stdout || '').trim();
}

function startupDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
const STARTUP_VBS = () => path.join(startupDir(), 'dsh-pet-hermes.vbs');
/** 上一版（CC Switch 版）留下的自启项 —— 换绑时要摘掉，否则两个宿主抢 3080 端口 */
const OLD_STARTUP_VBS = () => path.join(startupDir(), 'dsh-pet-ccswitch.vbs');

/** 宿主进程（靠命令行里的 host.mjs 认） */
async function hostPid() {
  try {
    const out = await ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'host\\.mjs' } | Select-Object -First 1 -ExpandProperty ProcessId");
    return out ? Number(out) : null;
  } catch { return null; }
}

async function hostAlive(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/config`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

/** 把代码同步到 HOME/app（install 后自启指向这里，与 npx 临时目录解耦） */
function syncApp() {
  ensureDirs();
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const d of ['lib', 'bin']) {
    fs.cpSync(path.join(CODE_DIR, d), path.join(APP_DIR, d), { recursive: true });
  }
  fs.copyFileSync(path.join(CODE_DIR, 'package.json'), path.join(APP_DIR, 'package.json'));
  return APP_DIR;
}

/**
 * 开机自启该用哪个 node —— **不能用 process.execPath**。
 * 那取决于「谁跑的这个 CLI」：用 npx / WorkBuddy 托管 runtime 跑过 install，
 * 写进 vbs 的就成了那个临时/托管副本；等它被升级或清理，开机自启就**静默失效**
 * （桌面什么都没有，也不报错，最难查的一类故障）。
 * 优先级：系统安装版 → PATH 里的 node → 最后才回退自身。
 */
function stableNodePath() {
  const sys = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
  for (const p of sys) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* 下面回退 */ }
  return process.execPath;
}

function writeStartupVbs(appDir) {
  const dir = startupDir();
  fs.mkdirSync(dir, { recursive: true });
  const host = path.join(appDir, 'lib', 'host.mjs');
  const node = stableNodePath();
  if (node === process.execPath && !fs.existsSync('C:\\Program Files\\nodejs\\node.exe')) {
    say(`  ! 没找到系统 node，自启将写死当前这个：${node}`);
    say('    （它是临时/托管副本的话，将来被清理掉自启就会静默失效）');
  }
  // 内容必须是纯 ASCII：wscript 按 ANSI 读 .vbs，非 ASCII 会解析失败。
  const vbs = [
    "' dsh-pet-hermes - silent autostart",
    "' Starts the pet host. The host follows the local Hermes gateway service:",
    "' pet appears when the Hermes service runs, disappears when it exits.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${node}"" ""${host}""", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(STARTUP_VBS(), vbs, 'ascii');
  return STARTUP_VBS();
}

function removeStartupVbs() {
  try { fs.unlinkSync(STARTUP_VBS()); return true; } catch { return false; }
}

/** 摘掉上一版 CC Switch 版留下的自启项（换绑的关键一步，不摘就会两个宿主抢端口） */
function removeLegacyStartupVbs() {
  try {
    if (fs.existsSync(OLD_STARTUP_VBS())) { fs.unlinkSync(OLD_STARTUP_VBS()); return true; }
  } catch { /* 删不掉也不致命 */ }
  return false;
}

/** 后台起宿主（优先用 install 同步到运行目录的那份，保证与开机自启跑的是同一份代码） */
function startDetached(extraArgs = []) {
  const inApp = path.join(APP_DIR, 'lib', 'host.mjs');
  const host = fs.existsSync(inApp) ? inApp : path.join(CODE_DIR, 'lib', 'host.mjs');
  const out = fs.openSync(HOST_LOG.replace(/host\.log$/, 'host-stdout.log'), 'a');
  const child = spawn(process.execPath, [host, ...extraArgs], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function waitHost(port = DEFAULT_PORT, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await hostAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 备好 Electron：已有就用，没有就按 dsh-pet 同款方式下载 */
async function ensureElectron() {
  const bin = electronBinary();
  if (fs.existsSync(bin)) return { ok: true, bin, note: '已存在' };
  let get;
  try { ({ downloadArtifact: get } = await import('@electron/get')); }
  catch { return { ok: false, note: '缺少 @electron/get，无法自动下载 Electron' }; }
  const version = process.env.PET_ELECTRON_VERSION || '38.0.0';
  say(`  正在下载 Electron ${version}（约 100MB，仅首次）…`);
  try {
    const zip = await get({ artifactName: 'electron', version, platform: process.platform, arch: process.arch });
    fs.mkdirSync(ELECTRON_DIR, { recursive: true });
    await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${ELECTRON_DIR}' -Force`, 300000);
    return { ok: fs.existsSync(bin), bin, note: fs.existsSync(bin) ? '下载完成' : '解压后没找到可执行文件' };
  } catch (e) {
    return { ok: false, note: '下载失败：' + e.message };
  }
}

// ---------------------------------------------------------------------------
// dsh-pet 插件：优先用**原生包**还原，再打补丁（补丁是在原生文本上校对的）
// ---------------------------------------------------------------------------
const pluginHelper = (dir) => path.join(dir, 'runtime', 'electron-helper', 'main.js');
const pluginCore = (dir) => path.join(dir, 'runtime', 'electron-helper', 'shared-core.js');

/** 这份 dsh-pet 是没被任何补丁动过的原生包吗 */
function isPristine(dir) {
  try {
    const s = fs.readFileSync(pluginCore(dir), 'utf8');
    return !s.includes('[cc-switch') && !s.includes('[hermes 改造');
  } catch { return false; }
}

/** 找一份**没打过补丁**的 dsh-pet 原生包：自身依赖 → npm 缓存 _npx 副本 → 运行目录里那份 */
function findPristine() {
  const cands = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  // 0) 本包自己的依赖里那份 —— 最可靠的一条。
  //    package.json 的 dependencies 里带着 dsh-pet，npx / npm i 装本包时会把它一起装进
  //    node_modules；于是**新机器第一次跑 install 就有干净包可用**，不需要用户先手动
  //    跑一遍原版 install。少了这一步，首次安装会撞上"找不到 dsh-pet 原生包"
  //    （做法照 dsh-pet-ccswitch 的 ensurePlugin）。
  try {
    const req = createRequire(path.join(CODE_DIR, 'package.json'));
    cands.push(path.dirname(req.resolve('dsh-pet/package.json')));
  } catch { /* 没装依赖（例如直接跑源码目录里的 cli.mjs） */ }

  // 1) npm 缓存里的 _npx 副本（跑过一次 npx 就会留下；通常是干净的原生包）
  for (const root of [path.join(local, 'npm-cache', '_npx'), path.join(roaming, 'npm-cache', '_npx')]) {
    try {
      for (const d of fs.readdirSync(root)) cands.push(path.join(root, d, 'node_modules', 'dsh-pet'));
    } catch { /* 没这个目录 */ }
  }
  // 2) 运行数据目录里那份（只有没打过补丁才能当原生包用）
  cands.push(PLUGIN_DIR);

  // 逐个候选都验一遍"干净"：只有没被任何补丁动过的才能当还原源，
  // 否则会拿一份打过补丁的产物当原生包，叠上去越改越乱。
  for (const c of cands) {
    if (fs.existsSync(pluginHelper(c)) && isPristine(c)) return c;
  }
  return null;
}

/**
 * 备好 plugin。
 * restore=true（install/--restore 用）：发现原生包就**整份换成原生包**，避免在别人改过的产物上叠补丁。
 * 换的过程用「临时目录 + rename」，复制到一半失败也不会毁掉现有插件。
 */
function ensurePlugin({ restore = false, quiet = false } = {}) {
  const note = (...a) => { if (!quiet) say(...a); };
  const have = fs.existsSync(HELPER_ENTRY);
  if (have && !restore) return { ok: true, note: '已存在（跳过还原）' };
  if (have && isPristine(PLUGIN_DIR)) return { ok: true, note: '已是原生包' };

  const src = findPristine();
  if (!src) {
    if (have) return { ok: true, note: '已存在（没找到原生包，无法还原；补丁会尽量就地迁移）', degraded: true };
    return { ok: false, note: '找不到 dsh-pet 原生包：先在有网络的目录跑一次原版 install，或 npm i dsh-pet' };
  }
  if (src === PLUGIN_DIR) return { ok: true, note: '已是原生包' };

  note(`  从 ${src} 还原原生包…`);
  const tmp = `${PLUGIN_DIR}.new`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true });
    if (!fs.existsSync(pluginHelper(tmp))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, note: '复制后仍缺入口文件' };
    }
    if (fs.existsSync(PLUGIN_DIR)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.renameSync(PLUGIN_DIR, `${PLUGIN_DIR}.bak-${stamp}`);
    }
    fs.renameSync(tmp, PLUGIN_DIR);
    return { ok: true, note: '已还原原生包' };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, note: '还原失败：' + e.message };
  }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
async function cmdDoctor() {
  say('\n== 环境自检 ==\n');

  // ---- Hermes 服务端 ----
  say(`[Hermes]  HERMES_HOME=${HERMES_HOME}`);
  const s = await serviceStatus();
  say(s.running
    ? ok(`服务在运行（pid ${s.pid}${s.uptimeMs ? '，已运行 ' + humanDuration(s.uptimeMs) : ''}${s.phase ? '，phase=' + s.phase : ''}）`)
    : dot('服务未运行（不影响安装：桌宠会在它启动时出现）'));
  if (s.running && !s.healthy) say(`  ! 进程在，但心跳已 ${Math.round((s.hbAgeMs ?? 0) / 1000)}s 未更新（可能卡住；Hermes 自带的 gateway_watchdog 会处理）`);
  say(fs.existsSync(GATEWAY_PID) ? ok(`gateway.pid：${GATEWAY_PID}`) : dot('没有 gateway.pid（服务没起过或已清理）'));
  say(fs.existsSync(GATEWAY_HEARTBEAT) ? ok(`心跳文件：${GATEWAY_HEARTBEAT}（30s 一跳）`) : dot('没有心跳文件'));
  say(fs.existsSync(GATEWAY_LIFECYCLE) ? ok(`生命周期文件：${GATEWAY_LIFECYCLE}`) : dot('没有生命周期文件'));

  const gw = pickGatewayProcess(await findHermesProcesses());
  say(gw ? ok(`网关进程：pid ${gw.pid}`) : dot('进程列表里没看到网关（可能确实没跑）'));

  const exe = await findHermesExe();
  say(exe ? ok(`hermes.exe：${exe}`) : bad('没找到 hermes.exe（「打开 Hermes 面板」会退化成打开链接）'));
  say(fs.existsSync(GATEWAY_LAUNCHER) ? ok(`服务启动器：${GATEWAY_LAUNCHER}`) : dot('没有 gateway-service 启动器（会用 hermes.exe gateway run 兜底）'));
  const dash = await dashboardListening();
  say(dash ? ok(`面板在跑：${DASHBOARD_URL}`) : dot(`面板没在跑（${DASHBOARD_URL}；菜单点了会让 Hermes 自己拉起来）`));

  // ---- 数据 ----
  if (fs.existsSync(STATE_DB)) {
    say(ok(`状态库：${STATE_DB}`));
    try {
      const cur = await cumulativeUsage();
      say(ok(`读库成功：累计 ${humanTokens(cur.tokens)} token（含缓存 ${humanTokens(cur.tokensWithCache)}）/ ${cur.requests} 次调用 / $${cur.cost.toFixed(4)}`));
      const t = await todayUsage();
      const how = t.exact ? '（真·今日）'
        : (t.approximate ? '（约数：首日基线只算今天新开的会话；跨天后自动变准）' : `（${t.baselineLabel} 起）`);
      say(ok(`今日增量：${humanTokens(t.today.tokens)} token / ${t.today.requests} 次 / $${t.today.cost.toFixed(4)} ${how}`));
      say(dot(`账本：${USAGE_LEDGER}`));
      const rs = await recentSessions(3);
      for (const r of rs) {
        say(dot(`最近会话 ${r.id}  [${r.source}/${r.model}] ${r.calls} 次 / in ${humanTokens(r.input)} out ${humanTokens(r.output)} / $${(Number(r.cost) || 0).toFixed(4)}`));
      }
    } catch (e) {
      say(bad(`读库失败：${e.message}（Hermes 若升级改了表结构，请提 issue）`));
    }
  } else {
    say(bad(`找不到状态库 ${STATE_DB}`));
  }

  // ---- 凭证与模型通道 ----
  const key = deepseekKey();
  say(key ? ok(`DeepSeek 凭证：已从 ${HERMES_ENV} 读到（${key.length} 字符，不回显）`) : bad(`没读到 DEEPSEEK_API_KEY（看 ${HERMES_ENV}）`));
  if (key) {
    const b = await deepseekBalance({ force: true });
    say(b.ok ? ok(`余额接口连通：${b.display}`) : bad(`余额接口失败：${b.message}`));
  }
  say(dot(`碎碎念/对话模型：${LLM_MODEL}（直连 DeepSeek，不走网关）`));

  // ---- 桌宠侧 ----
  const p = patchesInPlace({ pluginDir: PLUGIN_DIR });
  if (p.total && p.ok === p.total) say(ok(`dsh-pet 补丁齐全（${p.ok}/${p.total}）`));
  else if (!fs.existsSync(PLUGIN_DIR)) say(bad('还没装 dsh-pet（跑 install）'));
  else say(bad(`补丁不全：${p.ok}/${p.total}，缺 ${p.missing.join(', ')}（跑 patch --restore）`));

  say(fs.existsSync(electronBinary()) ? ok(`Electron：${electronBinary()}`) : bad('缺 Electron（跑 install 自动下载，或设 PET_ELECTRON_PATH）'));

  const alive = await hostAlive();
  say(alive ? ok('宿主正在运行') : dot('宿主未运行'));
  say(fs.existsSync(STARTUP_VBS()) ? ok(`开机自启已注册：${STARTUP_VBS()}`) : dot('未注册开机自启'));
  if (fs.existsSync(OLD_STARTUP_VBS())) say(bad(`还留着上一版的自启项（会抢 3080 端口）：${OLD_STARTUP_VBS()} —— 跑 install 会自动摘掉`));
  say('');
}

async function cmdInstall(argv) {
  say('\n== 安装 dsh-pet-hermes ==\n');
  ensureDirs();

  say('[1/6] 停掉旧宿主 + 摘掉上一版自启');
  await cmdStop({ quiet: true });
  say('  ' + ok('旧宿主已停'));
  say('  ' + (removeLegacyStartupVbs() ? ok('已摘掉 dsh-pet-ccswitch.vbs 自启项') : dot('没有上一版自启项')));

  say('[2/6] 准备 dsh-pet 插件（必要时还原原生包）');
  const pl = ensurePlugin({ restore: true });
  say('  ' + (pl.ok ? ok(pl.note) : bad(pl.note)));
  if (!pl.ok) process.exit(1);

  say('[3/6] 打补丁');
  const st = applyPatches({ pluginDir: PLUGIN_DIR, quiet: true });
  say(`  applied=${st.applied} skipped=${st.skipped} failed=${st.failed}`);
  if (st.failed) say('  ! 有补丁没打上（上游可能改过），相关功能会退化成原版行为');

  say('[4/6] 准备 Electron');
  const el = await ensureElectron();
  say('  ' + (el.ok ? ok(el.note) : bad(el.note)));

  say('[5/6] 同步代码到运行目录');
  say('  ' + ok(syncApp()));

  say('[6/6] 注册开机自启');
  say('  ' + ok(writeStartupVbs(APP_DIR)));

  say('\n启动…');
  if (await hostAlive()) say('  ' + ok('宿主已在运行'));
  else { startDetached(); say((await waitHost()) ? '  ' + ok('已启动') : '  ' + bad('启动超时，看日志：' + HOST_LOG)); }

  const s = await serviceStatus();
  say(`\nHermes 服务：${s.running ? `在线（pid ${s.pid}）` : '未在线'}`);
  if (!s.running) {
    say('  桌宠现在不会出现（这是设计：跟着服务走）。要让它立刻出现，先把服务拉起来：');
    say('    hermes gateway run     （或用 Hermes 自带的 gateway-service\\Hermes_Gateway.vbs）');
  }
  say('\n完成。\n');
}

async function cmdStart(argv = []) {
  // start --with-hermes：顺手把 Hermes 服务也拉起来（走 Hermes 自带的那套已验证的启动器）
  if (argv.includes('--with-hermes')) {
    const r = await launchGateway();
    say(r.ok ? ok(`已拉起 Hermes 服务（${r.via}）`) : bad(`拉起服务失败：${r.message}`));
  }
  if (await hostAlive()) return say(ok('宿主已在运行'));
  startDetached();
  if (await waitHost()) return say(ok('已启动'));
  // 失败要用**退出码**表达出来：桌面快捷方式靠它决定"报错窗口留不留"（`|| pause`）
  say(bad('启动超时，看日志：' + HOST_LOG));
  process.exit(1);
}

async function cmdStop(opts = {}) {
  const quiet = opts.quiet === true;
  const pid = await hostPid();
  if (!pid) { if (!quiet) say(dot('宿主没在运行')); return; }
  try {
    // 必须限定 node.exe：否则命令行里恰好含 "host.mjs" 的其它进程（比如正在跑本命令的 shell）会被误杀
    await ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'host\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }");
  } catch {}
  if (!quiet) say(ok('已停止（桌宠窗口一并关闭）'));
}

async function cmdStatus() {
  const alive = await hostAlive();
  const pid = await hostPid();
  const s = await serviceStatus();
  say(`宿主：${alive ? '运行中' : '未运行'}${pid ? ` (PID ${pid})` : ''}`);
  say(`Hermes 服务：${s.running ? `运行中 (PID ${s.pid}${s.uptimeMs ? '，已运行 ' + humanDuration(s.uptimeMs) : ''})` : '未运行'}`);
  say(`Hermes 面板：${(await dashboardListening()) ? '在跑' : '未在跑'}（${DASHBOARD_URL}）`);
  if (alive) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/dsh-pet-7340/balance`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const d = j.data || {};
      say(`今日：${humanTokens(d.total)} token / ${d.toppedUp} 次请求 / $${d.granted}   ${d.periodLabel || ''}`);
      if (d.balances && d.balances.length) for (const line of d.balances) say(`      ${line}`);
    } catch (e) { say('取用量失败：' + e.message); }
  } else {
    try {
      const t = await todayUsage();
      say(`今日：${humanTokens(t.today.tokens)} token / ${t.today.requests} 次 / $${t.today.cost.toFixed(4)}   ${t.exact ? '（真·今日）' : `（${t.baselineLabel} 起）`}`);
      const b = await deepseekBalance();
      say(`余额：${b.ok ? b.display : '查询失败——' + b.message}`);
    } catch (e) { say('读取失败：' + e.message); }
  }
}

async function cmdPatch(argv) {
  const restore = argv.includes('--restore');
  const dry = argv.includes('--dry-run');
  if (restore) {
    say('先从原生包还原…');
    const pl = ensurePlugin({ restore: true });
    say('  ' + (pl.ok ? ok(pl.note) : bad(pl.note)));
  }
  say(dry ? '试打补丁（dry-run，不写文件）…' : '打补丁…');
  const st = applyPatches({ pluginDir: PLUGIN_DIR, dryRun: dry });
  say(`  applied=${st.applied} skipped=${st.skipped} failed=${st.failed}`);
  if (dry) {
    say('\n（dry-run 未改任何文件；确认 failed=0 再跑不带 --dry-run 的 patch）');
    return;
  }
  const p = patchesInPlace({ pluginDir: PLUGIN_DIR });
  say(p.ok === p.total ? ok(`补丁齐全 ${p.ok}/${p.total}`) : bad(`仍缺：${p.missing.join(', ')}`));
  say('\n（改的是 %LOCALAPPDATA%\\dsh-pet\\plugin，已运行的桌宠要重开窗口才生效：stop 再 start）');
}

async function cmdUninstall(argv) {
  await cmdStop();
  say(removeStartupVbs() ? ok('已移除开机自启') : dot('没有开机自启项'));

  if (!argv.includes('--purge')) {
    say(`运行数据保留在 ${HOME}（配置/记忆都在；要删加 --purge）`);
    return;
  }

  // 先把配置/记忆备份到 HOME **之外**再删 —— 备份写在 HOME 里会跟着一起被删掉，等于没备份
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = path.join(path.dirname(HOME), `dsh-pet-backup-${stamp}`);
  const saved = [];
  for (const name of ['main-config.json', 'memory.json', 'hermes-usage-ledger.json']) {
    const f = path.join(USER_DIR, name);
    if (!fs.existsSync(f)) continue;
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(f, path.join(backupDir, name));
      saved.push(name);
    } catch (e) {
      say(`  ! 备份 ${name} 失败：${e.message}`);
    }
  }
  say(`  配置/记忆已备份到 ${backupDir}${saved.length ? '（' + saved.join('、') + '）' : '（无文件可备份）'}`);

  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch (e) {
    say(bad(`删除时报错：${e.message}`));
  }
  if (fs.existsSync(HOME)) {
    const left = fs.readdirSync(HOME).join('、') || '(空)';
    say(`部分残留：${left}`);
    say('（多半是正在运行的这份 CLI 自身所在目录，手工删掉即可）');
  } else {
    say(ok(`已删除运行数据 ${HOME}`));
  }
}

// ---------------------------------------------------------------------------
const [, , cmd = 'status', ...rest] = process.argv;
const table = {
  install: cmdInstall, start: cmdStart, stop: cmdStop, status: cmdStatus,
  restart: async () => { await cmdStop(); await new Promise((r) => setTimeout(r, 1200)); return cmdStart(); },
  patch: cmdPatch, doctor: cmdDoctor, uninstall: cmdUninstall,
};

if (!table[cmd]) {
  say('dsh-pet-hermes <install|start|stop|restart|status|patch [--restore]|doctor|uninstall [--purge]>');
  process.exit(1);
}
try { await table[cmd](rest); }
catch (e) { console.error('出错了：' + (e && e.stack ? e.stack : e)); process.exit(1); }
