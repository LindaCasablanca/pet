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
 *   ① 原生原文（dsh-pet 0.2.12 逐字校对）
 *   ② 上一版（CC Switch 版）改过的文本 —— 见 lib/legacy-snippets.json
 *      （用 tools/gen-legacy-snippets.py 逐字节截取的，不手抄）
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

/** 所有规则。first 按 dsh-pet 0.2.12 的 npm 产物逐字校对过。 */
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
      first: `			toppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0
		};`,
      legacy: legacy['parse-balance'],
      next: `			toppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0,
			// ${tag('parse-balance')} 余额行（宿主 /balance 下发，逐行显示在气泡里）
			balances: Array.isArray(d.balances) ? d.balances.filter((x) => typeof x === "string") : void 0,
			// ${tag('parse-balance')} 档位动画用：余额数值 + 刻度上限
			// 注意 null/空串必须显式排除：Number(null) === 0，会被误判成「余额归零 = 分文不剩」
			balance:
				d.balanceValue === null || d.balanceValue === void 0 || d.balanceValue === ""
					? void 0
					: (Number.isFinite(Number(d.balanceValue)) ? Number(d.balanceValue) : void 0),
			tierMax: Number(d.tierMax) > 0 ? Number(d.tierMax) : void 0,
			// ${tag('parse-balance')} 首行口径标签：今日用量是"真今日"还是"自 HH:MM 起"（Hermes 没有逐请求日志，得如实标注）
			periodLabel: typeof d.periodLabel === "string" && d.periodLabel ? d.periodLabel : void 0
		};`,
    },
    // ---- 档位百分比：改跟账户余额走 ----
    {
      id: 'balance-percent',
      file: S,
      first: `	if (v.kind === "deepseek") {
		const total = Number(v.total);
		if (!Number.isFinite(total)) return void 0;
		const remaining = Math.max(0, total) / DEEPSEEK_FULL_BALANCE_CNY * 100;
		return Math.max(0, Math.min(100, 100 - remaining));
	}`,
      legacy: legacy['balance-percent'],
      next: `	if (v.kind === "deepseek") {
		// ${tag('balance-percent')} 档位跟「账户余额」走：余额满刻度 = 没怎么花钱 = 0%，归零 = 花光 = 100%
		const bal = Number(v.balance);
		if (!Number.isFinite(bal)) return void 0;
		const max = Number(v.tierMax) > 0 ? Number(v.tierMax) : 300;
		return Math.max(0, Math.min(100, 100 - (bal / max) * 100));
	}`,
    },
    // ---- 气泡内容：今日 token / 余额 / 累计 / 请求数·花费 ----
    {
      id: 'bubble-rows',
      file: S,
      first: `		const tier = deepseekPricingTier();
		return [
			{
				role: "label",
				text: "余额（"
			},
			{
				role: "tier",
				tier,
				text: tier === "peak" ? "峰" : "谷"
			},
			{
				role: "label",
				text: "）¥" + (state.total ?? "-")
			}
		];`,
      legacy: legacy['bubble-rows'],
      next: `		// ${tag('bubble-rows')} 气泡改为「今日 token / 服务·余额 / 累计 / 今日请求数·花费」
		const fmtTok = (n) => {
			const x = Number(n) || 0;
			if (x >= 1e8) return (x / 1e8).toFixed(2).replace(/\\.?0+$/, "") + " 亿";
			if (x >= 1e4) return (x / 1e4).toFixed(1).replace(/\\.0$/, "") + " 万";
			return String(x);
		};
		const rows = [
			{
				role: "label",
				// periodLabel 由宿主下发：真·今日 / 今日(自 21:03)（没有逐请求日志时如实标注）
				text: (state.periodLabel || "今日") + " " + fmtTok(state.total) + " token"
			}
		];
		const balances = Array.isArray(state.balances) ? state.balances : [];
		for (const line of balances.slice(0, 4)) rows.push({ role: "sub", text: line });
		rows.push({
			role: "sub",
			text: "今日 " + (state.toppedUp ?? "-") + " 次请求 · $" + (state.granted ?? "-")
		});
		return rows;`,
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
      // 锚点用这三行（menu-labels 没动它，所以原生包里也是这个文本 → 从原生包重装也能打上）
      first: `    tools.push(
      { label: '碎碎念', action: 'whisper' },
      { label: '对话', action: 'chat' },
      { label: '回到初始位置', action: 'home' },
    );`,
      next: `    tools.push(
      { label: '碎碎念', action: 'whisper' },
      { label: '对话', action: 'chat' },
      { label: '回到初始位置', action: 'home' },
      // ${tag('menu-quit')} 退出：**连宿主一起退**。只关窗口会留下「宿主在跑、但宠物不在」的
      // 不一致状态 —— 那时再双击启动图标，cmdStart 看到 hostAlive 就报「宿主已在运行」，
      // 而桌宠永远不再出现。放工具区最后，离动画项最远，降低误点。
      { label: '退出桌宠', action: 'quit' },
    );`,
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
      first: `    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」（不可用状态）同样要换行变体：默认 nowrap 会把长文案顶出宠物宽度
      this.workOn || (this.whisperOn && !!this.whisperView) || (this.bubbleOn && this.balanceWrap),
    );`,
      legacy: legacy['bubble-wide'],
      next: `    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」（不可用状态）同样要换行变体：默认 nowrap 会把长文案顶出宠物宽度
      this.workOn || (this.whisperOn && !!this.whisperView) || (this.bubbleOn && this.balanceWrap),
    );
    // ${tag('bubble-wide')} 多行用量气泡（≥3 行）强制用更宽的框，否则首行会被挤断
    this.bubble.classList.toggle(
      'is-wide',
      this.bubbleOn && !this.workOn && !this.whisperOn
        && Array.isArray(this.balanceView) && this.balanceView.length >= 3,
    );`,
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
    {
      id: 'work-status-on',
      file: CFG,
      // 带上上面两行注释做锚点，避免只按 `"workStatusEnabled": false` 匹配到未来新增的宠物
      first: `      // 工作状态联动默认关闭：开启后监听 DSH 会话事件（工具调用等），按
      // animations.events.workStatus 数组切档位动画 + 气泡（仅监听，不调用模型）。
      "workStatusEnabled": false,`,
      next: `      // 工作状态联动：开启后监听宿主的 /work-status（6 档 + task 叙事），按
      // animations.events.workStatus 数组切档位动画 + 气泡（仅监听，不调用模型）。
      // ${tag('work-status-on')} 原厂默认 false，这里打开 —— 宿主侧已实现真判据：
      //   lib/hermes.mjs workState() 读 Hermes state.db（cli/cron/feishu 都覆盖），
      //   不仅能报"在干活"，还能说出"在写 run-dsh-pet-install.cmd"。
      //   做成补丁而不是手改，是为了 patch --restore（整份换回原生包）之后这个开关还在。
      "workStatusEnabled": true,`,
    },
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
      msgs.push(`${dryRun ? '可打' : '已打'} ${r.id}${hit.t === r.legacy ? '（就地迁移自 CC Switch 版）' : ''}`);
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
