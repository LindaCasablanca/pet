/**
 * patch.mjs —— 给 dsh-pet 的构建产物打补丁（幂等、可测、可就地迁移）
 *
 * 为什么还要打补丁：dsh-pet 是给 DSH 用的 —— 气泡只有一行短文案、右键菜单指向 DSH 网站。
 * 我们要它显示「今日 token / 累计 / DeepSeek 余额」并把菜单指向 Hermes 面板。
 *
 * 幂等策略：每条规则有唯一 id，新文本里带标记 `[hermes 改造:<id>]`。
 *   有标记              → 跳过（打过了）
 *   无标记但认得出原文    → 替换
 *   无标记也认不出        → **告警但继续**（上游改过；功能退化成原版，不崩）
 *
 * 两条匹配路径（install 会优先走 ①，② 是没法还原原生包时的兜底）：
 *   ① 原生原文（dsh-pet **0.3.6** 逐字校对）
 *   ② 备用锚点 —— 两种来源：
 *      a) 上一版（CC Switch 版）改过的文本，见 lib/legacy-snippets.json
 *      b) 旧版 dsh-pet（0.2.x）同一处的写法（内联在规则里，见 bubble-wide）
 *      目的都是"目标不是 0.3.6 时也能尽量就地迁移"；认不出只告警，不崩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR } from './paths.mjs';

const H = (dir) => path.join(dir, 'runtime', 'electron-helper');
const tag = (id) => `[hermes 改造:${id}]`;

/** 上一版（CC Switch 版）改过的文本，作为就地迁移的候选 */
function legacySnippets() {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'legacy-snippets.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 所有规则。`first` 按 dsh-pet **0.3.6** 的 npm 产物逐字校对过（实测 15/15 命中）。 */
function rules(pluginDir, legacy) {
  const h = H(pluginDir);
  const S = path.join(h, 'shared-core.js');
  const SP = path.join(h, 'sprite.js');
  const M = path.join(h, 'main.js');
  const HTML = path.join(h, 'index.html');
  const E = path.join(h, 'events.js');
  const CFG = path.join(pluginDir, 'assets', 'config.jsonc');
  return [
    // ---- 解析层：带上余额行 / 余额数值 / 刻度上限 / 时间口径标签 ----
    {
      id: 'parse-balance',
      file: S,
      // dsh-pet ≥ 0.3 把解析重构成 toBalanceState()，且是白名单构造 ——
      // 宿主多下发的扩展字段不会自动带出来，必须在这里补进 state。
      first: '\tif (r.shape === "money") return {\n\t\tprovider,\n\t\tshape: "money",\n\t\tok: true,\n\t\tcurrency: typeof d.currency === "string" ? d.currency : void 0,\n\t\ttotal: typeof d.total === "string" ? d.total : void 0,\n\t\tgranted: typeof d.granted === "string" ? d.granted : void 0,\n\t\ttoppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0,\n\t\tfullBalance: typeof d.fullBalance === "string" ? d.fullBalance : void 0,\n\t\ttier: d.tier === "peak" || d.tier === "idle" ? d.tier : void 0\n\t};',
      // ⚠ 这里**故意不给 legacy**：CC Switch 版的片段是 0.2.x 结构里的一小段，
      //   拿 0.3.x 的整块 next 去替换它只会产出坏代码。宁可"认不出并告警"，
      //   也不要静默写出一个语法都不对的产物。（安装走"整份还原原生包"，这条路本来也用不上。）
      next: '\tif (r.shape === "money") return {\n\t\tprovider,\n\t\tshape: "money",\n\t\tok: true,\n\t\tcurrency: typeof d.currency === "string" ? d.currency : void 0,\n\t\ttotal: typeof d.total === "string" ? d.total : void 0,\n\t\tgranted: typeof d.granted === "string" ? d.granted : void 0,\n\t\ttoppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0,\n\t\tfullBalance: typeof d.fullBalance === "string" ? d.fullBalance : void 0,\n\t\ttier: d.tier === "peak" || d.tier === "idle" ? d.tier : void 0,\n\t\t// [hermes 改造:parse-balance] 余额行（宿主 /balance 下发，逐行显示在气泡里）\n\t\tbalances: Array.isArray(d.balances) ? d.balances.filter((x) => typeof x === "string") : void 0,\n\t\t// [hermes 改造:parse-balance] 首行口径标签：真·今日 vs 今日 ≈ vs 今日（自 HH:MM）\n\t\tperiodLabel: typeof d.periodLabel === "string" && d.periodLabel ? d.periodLabel : void 0,\n\t\t// [hermes 改造:parse-balance] 今日用量。⚠ 不能再借 total/granted/toppedUp ——\n\t\t// 0.3.x 把这三个字段定义成「金额」，语义已占，只能另起字段名。\n\t\ttodayTokens: typeof d.todayTokens === "string" ? d.todayTokens : void 0,\n\t\ttodayRequests: typeof d.todayRequests === "string" ? d.todayRequests : void 0,\n\t\ttodayCost: typeof d.todayCost === "string" ? d.todayCost : void 0\n\t};',
    },
    // ---- 档位百分比：改跟账户余额走 ----
    // ---- 气泡内容：今日 token / 余额 / 累计 / 请求数·花费 ----
    {
      id: 'bubble-rows',
      file: S,
      // 0.2.x 这里调 deepseekPricingTier() 本地推峰谷；0.3.x 上游把它删了，
      // 改成「服务端给 state.tier」。DeepSeek 官方 /user/balance 不返回 tier，
      // 所以我们干脆不用峰谷那三行，直接铺自己的 5 行。
      first: '\t\tconst symbol = state.currency === "USD" ? "$" : "\u00a5";\n\t\tconst amount = symbol + (state.total ?? "-");\n\t\tif (!state.tier) return [{\n\t\t\trole: "label",\n\t\t\ttext: "\u4f59\u989d " + amount\n\t\t}];\n\t\treturn [\n\t\t\t{\n\t\t\t\trole: "label",\n\t\t\t\ttext: "\u4f59\u989d\uff08"\n\t\t\t},\n\t\t\t{\n\t\t\t\trole: "tier",\n\t\t\t\ttier: state.tier,\n\t\t\t\ttext: state.tier === "peak" ? "\u5cf0" : "\u8c37"\n\t\t\t},\n\t\t\t{\n\t\t\t\trole: "label",\n\t\t\t\ttext: "\uff09" + amount\n\t\t\t}\n\t\t];',
      // 同上：不给 legacy —— CC Switch 版那段是 0.2.x 结构的一部分，替换后会留下坏代码。
      next: '\t\t// [hermes 改造:bubble-rows] 气泡改为「今日 token / 服务·余额 / 累计 / 今日请求数·花费」\n\t\tconst fmtTok = (n) => {\n\t\t\tconst x = Number(n) || 0;\n\t\t\tif (x >= 1e8) return (x / 1e8).toFixed(2).replace(/\\.?0+$/, "") + " \u4ebf";\n\t\t\tif (x >= 1e4) return (x / 1e4).toFixed(1).replace(/\\.0$/, "") + " \u4e07";\n\t\t\treturn String(x);\n\t\t};\n\t\tconst rows = [\n\t\t\t{\n\t\t\t\trole: "label",\n\t\t\t\t// periodLabel 由宿主下发：真·今日 / 今日 ≈ / 今日（自 21:03）\n\t\t\t\ttext: (state.periodLabel || "\u4eca\u65e5") + " " + fmtTok(state.todayTokens) + " token"\n\t\t\t}\n\t\t];\n\t\tconst balances = Array.isArray(state.balances) ? state.balances : [];\n\t\tfor (const line of balances.slice(0, 4)) rows.push({ role: "sub", text: line });\n\t\trows.push({\n\t\t\trole: "sub",\n\t\t\ttext: "\u4eca\u65e5 " + (state.todayRequests ?? "-") + " \u6b21\u8bf7\u6c42 \u00b7 $" + (state.todayCost ?? "-")\n\t\t});\n\t\treturn rows;',
    },
    // ---- 右键菜单文案 ----
    {
      id: 'menu-labels',
      file: SP,
      first: `    const tools = [{ label: '打开网站', action: 'open-site' }];
    if (this.pet.balanceEnabled) tools.push({ label: '查看余额', action: 'show-balance' });`,
      legacy: legacy['menu-labels'],
      next: `    // ${tag('menu-labels')} 菜单指向 Hermes 服务端（打开官方 Web 面板）；余额项改名
    const tools = [{ label: '打开 Hermes 面板', action: 'open-site' }];
    if (this.pet.balanceEnabled) tools.push({ label: '查看用量与余额', action: 'show-balance' });`,
    },
    // ---- 右键菜单：退出桌宠 ----
    {
      id: 'menu-quit',
      file: SP,
      // 锚点只到 `home` 那行为止，不含结尾的 `);` ——
      // 0.3.x 在它后面又加了「重载配置」项，带上 `);` 就匹配不上了。
      first: '    tools.push(\n      { label: \'\u788e\u788e\u5ff5\', action: \'whisper\' },\n      { label: \'\u5bf9\u8bdd\', action: \'chat\' },\n      { label: \'\u56de\u5230\u521d\u59cb\u4f4d\u7f6e\', action: \'home\' },',
      next: '    tools.push(\n      { label: \'\u788e\u788e\u5ff5\', action: \'whisper\' },\n      { label: \'\u5bf9\u8bdd\', action: \'chat\' },\n      { label: \'\u56de\u5230\u521d\u59cb\u4f4d\u7f6e\', action: \'home\' },\n      // [hermes \u6539\u9020:menu-quit] \u9000\u51fa\uff1a**\u8fde\u5bbf\u4e3b\u4e00\u8d77\u9000**\u3002\u53ea\u5173\u7a97\u53e3\u4f1a\u7559\u4e0b\u300c\u5bbf\u4e3b\u5728\u8dd1\u3001\u4f46\u5ba0\u7269\u4e0d\u5728\u300d\u7684\n      // \u4e0d\u4e00\u81f4\u72b6\u6001 \u2014\u2014 \u90a3\u65f6\u518d\u53cc\u51fb\u542f\u52a8\u56fe\u6807\uff0ccmdStart \u770b\u5230 hostAlive \u5c31\u62a5\u300c\u5bbf\u4e3b\u5df2\u5728\u8fd0\u884c\u300d\uff0c\n      // \u800c\u684c\u5ba0\u6c38\u8fdc\u4e0d\u518d\u51fa\u73b0\u3002\u653e\u5de5\u5177\u533a\u6700\u540e\uff0c\u79bb\u52a8\u753b\u9879\u6700\u8fdc\uff0c\u964d\u4f4e\u8bef\u70b9\u3002\n      { label: \'\u9000\u51fa\u684c\u5ba0\', action: \'quit\' },',
    },
    // ---- 右键菜单动作：quit 分支 ----
    {
      id: 'quit-action',
      file: SP,
      first: `    if (leaf.action === 'home') {
      this.goHome(); // 停漫游/移动，清会话位置，回配置角落
      return;
    }`,
      next: `    if (leaf.action === 'home') {
      this.goHome(); // 停漫游/移动，清会话位置，回配置角落
      return;
    }
    // ${tag('quit-action')} 退出：交给宿主收摊（它先关宠物、再退自己）。
    // 为什么不在这里自己关窗口：宿主还活着的话就成了「宿主在跑但没宠物」，下次启动卡死；
    // 而宿主一退，Electron 侧的管道存亡守卫会自己跟着退（main.js 已有这条通路），不必重复实现。
    if (leaf.action === 'quit') {
      fetch(BASE + '/ctl/quit', { method: 'POST' }).catch(() => {
        // 宿主要是已经不在，Electron 下次写管道就会被存亡守卫发现并自行退出，这里不必补救
      });
      return;
    }`,
    },
    // ---- 多行气泡用宽框 ----
    {
      id: 'bubble-wide',
      file: SP,
      first: '    this.bubble.classList.toggle(\n      \'is-whisper\',\n      // \u4f59\u989d\u300c\u6587\u5b57\u8bf4\u660e\u300d\uff08\u4e0d\u53ef\u7528\u72b6\u6001\uff09\u540c\u6837\u8981\u6362\u884c\u53d8\u4f53\uff1a\u9ed8\u8ba4 nowrap \u4f1a\u628a\u957f\u6587\u6848\u9876\u51fa\u5ba0\u7269\u5bbd\u5ea6\n      slot === \'whisper\' || slot === \'work\' || (slot === \'balance\' && this.balanceWrap),\n    );',
      // 0.2.x 的同一处（条件写法不同）—— 留着当回退路径，两个版本都能打
      legacy: '    this.bubble.classList.toggle(\n      \'is-whisper\',\n      // \u4f59\u989d\u300c\u6587\u5b57\u8bf4\u660e\u300d\uff08\u4e0d\u53ef\u7528\u72b6\u6001\uff09\u540c\u6837\u8981\u6362\u884c\u53d8\u4f53\uff1a\u9ed8\u8ba4 nowrap \u4f1a\u628a\u957f\u6587\u6848\u9876\u51fa\u5ba0\u7269\u5bbd\u5ea6\n      this.workOn || (this.whisperOn && !!this.whisperView) || (this.bubbleOn && this.balanceWrap),\n    );',
      next: '    this.bubble.classList.toggle(\n      \'is-whisper\',\n      // \u4f59\u989d\u300c\u6587\u5b57\u8bf4\u660e\u300d\uff08\u4e0d\u53ef\u7528\u72b6\u6001\uff09\u540c\u6837\u8981\u6362\u884c\u53d8\u4f53\uff1a\u9ed8\u8ba4 nowrap \u4f1a\u628a\u957f\u6587\u6848\u9876\u51fa\u5ba0\u7269\u5bbd\u5ea6\n      slot === \'whisper\' || slot === \'work\' || (slot === \'balance\' && this.balanceWrap),\n    );\n    // [hermes \u6539\u9020:bubble-wide] \u591a\u884c\u7528\u91cf\u6c14\u6ce1\uff08\u22653 \u884c\uff09\u5f3a\u5236\u7528\u66f4\u5bbd\u7684\u6846\uff0c\u5426\u5219\u9996\u884c\u4f1a\u88ab\u6324\u65ad\n    this.bubble.classList.toggle(\n      \'is-wide\',\n      this.bubbleOn && !this.workOn && !this.whisperOn\n        && Array.isArray(this.balanceView) && this.balanceView.length >= 3,\n    );',
    },
    // ---- 菜单「打开 Hermes 面板」 ----
    {
      id: 'open-site',
      file: M,
      first: `  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    shell.openExternal(url).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  });`,
      legacy: legacy['open-site'],
      next: `  // ${tag('open-site')} 右键菜单「打开 Hermes 面板」—— 两件事都得对，缺一个就表现成"点了没反应"：
  //
  //  ① 开哪个地址：渲染端发来的是 CONFIG.configUrl 的 origin，也就是**本宿主的 3080**（配置服务），
  //     不是 Hermes 面板。所以这里以宿主注入的 HERMES_DASHBOARD_URL 为准，渲染端那个值只作兜底。
  //
  //  ② 多快能开：hermes CLI 是 Python 进程，冷启动实测 7s+（连 --status 这种纯查询都要 7.3s），
  //     而面板平时**本来就在跑**（HTTP 探活一次只要 30ms）。所以绝不能每次点击都去冷启动 CLI ——
  //     先探活：活着直接 openExternal（毫秒级）；确实没跑，才起 CLI、等端口就绪再开浏览器。
  const PANEL_URL = process.env.HERMES_DASHBOARD_URL || '';
  const HERMES_EXE = process.env.HERMES_EXE || '';
  const HERMES_HOME = process.env.HERMES_HOME || '';

  // 探活：2xx/3xx 算面板在跑；超时 / 拒连 / 异常一律当没跑。
  const panelAlive = (url, timeoutMs) => new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const target = new URL(url);
      const req = require('node:http').get({
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname || '/',
        timeout: timeoutMs,
      }, (res) => { res.resume(); done(!!res.statusCode && res.statusCode < 400); });
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
    } catch (error) { done(false); }
  });

  const openPanel = (url) => {
    if (!/^https?:[/][/]/.test(url)) return;
    console.error('[dsh-pet-desktop-helper] openPanel: ' + url);
    shell.openExternal(url).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  };

  // 面板没在跑：起 CLI 把服务拉起来，再自己开浏览器。
  //   --no-open   让 CLI 别自己开浏览器（detached + 无窗口时它那次开不一定成），统一由我们开
  //   --skip-build 跳过 web UI 构建（非交互上下文里 npm 不一定可用，而且更慢）
  // 旧实现用 stdio:'ignore' 把子进程输出全吞了 —— 点了没反应，日志里却一句话都查不到。
  const startPanel = (url) => {
    const { spawn } = require('node:child_process');
    const { existsSync } = require('node:fs');
    if (!(HERMES_EXE && existsSync(HERMES_EXE))) {
      console.error('[dsh-pet-desktop-helper] 面板没在跑，但 HERMES_EXE 不可用 → 只开地址：' + url);
      openPanel(url);
      return;
    }
    try {
      const child = spawn(HERMES_EXE, ['dashboard', '--no-open', '--skip-build'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        cwd: HERMES_HOME || undefined,
        env: { ...process.env, HERMES_HOME, PYTHONIOENCODING: 'utf-8' },
      });
      if (child.stderr) {
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => {
          const line = String(chunk).trim();
          if (line) console.error('[dsh-pet-desktop-helper] hermes dashboard: ' + line);
        });
      }
      child.on('error', (error) => console.error('[dsh-pet-desktop-helper] launch Hermes dashboard failed:', error));
      child.unref();
    } catch (error) {
      console.error('[dsh-pet-desktop-helper] launch Hermes dashboard failed:', error);
      openPanel(url);
      return;
    }
    // 等端口就绪：最多 60s（500ms 超时 / 800ms 间隔 ≈ 75 次）。冷启动 + build 回退可能要十几秒。
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      panelAlive(url, 500).then((alive) => {
        if (alive) { clearInterval(timer); openPanel(url); return; }
        if (tries >= 75) {
          clearInterval(timer);
          console.error('[dsh-pet-desktop-helper] 等了 60s 面板仍未就绪，放弃自动打开：' + url);
        }
      });
    }, 800);
  };

  ipcMain.on('pet:open-site', (event, payload) => {
    const t0 = Date.now();
    const sent = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    const url = PANEL_URL || sent; // 面板地址以宿主注入为准（渲染端发来的是宿主自己的 3080）
    if (!/^https?:[/][/]/.test(url)) {
      console.error('[dsh-pet-desktop-helper] open-site：没有可用的面板地址 PANEL_URL=' + JSON.stringify(PANEL_URL) + ' sent=' + JSON.stringify(sent));
      return;
    }
    panelAlive(url, 700).then((alive) => {
      if (alive) { // 面板在跑 —— 毫秒级，不碰 Python
        console.error('[dsh-pet-desktop-helper] 面板在跑，直接打开（' + (Date.now() - t0) + 'ms）：' + url);
        openPanel(url);
        return;
      }
      console.error('[dsh-pet-desktop-helper] 面板没在跑，先拉起服务：' + url);
      startPanel(url);
    });
  });`,
    },
    // ---- 气泡 CSS：允许换行 ----
    {
      id: 'css-wrap',
      file: HTML,
      first: `        opacity: 0;
        transition: opacity 0.25s ease;
        white-space: nowrap;
      }`,
      legacy: legacy['css-wrap'],
      next: `        opacity: 0;
        transition: opacity 0.25s ease;
        /* ${tag('css-wrap')} 原为 nowrap：单行短文案没问题，多行且首行偏长会顶出白框 */
        white-space: normal;
        overflow-wrap: anywhere;
      }`,
    },
    // ---- 气泡 CSS：加宽 ----
    {
      id: 'css-width',
      file: HTML,
      first: `        min-width: calc(var(--pet-size, 462px) * 0.26);
        max-width: calc(var(--pet-size, 462px) * 0.5);`,
      legacy: legacy['css-width'],
      next: `        min-width: calc(var(--pet-size, 462px) * 0.26);
        /* ${tag('css-width')} 原为 0.5：会把「今日 N 亿 token」挤断，放宽 */
        max-width: calc(var(--pet-size, 462px) * 0.62);`,
    },
    // ---- 气泡 CSS：多行宽框规则 ----
    {
      id: 'css-iswide',
      file: HTML,
      first: `      .pet-bub-row {`,
      legacy: legacy['css-iswide'],
      next: `      /* ${tag('css-iswide')} 多行用量气泡（≥3 行）强制一个够宽的框 */
      .pet-bubble.is-wide {
        min-width: calc(var(--pet-size, 462px) * 0.62);
      }
      .pet-bub-row {`,
    },
    // ---- 气泡翻面标记：每帧先清 ----
    {
      id: 'bubble-flip-clear',
      file: SP,
      first: `    this.bubble.classList.toggle(S.MEME_BUBBLE_CLASS, !!whisperImg);`,
      next: `    this.bubble.classList.toggle(S.MEME_BUBBLE_CLASS, !!whisperImg);
    // ${tag('bubble-flip-clear')} 翻面标记先清掉：只有余额气泡会重新判定（碎碎念/工作气泡都是矮泡，不翻）
    this.bubble.classList.remove('is-below');`,
    },
    // ---- 气泡翻面：宠物贴屏幕顶边时改垂到脚下 ----
    {
      id: 'bubble-flip',
      file: SP,
      first: `    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
  }
}`,
      next: `    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    // ${tag('bubble-flip')} 宠物贴屏幕顶边时，气泡改垂到脚下 ——
    //   气泡原设计是「底边钉在宠物头顶上方、往上长」，默认只有一行短文案，顶到屏幕边也无所谓；
    //   我们的用量气泡有 5 行（~183px），宠物停在屏幕顶部时（角落 top-* + marginY 小，实测 100）
    //   窗口上半截在屏幕外，首行会被屏幕裁掉（实测正好切掉 33px = 一行的高度）。
    //   翻面只换 top/bottom、不改高度，所以这里「先量高度，再决定翻不翻」，一次定、不迭代。
    //   取「宠物所在那块屏」的工作区（AREAS，同 visibleClampRect 的口径），多屏/任务栏都不会算错。
    {
      const petTop = this.pos.y;
      const petFeet = this.pos.y + this.winH;
      const area = S.resolveRect(AREAS, this.pos.x + this.halfW, this.pos.y + this.halfH);
      const roomAbove = area ? petTop - area.y : petTop;
      const roomBelow = area ? area.y + area.height - petFeet : VIEW.h - petFeet;
      const need = this.bubble.offsetHeight + this.size * 0.09; // 气泡高 + 尖角与间隙
      this.bubble.classList.toggle('is-below', roomAbove < need && roomBelow > roomAbove);
    }
  }
}`,
    },
    // ---- 气泡 CSS：翻面（垂到脚下，箭头翻到顶部） ----
    {
      id: 'css-below',
      file: HTML,
      first: `      .pet-bub-row {`,
      next: `      /* ${tag('css-below')} 翻面：气泡垂在宠物脚下（贴屏幕顶边时用，否则往上长的气泡会被屏幕裁掉） */
      .pet-bubble.is-below {
        bottom: auto;
        top: calc(var(--pet-size, 462px) * 0.64);
      }
      /* 箭头也跟着翻：原箭头在泡底、朝下指宠物头；垂到脚下后要挪到泡顶、朝上指宠物脚 */
      .pet-bubble.is-below::after {
        top: calc(var(--pet-size, 462px) * -0.017);
        bottom: auto;
        border-top: none;
        border-bottom: calc(var(--pet-size, 462px) * 0.017) solid rgba(255, 255, 255, 0.92);
      }
      .pet-bub-row {`,
    },
    // ---- 工作状态：文案与动画解耦（① 文案每次 tick 都刷新） ----
    {
      id: 'work-text-refresh',
      file: E,
      // events.js 上游与 CC Switch 版都**没动过**这段，所以 first 对两条安装路径都成立
      first: `  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;`,
      next: `  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  // ${tag('work-text-refresh')} 文案与动画解耦（其一）：**文案每次 tick 都刷新**。
  //   宿主（lib/host.mjs → lib/hermes.mjs workState()）在"状态或任务变了"时推进 ts，客户端才 tick，
  //   所以同一档位里换任务（在写 a.md → 在写 b.md）也会来 tick。文案必须跟着刷，
  //   否则"这一轮在干什么"永远停在第一次那条。
  //   但配置兜底句只在档位切换时重抽 —— 让它在 tick 里随机重抽会每秒闪一句。
  const configuredText =
    !stateChanged && this.workText !== null
      ? this.workText
      : Array.isArray(textGroup) && textGroup.length > 0
        ? textGroup[Math.floor(Math.random() * textGroup.length)]
        : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;`,
    },
    // ---- 工作状态：文案与动画解耦（② 动画只在档位变化时切） ----
    {
      id: 'work-anim-per-state',
      file: E,
      first: `  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）`,
      next: `  // ${tag('work-anim-per-state')} 文案与动画解耦（其二）：**动画只在档位真的变了时才切**。
  //   原实现每次 workTick 都 stopMove() + playOnce/switchTo，而宿主每个事件都推进 ts
  //   （实测一次工具循环里 2~4 秒一个事件：tool_call → tool_result → tool_call …）。
  //   档位动画实测时长 = 10.04 秒（出错档 4.92 秒，tools/probe-webm-duration.mjs 可复现），
  //   每 3 秒从头重播 ⇒ 永远只播到前 30%，观感是"卡住抖动"而不是"在忙碌"。
  //   档位没变就什么都不做：动画自己 loop（单候选），或由 handleEnded 轮换到下一候选。
  if (stateChanged) {
    const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
    if (terminal || rotating) this.playOnce(name);
    else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
  }`,
    },
    // ---- 打开工作状态联动（原厂默认 false） ----
  ];
}

/** 对 plugin 目录打补丁；返回统计。dryRun=true 时只报"能不能命中"，一个字都不写。 */
/**
 * 取单条规则（供自验 / 已打补丁的就地升级脚本使用）。
 * 注意：applyPatches 的幂等判定只看 marker，所以「已打过但想换实现」时必须靠这个
 * 拿到新 next，再整体替换旧段落 —— 单靠 applyPatches 是换不掉的（会 skipped）。
 */
export function ruleById(id, { pluginDir = PLUGIN_DIR } = {}) {
  return rules(pluginDir, legacySnippets()).find((r) => r.id === id) || null;
}

export function applyPatches({ quiet = false, pluginDir = PLUGIN_DIR, dryRun = false } = {}) {
  const say = (...a) => { if (!quiet) console.log(...a); };
  const stat = { applied: 0, skipped: 0, failed: 0, details: [], dryRun };
  const legacy = legacySnippets();
  const byFile = new Map();
  for (const r of rules(pluginDir, legacy)) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }

  for (const [file, list] of byFile) {
    const rel = path.relative(pluginDir, file);
    if (!fs.existsSync(file)) {
      say(`  ! 缺文件：${rel}`);
      stat.failed += list.length;
      continue;
    }
    let src = fs.readFileSync(file, 'utf8');
    const before = src;
    const msgs = [];
    for (const r of list) {
      if (src.includes(tag(r.id))) { stat.skipped++; continue; }        // 已打过
      const hit = [r.first, r.legacy].filter(Boolean)
        .map((t) => ({ t, i: src.indexOf(t) }))
        .find((x) => x.i >= 0);
      if (!hit) {
        msgs.push(`跳过 ${r.id}（认不出原文，上游可能改过）`);
        stat.failed++;
        continue;
      }
      src = src.replace(hit.t, r.next);
      stat.applied++;
      msgs.push(`${dryRun ? '可打' : '已打'} ${r.id}${hit.t === r.legacy ? '（用备用锚点）' : ''}`);
    }
    if (src !== before && !dryRun) fs.writeFileSync(file, src);
    say(`  ${rel}${src === before ? '  (无改动)' : dryRun ? '  (可更新，dry-run 未写)' : '  (已更新)'}`);
    for (const m of msgs) say(`      ${m}`);
    stat.details.push(...msgs);
  }
  return stat;
}

/** 检查补丁是否都在位（只读） */
export function patchesInPlace({ pluginDir = PLUGIN_DIR } = {}) {
  const legacy = legacySnippets();
  const list = rules(pluginDir, legacy);
  const missing = [];
  for (const r of list) {
    if (!fs.existsSync(r.file) || !fs.readFileSync(r.file, 'utf8').includes(tag(r.id))) {
      missing.push(r.id);
    }
  }
  return { ok: list.length - missing.length, total: list.length, missing };
}
