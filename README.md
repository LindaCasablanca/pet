# dsh-pet-hermes

把 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 桌宠从 DeepSeek Harness **换绑到本地 Hermes 服务**。

- 跟着 **Hermes 网关服务**（`gateway run`）的生命周期起落：服务在跑就出现，停了就消失 —— 不是跟着桌面上那套 Electron 版 Hermes Agent 走。
- 头顶气泡 5 行：今日 token 增量 / 服务状态 / DeepSeek 余额 / 累计用量 / 今日请求数与花费。
- 右键可打开 **Hermes 面板**、看用量余额、让它碎碎念、跟它对话（直连 DeepSeek）。
- 数据全部**只读**取自 Hermes 自己的文件，不改它一个字节。

> **同系列的另一件作品**：[dsh-pet-ccswitch](https://github.com/cloud666666666/dsh-pet-ccswitch)（作者 Joker.Yun）
> —— 把同一只桌宠绑到 CC Switch。本包的宿主骨架来自它，跟随对象与数据源换成了 Hermes。
> 两个包可以并存：`install` 时会自动摘掉对方留下的自启项，避免两个宿主抢 3080 端口。

---

## 快速开始

> ⚠ 本包**尚未发布到 npm registry**，所以 `npx dsh-pet-hermes` 暂时不通；用 `github:` 写法效果一样
> （npm 会直接从仓库拉取）。下文所有 `npx dsh-pet-hermes <命令>` 在发布前都请写成
> `npx github:LindaCasablanca/pet <命令>`。

```bash
npx github:LindaCasablanca/pet install     # 一次性准备（还原原生包 / 打补丁 / 备好 Electron / 注册开机自启）并启动
npx github:LindaCasablanca/pet status      # 自检：Hermes 在哪、库能不能读、服务在不在、补丁齐不齐、缺什么
npx github:LindaCasablanca/pet stop|start|restart
npx github:LindaCasablanca/pet patch       # 重新打补丁（`--restore` 先从原生包整份还原再打）
npx github:LindaCasablanca/pet doctor      # 同 status，侧重诊断
npx github:LindaCasablanca/pet uninstall   # 移除开机自启（`--purge` 连运行数据一起删，会先备份配置）
```

`start --with-hermes` 会顺手把 Hermes 网关服务也拉起来（走她自己的 `gateway-service\Hermes_Gateway.vbs`）。

**前提**：Windows + Node ≥ 22.5 + Hermes 装在 `C:\Hermes`（或设 `HERMES_HOME`）。
首次安装会自动带上 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 插件（约 65MB）与 Electron（约 100MB）。

---

## 升级

两条独立的线：

- **升级本包**：重跑一遍 `install` 即可（`npx github:` 每次都拉最新的 `main`）。
- **升级 dsh-pet**：改 `package.json` 里 `dsh-pet` 的版本、重新 `install`。
  注意 **0.x 的 `^` 只放行同一 minor** —— `^0.2.11` 装不到 `0.3.x`。

⚠ **当前适配的是 dsh-pet 0.2.x**：17 条补丁规则的锚点是照 0.2.12 的产物逐字校对的。
0.3.x 起气泡改成了单槽模型（`slot === 'whisper' || slot === 'work' || ...`），锚点需要重对
（`bubble-wide` 那条首当其冲）。好在补丁认不出原文时会**告警并退化成原版行为**，不会把桌宠弄坏。

---

## 它绑的是"哪一个 Hermes"

| | 绑定的 | 明确排除的 |
|---|---|---|
| 进程 | `python -m hermes_cli.main gateway run`（接飞书长连接的那个） | `%APPDATA%\Hermes` 那套 Electron 桌面壳 |

判活依据（跟她自己的 `gateway_watchdog.py` 同一套口径）：

| 判据 | 文件 | 说明 |
|---|---|---|
| 主判据 | `C:\Hermes\gateway.pid` → `pid` | 用 `tasklist` 判进程存活；**刻意不用 `process.kill(pid,0)`** |
| 心跳 | `C:\Hermes\state\gateway.heartbeat` | 30s 一跳；停滞 > 120s 只**告警**不判死 |
| 阶段 | `C:\Hermes\state\gateway.lifecycle.json` | `phase=running` |

调试用环境变量：`PET_HERMES_FORCE=up|down` 强制状态、`PET_HERMES_PID=<pid>` 指定进程。

---

## 气泡里的 5 行，数从哪来

| 行 | 来源 | 口径 |
|---|---|---|
| `今日 ≈ 10.3 万 token` | 本地账本 + `state.db` | 见下方「今日口径」 |
| `Hermes 服务在线，已运行 36 分钟` | `gateway.pid` + 进程启动时间 | |
| `DeepSeek 余额 ¥241.30` | `C:\Hermes\.env` 的 key → `/user/balance` | 成功缓存 3 分钟、失败缓存 30 秒 |
| `累计 542.6 万 token（含缓存 2.08 亿）` | `state.db` → `sessions` 求和 | 含缓存读写 |
| `今日 43 次请求 · $0.0237` | 同账本（`api_call_count` / `estimated_cost_usd`） | |

### 「今日」为什么要自己记一本账

Hermes 的 `state.db` 里没有能直接用的逐日用量：

- `sessions` 里是**会话累计**值（最早的会话能追到 8 月）→ 直接求和会把历史全算成"今天"，实测虚高到 **250 万 token/日**；
- `messages.token_count` **全是 NULL**，用不了。

所以宿主自己记增量：`%LOCALAPPDATA%\dsh-pet\user\hermes-usage-ledger.json`。

| 情况 | 表现 |
|---|---|
| 跨天滚动（账本已存在且是往日的） | **精确**：今日 = 当前累计 − 昨日封顶值；首行写「**今日**」 |
| 首次运行（没有昨日基线） | **估算**：用 `session_model_usage.first_seen` 把基线往下推，能捞回当天开的会话；首行写「**今日 ≈**」如实标注 |
| 累计值回退（换库/清库） | 账本只增不减，避免算出负数 |

估算那条是**有意的诚实**：宁可标个「≈」让人知道这数不是精确值，也不装作精确。

---

## 右键菜单

| 项 | 行为 |
|---|---|
| 打开 Hermes 面板 | 先 HTTP 探活：面板在跑就**直接** `shell.openExternal`（实测 **14ms**）；确实没跑才 `hermes dashboard --no-open --skip-build` 起服务、等端口就绪再开浏览器。为什么不照抄官方 CLI 的"起服务 + 开浏览器"见下节 |
| 查看用量与余额 | 立刻弹气泡 |
| 碎碎念 / 对话 | 直连 DeepSeek（key 取自 `C:\Hermes\.env`），1~2 秒回复；人设里带上今日用量与余额，让说的话跟数据有关 |
| 回到初始位置 | 停掉漫游，回到配置的角落 |
| 退出桌宠 | 渲染端 `fetch(BASE + '/ctl/quit')` → 宿主**先关宠物、再退自己**。⚠ 为什么不只关窗口：宿主还活着就成了「宿主在跑、但宠物不在」，下次启动 `cmdStart` 一看 `hostAlive` 就报「宿主已在运行」，桌宠却永远不再出现 —— 用户会以为坏了。一起退掉，下次启动才是干净的。宿主退出时 Electron 侧有管道存亡守卫会自己跟着退（`main.js` 已有该通路），不必重复实现 |

> `deepseek-flash` 是**思考型模型**：`max_tokens` 给小了会被 reasoning 吃光、`content` 返回空串。所以空回复会自动把 max_tokens 加倍重试一次。

---

## 「打开 Hermes 面板」为什么曾经点了没反应、又慢

两个原因叠在一起，少一个都不是那个现象：

**① 开错地址。** 渲染端点菜单时发的是 `new URL(CONFIG.configUrl).origin`（`constants.js:121`），
也就是**宿主自己**的 `http://127.0.0.1:3080` —— 那是配置服务，不是 Hermes 面板。
**现在以宿主注入的 `HERMES_DASHBOARD_URL` 为准**（`host.mjs` 把它连同 `HERMES_EXE` 一起传给 Electron 子进程），
渲染端发来的那个值只作兜底。

**② 每次点击都冷启动一个 Python CLI。** 旧实现是 `spawn(hermes.exe, ['dashboard'])`，
而 hermes CLI 冷启动实测 **7.34 秒**（连 `--status` 这种纯查询都要 7.3s）；可面板平时**本来就在跑**，
HTTP 探活一次只要 **30ms**。所以现在的顺序是：

```
点击 → HTTP 探活（超时 700ms）
        ├─ 活着  → shell.openExternal          ← 实测 14ms，完全不碰 Python
        └─ 没跑  → spawn hermes dashboard --no-open --skip-build
                   → 每 800ms 探一次，最多 60s → 起来了再 openExternal
```

- `--no-open`：让 CLI 别自己开浏览器（detached + 无窗口时它那一次开不一定成），统一由我们用
  Electron 的 `shell.openExternal` 开 —— 这条路径才可靠。
- `--skip-build`：跳过 web UI 构建（非交互上下文里 npm 不一定可用，而且更慢）。
- 旧实现用了 `stdio: 'ignore'`，**把子进程输出全吞了** —— 点了没反应，日志里却一句话都查不到。
  现在 stderr 接进宿主日志（`[dsh-pet-desktop-helper] hermes dashboard: …`），成功路径也留一行带耗时的记录。

> ⚠ **改这条补丁要连着跑一步**：`applyPatches` 的幂等判定只看 marker
> （产物里含 `[hermes 改造:open-site]` 就跳过），所以规则实现改了以后重跑 `patch` / `install`
> **不会更新已打过的产物**。改完要跑 `node tools/sync-open-site-patch.mjs --write`
> 把产物就地升级（它会做边界断言 + 语法校验 + 自动备份）。

---

## 补丁机制

改的是 `%LOCALAPPDATA%\dsh-pet\plugin\runtime\electron-helper\` 下的构建产物：
`shared-core.js` / `sprite.js` / `main.js` / `index.html` / `events.js`，
外加 `assets/config.jsonc`。

**17 条规则，每条幂等**：

- 每条规则有唯一 id，新文本里带标记 `[hermes 改造:<id>]`；
- 有标记 → 跳过（打过了）；无标记但认得出原文 → 替换；认不出 → **告警但继续**（功能退化成原版，不崩）；
- 每个锚点有**两条匹配路径**：① dsh-pet 0.2.12 原生原文（逐字校对过）② 上一版 CC Switch 改过的文本（`lib/legacy-snippets.json`，由 `tools/gen-legacy-snippets.py` 逐字节截取，不手抄）。

| id | 作用 |
|---|---|
| `parse-balance` | 解析宿主下发的余额行 / 余额数值 / 刻度上限 / 口径标签 |
| `balance-percent` | 档位动画改跟**账户余额**走（余额满刻度=没花钱=0%） |
| `bubble-rows` | 气泡内容换成那 5 行 |
| `menu-labels` | 菜单改「打开 Hermes 面板」「查看用量与余额」 |
| `menu-quit` | 工具区末尾加「退出桌宠」（锚点选在没被改过的原生 `tools.push(...)` 上，从原生包重装也能打上） |
| `quit-action` | `onMenuAction` 加 `quit` 分支：`fetch(BASE + '/ctl/quit')` |
| `bubble-wide` | 多行气泡用更宽的框 |
| `open-site` | 菜单项改 `spawn(HERMES_EXE dashboard)` |
| `css-wrap` | 气泡 `nowrap` → 允许换行 |
| `css-width` | 气泡 `max-width` 0.5 → 0.62 |
| `css-iswide` | `≥3 行`时强制宽框 |
| `bubble-flip-clear` | 每帧先清掉翻面标记 |
| `bubble-flip` | **贴屏幕顶边时气泡垂到脚下**（见下） |
| `css-below` | 翻面的定位与箭头方向 |
| `work-status-on` | 打开 `pets[].workStatusEnabled`（原厂默认 false） |
| `work-text-refresh` | 工作状态文案与动画解耦①：**文案每次 tick 都刷新** |
| `work-anim-per-state` | 工作状态文案与动画解耦②：**动画只在档位变化时才切**（见下） |

> ⚠ `work-status-on` 之所以做成补丁而不是手改 `config.jsonc`：`patch --restore` 会把 plugin 目录
> **整份换回原生包**，手改的开关会丢。做成规则之后 `install` / `restore` 之后开关仍然在。

### 为什么要有「翻面」

气泡原设计是「底边钉在宠物头顶上方、往上长」，原版只有一行短文案，顶到屏幕边也无所谓。
我们这版有 5 行（实测 286×183px），而宠物默认停在**屏幕右上角、离顶边只有 100px**（`corner: top-right` + `marginY: 100`）
—— 头顶上方根本放不下，首行会被屏幕裁掉（实测正好切掉 33px，就是一行的高度）。

现在的做法：量完气泡高度后，比较「头顶上方余量」和「脚下余量」，不够就整体翻到脚下（箭头也跟着翻）。

| 宠物位置 | 头顶上方余量 | 表现 |
|---|---|---|
| 贴屏幕顶边（默认角落） | 100px < 需要 225px | **垂在脚下** |
| 屏幕中部 / 下半 | ≥ 225px | 正常在头顶上方 |

两个分支都实测过：气泡完整落在工作区内、且完整落在宠物窗口内。

### 为什么动画不能每个 tick 都切

原实现每来一个 workTick 就 `stopMove()` + 重新挑动画。而宿主是**每个事件**都推进 `ts` 的
——一次真实的工具循环里 `tool_call → tool_result → tool_call …` 大约 2~4 秒一个事件。

档位动画实测 **10.04 秒**（出错档 4.92 秒，`node tools/probe-webm-duration.mjs <webm目录> 工作状态` 可复现；
注意 Matroska 的 Duration 单位是 TimecodeScale，不除会读成 10042 秒）。

⇒ 每 3 秒从头重播一次，永远只播到前 30%，观感是「卡住抖动」而不是「在忙碌」。

所以拆成两件事：**动画跟 `state`（档位）走，文案跟 `ts` 走**。
实测（`node tools/probe-anim-switch.mjs`）：同一档位里连换 3 个任务，前台动画始终是同一段、
`currentTime` 从 0.65 单调涨到 9.73 未被重置；换档位时才切到新动画并归零。

### `patch --restore` 为什么要先停宿主

还原是「整份复制原生包 → `rename` 替换 plugin 目录」。宿主/桌宠正在运行时占着其中的文件，Windows 会直接 **EPERM** 拒绝 rename。
`install` 里已经先 `stop` 再还原，顺序是对的；手工单独跑 `--restore` 时注意这一点。

---

## 工作状态：这一轮在干什么（L0 + L1）

桌宠除了报余额，还会报**Hermes 正在干什么**。契约来自 dsh-pet 原生的 `workStatusEnabled`
（宿主实现 `GET <PREFIX>/work-status`，容器 1s 轮询，超时 10s）：

```
{ state: "thinking"|"working"|"result"|"waiting"|"success"|"error"|null,
  task:  "在写 run-dsh-pet-install.cmd",   // 可选；有值就盖掉那 6 组配置文案
  ts:    1790351355468 }
```

`state` 决定放哪一段动画（档位索引 0~5），`task` 是**这一轮的具体动作**。
`task` 是我们加的叙事层：原版只会说「正在处理任务呢」，现在能说「在写 xxx.md」。

### `task` 是怎么"说"出来的

判据全部来自 `C:\Hermes\state.db`（只读），**每条都用 `tools/probe-work-signals.mjs` 实测过，不靠猜**：

| 看哪里 | 得出 |
|---|---|
| 最新一条 assistant 消息的 `tool_calls[].function.name` + `.arguments` | **在写/在改/在读/在跑/在看图…+ 具体文件名**（含 22 个工具的动词表） |
| 最新一条是 `role=tool` | `刚跑完 write_file` |
| `role=tool` 且 `exit_code != 0` | `terminal 出错了`（**`error` 字段成功时也是 null，只看它必漏报**） |
| 最新一条是 `role=user` | `在想怎么回：<会话标题>` |
| 最新一条 assistant 带 `finish_reason=stop` | `这一轮搞定了` |
| `tool_calls` 里有 `clarify` | `在等你回话：<问题>` ← waiting 唯一的硬信号 |
| `sessions.ended_at` 有值 | `这一轮搞定了` / cron 的 `定时任务跑完一轮` |
| `sessions.last_activity_description` | 仅在它比消息更新时采用（**只有 cli 会话填：实测 cli 6/16、cron 0/43、desktop 0/1、feishu 0/8**，所以只当覆盖信号） |

几个查库时踩到、写进代码注释的硬事实：

- 时间戳是 **REAL 纪元秒**（`1790343362.275403`），不是 ISO 字符串 —— 按字符串比大小会全错；
- `sessions.end_reason` 实测取值域只有 `cron_complete` / `cli_close` / `agent_close` / `null`，
  **没有 error 变体** —— 所以没写 end_reason 的错误匹配（那是死代码）；
- 叙事参数取键是**从库里全量导出的真实键**里挑的：同一语义在不同工具上键名不同
  （`patch` 用 `path`、`edit` 用 `file_path`），写死一个必漏。

### `ts` 是「事件戳」，不是「当前时间」

客户端只有 `ts` 变了才 `workTick++`，而每次 tick 都会重算文案。
所以 `ts` 取 `Date.now()` 会让宠物**每秒重启动画**。这里的做法是：`ts` 只在 **`state` 或 `task` 变了**
的时候才前进（内部用 `state|task` 做门），既保住「文案一变就刷新」，又不让轮询本身制造事件。

### 时效窗口

| 档位 | 证据保鲜上限 | 说明 |
|---|---|---|
| thinking / working / result | 3 分钟 | 超时 = 最近没在动 |
| waiting | 30 分钟 | 等人回话可以等很久，但不无限等 |
| success | 3 分钟 | |
| error | 5 分钟 | |

任一档位证据超过上限 → 回 `state: null`（收起气泡回待机）。**不留僵尸气泡。**

### 已知的小脾气

- 宠物刚启动时，容器**首拉只记基线、不重放历史状态**（上游设计）。所以启动那一刻如果
  正好停在某个状态上，要等**下一次状态/文案变化**才会显示。实际用起来几十秒内会自愈
  （agent 干活时事件很密）。
- `task` 会截到 34 字（`窗口` 实测最长那条 30 字 = 231×71px 两行，装得下）。
  路径只显示**末两段**（`RAG/_captions.json`，放不下就只要文件名）—— 整条路径的头部谁都知道，
  把它截掉等于没说文件名。

---

## 目录与文件

| 位置 | 内容 |
|---|---|
| `本包源码目录` | 源码（本包） |
| `%LOCALAPPDATA%\dsh-pet\app` | **运行副本**：install 时从源码同步过来（npx 临时目录没了也能跑） |
| `%LOCALAPPDATA%\dsh-pet\plugin` | dsh-pet 构建产物（被补丁改的对象） |
| `%LOCALAPPDATA%\dsh-pet\electron` | Electron 二进制 |
| `%LOCALAPPDATA%\dsh-pet\user` | `main-config.json`、`memory.json`、`hermes-usage-ledger.json` |
| `%LOCALAPPDATA%\dsh-pet\logs\host.log` | 宿主日志（排障看这个） |
| `启动\Startup\dsh-pet-hermes.vbs` | 开机自启（内容纯 ASCII —— wscript 按 ANSI 读 .vbs） |

---

## 自验工具

```bash
# ① 判据逻辑对不对？拿库里的**真实历史行**回放（28 条断言）+ 叙事预览
node tools/test-work-state.mjs                 # 全量断言（含清单完整性、ts 门控）
node tools/test-work-state.mjs --selftest      # 附带哨兵自验：故意注入错误期望，确认测试会报红
node tools/test-work-state.mjs --preview 30    # 把最近 30 条真实动作的文案打出来看一眼

# ② 整条线通不通？造一条可控时间线驱动 6 档，用 HTTP 断言宿主说了什么
#    （schema 抄真库 DDL、种子行克隆真库真实行；被测的是真管线）
node tools/drive-work-states.mjs --build
HERMES_STATE_DB="$TEMP/hermes-drive/state.db" node lib/host.mjs   # 宿主指向假库
node tools/drive-work-states.mjs --run                            # 10 条断言
node tools/drive-work-states.mjs --hold waiting                   # 只写一个场景停住，便于外部观测

# ③ 动画到底重不重播？直接读渲染进程的 currentTime / 前台 video src
PET_ELECTRON_ARGS='--in-process-gpu --remote-debugging-port=9333' HERMES_STATE_DB=... node lib/host.mjs
node tools/probe-anim-switch.mjs

# ④ 气泡被裁了吗 / 文案装得下吗（量屏幕矩形 vs 工作区，附带 --facts 与截图）
node tools/shot-pet.mjs out.png --facts
node tools/probe-bubble-visible.mjs

# ⑤ 档位动画多长？（解 EBML 读 Duration，注意要除 TimecodeScale）
node tools/probe-webm-duration.mjs "%LOCALAPPDATA%\dsh-pet\plugin\assets\webm" 工作状态

# ⑥ 库里到底有哪些字段/工具参数键（写 SQL 前先问库，不问记忆）
node tools/probe-work-signals.mjs

# ⑦ 菜单「打开 Hermes 面板」修好了吗？执行**产物里**那段代码
#    （按 marker 从 main.js 抽出来喂给 vm —— 验的是你机器上跑的那份，不是副本）
node tools/verify-open-site.cjs               # 纯 node：shell 打桩，验决策/地址/耗时
HERMES_DASHBOARD_URL=http://127.0.0.1:9129 node tools/verify-open-site.cjs   # 哨兵：不可达时应当报红
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS <electron.exe> tools/verify-open-site.cjs  # 真开浏览器（沙箱外）

# ⑧ 整条链路在真 Electron 里通不通（渲染 → preload → IPC → 主进程 → openExternal)
PET_ELECTRON_ARGS='--no-sandbox --remote-debugging-port=9333' node lib/host.mjs
node tools/cdp-open-panel.mjs                 # 故意发宿主的 3080 进去，看它纠正成 9119

# ⑨ 产物里的补丁与源码一致吗 / 就地升级（幂等只看 marker，改了实现重跑 patch 换不掉）
node tools/sync-open-site-patch.mjs --check
node tools/sync-open-site-patch.mjs --write
```

`tools/shots/` 下是实测截下的气泡样子（`waiting` 那条是最长文案，30 字两行）。

两个已经踩过的坑写在脚本头部（都很隐蔽，值得读一眼）：

1. **`window.screenX/screenY` 返回的是物理像素**，而 `getBoundingClientRect` / `VIEW` 是 CSS px（本机差 2 倍）。直接相加会算出「横向出屏」这种**假故障**。换算：`screenCss = window.screenX / devicePixelRatio`。
2. **别用 CDP 合成鼠标事件拖这只宠物**：窗口是跟着宠物走的，合成指针的屏幕坐标会随窗口一起漂移，而渲染端按 `e.screenX` 的绝对偏移定位 → 退化成自反馈回路（实测注入 420px 只移动了 148px，还把宠物带偏）。要测"宠物在不同高度下气泡翻不翻"，改配置再重启，不要拖。
3. **造测试库时 FTS5 虚拟表及其触发器不要抄**：shadow 表会「已存在」，触发器又反过来引用 FTS 表；而 `workState()` 只读 `sessions`/`messages`。另外外键是开着的（`PRAGMA foreign_keys=1`），克隆会话行时要照顾 `system_prompt_hash → system_prompts.hash`、`parent_session_id → sessions.id`。
4. **Matroska 的 `Duration` 单位是 TimecodeScale（默认 1ms）**，不除会把 10 秒读成 10042 秒。

---

## 环境相关（换台机器可能会不一样）

| 现象 | 原因 | 处理 |
|---|---|---|
| 桌宠窗口起来就崩，`GPU process isn't usable` | 这台机器上 Chromium 的 GPU 进程起不来（**裸 Electron 同样崩**，与移植无关）。在 IDE / 沙箱里起宿主时**必现** —— 受限上下文起不了 GPU 子进程（`0xC0000005`） | 宿主内置参数阶梯 `[] → --in-process-gpu → --no-sandbox`，连崩 2 次自动降级（实测约 7 秒后自动救活，日志会写「换参数重试」）。可用 `PET_ELECTRON_ARGS` 覆盖成固定参数 —— ⚠ 但那是**单级**的：设了就**不再降级**，所以在受限上下文里要把救活参数一起写上（如 `--no-sandbox --remote-debugging-port=9333`） |
| 自验脚本想跑在真 Electron 里（`shell.openExternal` 之类） | 同上：沙箱里起 Electron 必崩，换 `--disable-gpu` / `--in-process-gpu` 都救不了；另外还会被继承的 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` 干扰 | 别硬刚。`tools/verify-open-site.cjs` 默认走**纯 node 模式**（shell 打桩），决策/地址/耗时一样验得出来；要验"最后一跳真开浏览器"就在沙箱外跑，记得 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` |
| 调试端口连上却发现是别人的浏览器 | 9222 常被 Chrome 占用 | 先 `netstat` 挑空闲端口，别硬用 9222 |
| agent/沙箱里跑 `start`，命令一结束宿主就没了 | 沙箱会连坐回收"跑完即结束"的任务所派生的子进程 | 正常在命令行/控制台跑不受影响；沙箱里要让宿主长驻，得把它本身当长驻任务跑 |
| 自启项里的 node 路径 | 写的是**系统 node**（`C:\Program Files\nodejs\node.exe`），不是跑 install 时那个临时/托管 node | 特意这么做：写 `process.execPath` 的话，那个副本一被升级/清理，开机自启就**静默失效**（桌面什么都没有，也不报错） |

---

## 与 CC Switch 版的差异

> 对比对象是 [dsh-pet-ccswitch](https://github.com/cloud666666666/dsh-pet-ccswitch)（作者 Joker.Yun）——
> 本包的宿主骨架就是来自它。下面是换绑到 Hermes 之后改掉的东西。

| | CC Switch 版 | 本版 |
|---|---|---|
| 跟随对象 | DSH Web 服务 | Hermes 网关服务 |
| 数据源 | DSH 的用量接口 | Hermes `state.db` + `.env` + DeepSeek `/user/balance` |
| 气泡 | 余额单行 | 5 行（今日/服务/余额/累计/请求数·花费） |
| 工作状态 | 未实现（`/work-status` 返空壳） | 6 档 + **`task` 说出「在写 xxx.md」** |
| 菜单「打开网站」 | DSH 网站 | Hermes 本地面板（`hermes dashboard`） |
| 今日口径 | — | 账本增量（跨天精确）+ 首日估算（标注 ≈） |

---

## 出处与致谢

这只桌宠本身不是我写的，本包做的是「换绑」—— 让它跟着 Hermes 过日子。三层署名：

| 层 | 作者 | 本包用了它什么 |
|---|---|---|
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | Gavin Wang (ooboqoo) | 桌宠本体、美术素材与动画。本包只在它的**构建产物上打补丁**，不修改、不重新分发其源码，也未内嵌其任何素材 |
| [dsh-pet-ccswitch](https://github.com/cloud666666666/dsh-pet-ccswitch) | Joker.Yun | 本包 `host.mjs` / `patch.mjs` / `cli.mjs` / `paths.mjs` 骨架的来源（逐文件比对重合度约 70%~90%） |
| dsh-pet-hermes（本包） | LindaCasablanca | Hermes 数据层、工作状态叙事（L0 + L1）、12 个自验工具组成的三层验证链 |

三部分均以 MIT 发布，完整声明见 [`LICENSE`](LICENSE)。

License: MIT
