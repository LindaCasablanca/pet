/**
 * verify-open-site.cjs —— 执行**产物里**的 open-site 段，端到端自验「打开 Hermes 面板」
 *
 * 为什么这么绕：这段代码的主体是 `shell.openExternal`，只有 Electron 环境才拿得到；
 * 而我又不想只看文本就宣布"修好了"。所以从产物 main.js 里按 marker 抽出现场那一段代码，
 * 用 vm 编译、注入假 ipcMain 执行 —— 验的是**跑在用户机器上的那份代码**，不是副本。
 *
 * 两种模式：
 *   ① 纯 node（默认）：shell 打桩、只记录调用 —— 在受限沙箱里也能跑，
 *      足以验证「决策正确 + 地址取对 + 不冷启动 Python」这三条。
 *      node tools/verify-open-site.cjs
 *   ② 真 Electron：shell 用真的，浏览器会真的弹出来（验证最后一跳）。
 *      env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS <electron.exe> tools/verify-open-site.cjs
 *      ⚠ 沙箱内 Electron 的 GPU 子进程起不来（0xC0000005），此模式要在沙箱外跑。
 *
 * 判据：
 *   1) 传进去的 url 故意给宿主自己的 3080（就是线上渲染端发来的那个错地址），
 *      日志里必须出现 http://127.0.0.1:9119 → 证明"以宿主注入的面板地址为准"生效
 *   2) 决策日志带耗时，必须 < 1000ms → 证明"面板在跑时不再冷启动 Python"
 *   3) shell.openExternal 收到同一个 url → 证明真的开出去了
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const IS_ELECTRON = !!process.versions.electron;
let electronApp = null;
let realShell = null;
if (IS_ELECTRON) {
  const e = require('electron');
  electronApp = e.app;
  realShell = e.shell;
  // 这台机器上 Chromium 的 GPU 进程起不来（宿主日志里也是同一现象，所以宿主才有 GPU 降级阶梯）。
  // 本脚本不需要任何渲染，直接关掉硬件加速最省事。
  electronApp.disableHardwareAcceleration();
}

const DRY = process.argv.includes('--dry') || !IS_ELECTRON;
const MAIN =
  process.env.PET_MAIN ||
  path.join(process.env.LOCALAPPDATA || '', 'dsh-pet', 'plugin', 'runtime', 'electron-helper', 'main.js');
const PANEL = process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:9119';
const WRONG_URL = 'http://127.0.0.1:3080'; // 渲染端实际会发的（CONFIG.configUrl 的 origin）

const START_MARK = '  // [hermes 改造:open-site]';
const END_MARK = '  // 显示器热更新：';

function extractOpenSite() {
  if (!fs.existsSync(MAIN)) throw new Error('产物不存在：' + MAIN);
  const src = fs.readFileSync(MAIN, 'utf8');
  const i = src.indexOf(START_MARK);
  if (i < 0) throw new Error('产物里没有 open-site 补丁（marker 缺失）');
  const j = src.indexOf(END_MARK, i);
  if (j < 0) throw new Error('找不到段落结束锚点');
  return src.slice(i, j);
}

const code = extractOpenSite();
const logs = [];
const opened = [];

// 假 ipcMain：只为把 handler 捞出来
const ipcMain = { handlers: {}, on(ch, fn) { this.handlers[ch] = fn; } };
const logStub = {
  error: (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logs.push(s); },
  log: (...a) => { const s = a.map(String).join(' '); logs.push(s); },
  warn: (...a) => { const s = a.map(String).join(' '); logs.push(s); },
};
const shellStub = {
  openExternal: async (u) => {
    opened.push(u);
    if (!DRY && realShell) return realShell.openExternal(u);
  },
};

// 现场那份代码的用户环境：宿主注入的两个变量 + HERMES_HOME
process.env.HERMES_DASHBOARD_URL = PANEL;

const params = ['ipcMain', 'shell', 'console', 'require', 'process', 'URL', 'setInterval', 'clearInterval', 'Date'];
const fn = vm.compileFunction(code + '\nreturn ipcMain;', params, {
  filename: 'main.js#open-site',
});

const t0 = Date.now();
const ipc = fn(ipcMain, shellStub, logStub, require, process, global.URL, setInterval, clearInterval, Date);
const loadMs = Date.now() - t0;

const handler = ipc.handlers['pet:open-site'];
if (!handler) throw new Error('没有注册 pet:open-site handler');

const run = () => {
  const t1 = Date.now();
  handler({}, { url: WRONG_URL }); // 故意发错地址，看它会不会被纠正

  setTimeout(() => {
    const decision = logs.find((l) => l.includes('面板在跑，直接打开')) || '';
    const ms = /（(\d+)ms）/.exec(decision);
    const decisionMs = ms ? Number(ms[1]) : -1;
    const usePanel = decision.includes(PANEL);
    const notWrong = !opened.includes(WRONG_URL);

    const out = {
      mode: DRY ? (IS_ELECTRON ? 'electron(dry)' : 'node(dry)') : 'electron(real)',
      编译耗时ms: loadMs,
      点击到决策ms: Date.now() - t1,
      决策日志: decision || '(无)',
      决策耗时ms: decisionMs,
      打开的地址: opened,
      全部日志: logs,
    };

    const checks = [
      ['决策日志存在', !!decision],
      ['用的是面板地址(9119)而非 3080', usePanel],
      ['没有把 3080 当目标开出去', notWrong],
      ['openExternal 收到面板地址', opened.includes(PANEL)],
      ['决策耗时 < 1000ms（没冷启动 Python）', decisionMs >= 0 && decisionMs < 1000],
    ];
    const failed = checks.filter(([, okv]) => !okv);

    console.log(JSON.stringify(out, null, 2));
    console.log('\n---- 判据 ----');
    for (const [name, okv] of checks) console.log((okv ? '[ok] ' : '[!!] ') + name);
    console.log(failed.length ? '\n结论：失败 ' + failed.length + ' 项' : '\n结论：全部通过');
    process.exit(failed.length ? 1 : 0);
  }, 2500);
};

if (electronApp) electronApp.whenReady().then(run);
else run();
