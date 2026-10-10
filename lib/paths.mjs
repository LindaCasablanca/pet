/**
 * paths.mjs —— 代码 / 运行数据 / Hermes 数据 三者的路径约定
 *
 * 代码可以在任何地方（npx 临时目录、本地目录），运行数据固定放在：
 *   %LOCALAPPDATA%\dsh-pet         （可用 DSH_PET_HOME 覆盖）
 * 这样升级/重装不会丢配置和记忆；也**刻意与原来那版共用同一个 HOME**，
 * 换绑 Hermes 时不用重新下载 65MB 插件和 100MB Electron。
 *
 * Hermes 那边只读：所有路径都从 HERMES_HOME 推出来，不写死盘符。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** 包根目录（本文件在 <pkg>/lib/ 下） */
export const CODE_DIR = path.resolve(import.meta.dirname, '..');

export const HOME =
  process.env.DSH_PET_HOME ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-pet');

export const PLUGIN_DIR = path.join(HOME, 'plugin');
export const ELECTRON_DIR = path.join(HOME, 'electron');
export const USER_DIR = path.join(HOME, 'user');
export const LOG_DIR = path.join(HOME, 'logs');
export const HOST_LOG = path.join(LOG_DIR, 'host.log');
/** 记住发现到的 hermes.exe 路径 / Hermes 服务 pid 等 */
export const RUNTIME_JSON = path.join(HOME, 'runtime.json');

export const HELPER_ENTRY = path.join(PLUGIN_DIR, 'runtime', 'electron-helper', 'main.js');

// ---------------------------------------------------------------------------
// Hermes 服务端（只读）
// ---------------------------------------------------------------------------
/**
 * HERMES_HOME 解析顺序（与 Hermes 自己的 get_hermes_home 一致）：
 *   1. 环境变量 HERMES_HOME
 *   2. C:\Hermes（本机既定安装点，见 Hermes 速查文档）
 *   3. ~/.hermes（官方默认）
 */
function resolveHermesHome() {
  const fromEnv = process.env.HERMES_HOME;
  if (fromEnv) return fromEnv;
  const known = 'C:\\Hermes';
  if (fs.existsSync(path.join(known, 'state.db'))) return known;
  return path.join(os.homedir(), '.hermes');
}

export const HERMES_HOME = resolveHermesHome();
/** 会话/用量数据库（只读打开；表 sessions / session_model_usage 是数字的唯一来源） */
export const STATE_DB = process.env.HERMES_STATE_DB || path.join(HERMES_HOME, 'state.db');
/** 服务自己写的 pid 文件：{"pid":..., "kind":"hermes-gateway", "start_time":...} */
export const GATEWAY_PID = path.join(HERMES_HOME, 'gateway.pid');
/** state/ 下两份服务自证文件：心跳（30s 一次）+ 生命周期（phase=running） */
export const GATEWAY_STATE_DIR = path.join(HERMES_HOME, 'state');
export const GATEWAY_HEARTBEAT = path.join(GATEWAY_STATE_DIR, 'gateway.heartbeat');
export const GATEWAY_LIFECYCLE = path.join(GATEWAY_STATE_DIR, 'gateway.lifecycle.json');
/** .env：DeepSeek 凭证在这里（碎碎念/对话 + 余额查询都用它） */
export const HERMES_ENV = path.join(HERMES_HOME, '.env');
/** 服务本体与启动器（启动器是她自己那份 gateway_watchdog 走同一条路） */
export const HERMES_EXE = path.join(HERMES_HOME, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe');
export const GATEWAY_LAUNCHER = path.join(HERMES_HOME, 'gateway-service', 'Hermes_Gateway.vbs');
/** Hermes 官方 Web 面板（hermes dashboard 的默认端口） */
export const DASHBOARD_URL = process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:9119';
/** 今日用量的本地账本（增量口径的基线存在这里） */
export const USAGE_LEDGER = path.join(USER_DIR, 'hermes-usage-ledger.json');

export function ensureDirs() {
  for (const d of [HOME, USER_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf8')); } catch { return {}; }
}

export function writeRuntime(patch) {
  const next = { ...readRuntime(), ...patch };
  try {
    ensureDirs();
    fs.writeFileSync(RUNTIME_JSON, JSON.stringify(next, null, 2));
  } catch { /* 写不进去也不影响运行 */ }
  return next;
}

/** electron 可执行文件路径（Windows 下是 electron.exe） */
export function electronBinary() {
  return process.platform === 'win32'
    ? path.join(ELECTRON_DIR, 'electron.exe')
    : path.join(ELECTRON_DIR, 'electron');
}
