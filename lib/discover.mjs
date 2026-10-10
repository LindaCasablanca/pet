/**
 * discover.mjs —— 找 Hermes 服务本体、hermes.exe、启动器
 *
 * 刻意**不写死"服务在哪"**，判活的主判据永远是 Hermes 自己写的 pid/心跳文件
 * （见 hermes.mjs: serviceStatus）。这个文件只负责：
 *   - 进程层面的兜底排查（doctor 用，兜底逻辑用）
 *   - 找到 hermes.exe（打开面板用）
 *   - 拉起服务（走她自己那份 gateway-service\Hermes_Gateway.vbs，同一条已验证的路）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HERMES_HOME, HERMES_EXE, GATEWAY_LAUNCHER, DASHBOARD_URL, readRuntime, writeRuntime,
} from './paths.mjs';

const pExecFile = promisify(execFile);
const isWin = process.platform === 'win32';

async function ps(script, timeout = 20_000) {
  const { stdout } = await pExecFile(
    'powershell.exe',
    ['-NoProfile', '-Command', script],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
  );
  return String(stdout || '').trim();
}

/**
 * 找 Hermes 相关进程（诊断用，不当主判据）。
 * 匹配两样东西：进程名 hermes.exe；或命令行里的 hermes_cli（服务是 python -m hermes_cli.main gateway run）
 */
export async function findHermesProcesses() {
  if (!isWin) return [];
  try {
    const out = await ps(
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'hermes.exe' -or $_.CommandLine -match 'hermes_cli' } | " +
        'Select-Object -First 12 ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    );
    if (!out) return [];
    return [].concat(JSON.parse(out)).map((p) => ({
      pid: Number(p.ProcessId),
      name: p.Name || '',
      cmd: String(p.CommandLine || ''),
    })).filter((p) => p.pid);
  } catch {
    return [];
  }
}

/** 从进程列表里挑出「网关服务」那个（命令行含 gateway run） */
export function pickGatewayProcess(list = []) {
  return list.find((p) => /gateway\s+run/.test(p.cmd)) || null;
}

/** 找 hermes.exe；找不到返回 null（不猜、不写死盘符） */
export async function findHermesExe({ force = false } = {}) {
  if (fs.existsSync(HERMES_EXE)) {
    writeRuntime({ hermesExe: HERMES_EXE });
    return HERMES_EXE;
  }
  const cached = readRuntime().hermesExe;
  if (!force && cached && fs.existsSync(cached)) return cached;

  // 兜底：从正在跑的进程里反查（Hermes 装在别处时也能跟上）
  const procs = await findHermesProcesses();
  for (const p of procs) {
    const m = p.cmd.match(/"([^"]*hermes\.exe)"/i) || p.cmd.match(/(\S*hermes\.exe)/i);
    if (m && fs.existsSync(m[1])) { writeRuntime({ hermesExe: m[1] }); return m[1]; }
  }
  return null;
}

/**
 * 拉起 Hermes 服务。优先用她自己的 gateway-service\Hermes_Gateway.vbs
 * （那股脚本已经把 HERMES_HOME / PYTHONPATH / VIRTUAL_ENV 都设好了，别自己重写一遍）。
 */
export async function launchGateway() {
  try {
    if (fs.existsSync(GATEWAY_LAUNCHER)) {
      const child = execFile('wscript.exe', [GATEWAY_LAUNCHER], { windowsHide: true, cwd: HERMES_HOME });
      child.unref?.();
      return { ok: true, via: GATEWAY_LAUNCHER };
    }
    const exe = await findHermesExe();
    if (!exe) return { ok: false, message: '找不到 hermes.exe 也找不到启动器' };
    const { spawn } = await import('node:child_process');
    spawn(exe, ['gateway', 'run'], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: HERMES_HOME,
      env: { ...process.env, HERMES_HOME },
    }).unref();
    return { ok: true, via: `${exe} gateway run` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * 打开 Hermes 面板。
 * 不自作聪明：`hermes dashboard` 自己会判断端口是否已在监听 —— 在跑就复用并开浏览器，
 * 没跑就起服务再开浏览器（main.py cmd_dashboard 的那两段分支）。我们只负责触发。
 */
export async function openDashboard() {
  const exe = await findHermesExe();
  if (!exe) return { ok: false, message: '找不到 hermes.exe', url: DASHBOARD_URL };
  const { spawn } = await import('node:child_process');
  spawn(exe, ['dashboard'], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: HERMES_HOME,
    env: { ...process.env, HERMES_HOME, PYTHONIOENCODING: 'utf-8' },
  }).unref();
  return { ok: true, url: DASHBOARD_URL, via: exe };
}

/** 面板端口是否在监听（只读探测，用于 status 显示） */
export async function dashboardListening(timeoutMs = 1200) {
  try {
    const res = await fetch(DASHBOARD_URL, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export { DASHBOARD_URL, HERMES_HOME };
