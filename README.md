# dsh-pet-hermes

把 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 桌宠**换绑到本地 Hermes 服务**。

Hermes 网关服务在跑，桌宠就出现；服务一停，它自己消失。头顶气泡显示用量与余额，
右键能打开 Hermes 面板、让它碎碎念、跟它聊天。

> 同系列的另一件作品：[dsh-pet-ccswitch](https://github.com/cloud666666666/dsh-pet-ccswitch)（作者 Joker.Yun）
> —— 把同一只桌宠绑到 CC Switch。本包的宿主骨架来自它，跟随对象与数据源换成了 Hermes。

---

## 效果预览

**用量气泡** —— 右键「查看用量与余额」随时叫出来

<img src="assets/preview-usage.png" width="290" alt="用量气泡">

**工作状态** —— 不再只说"在干活"，而是说出「刚跑完 `write_file`」

<img src="assets/preview-work-tool.png" width="380" alt="工作状态">

**器灵应节** —— 到了那天它自己知道（2026 重阳，九月初九）

<img src="assets/preview-festival.png" width="380" alt="器灵应节">

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **跟随服务起落** | 盯着 Hermes 网关服务（`gateway run`）的生命周期：服务在跑就出现，停了就消失 |
| **5 行用量气泡** | 今日 token 增量 / 服务状态 / DeepSeek 余额 / 累计用量 / 今日请求数与花费 |
| **工作状态叙事** | 6 档状态 + 一句话说清这一轮在干什么（从"在干活"升级到"在写 xxx.md"） |
| **器灵应节** | 21 个节令动画按**真实日历**播放：春节、清明、端午、中秋、重阳、冬至、腊八…到那天它自己知道 |
| **认主** | 记住你哪天第一次启动它，整百天与每年纪念日会说一句话 |
| **右键菜单** | 打开 Hermes 面板 · 查看用量与余额 · 碎碎念 · 对话 · 回到初始位置 · 重载配置 · 退出桌宠（另有动作 / 动画点播） |
| **碎碎念 · 对话** | 直连 DeepSeek，**只在你点菜单时才调用** —— 不点不花钱 |
| **数据只读** | 全部取自 Hermes 自己的文件与接口，不改它一个字节 |

### 器灵应节

dsh-pet 的素材里本来就有 21 个节令动画（16 个中国传统），但原版**没有任何日期逻辑**，
是一年 365 天随机播的。本包补上了那块日历：**农历**走 Node 内置 ICU（零数据表、零依赖，闰月也分得开）、
**节气**走通用公式、**除夕**单独判（腊月廿九还是三十逐年不同）；19 个有固定日期的动画
**已从随机池摘出**，只留没有固定日期的雪人/落叶。

**认主**：第一次启动那天记进 `user/pet-bond.json`，之后第 100 天、每年那一天会说一句话
（一周年是第 **366** 天 —— 认主当天算第 1 天）。

不想看就关掉：设 `PET_FESTIVALS=0`。节日和话术在 `lib/festivals.mjs` 里，一眼能改。

---

## 安装

**前提**：Windows · Node ≥ 22.5 · Hermes 装在 `C:\Hermes`（或设 `HERMES_HOME`）

```bash
npx github:LindaCasablanca/pet install
```

`install` 一次做完：还原 dsh-pet 原生包 → 打补丁 → 备好 Electron → 同步到运行目录
→ 注册开机自启 → 启动。首次会下载 dsh-pet 插件（约 65MB）与 Electron（约 100MB）。

> 本包**尚未发布到 npm registry**，所以要用 `npx github:` 的写法；发布后可直接 `npx dsh-pet-hermes`。

| 命令 | 作用 |
|---|---|
| `install` | 一次性准备并启动 |
| `start` / `stop` / `restart` | 启停宿主（宿主会带着桌宠一起）。`start --with-hermes` 顺手把 Hermes 也拉起来 |
| `status` / `doctor` | 自检：Hermes 在哪、库能不能读、补丁齐不齐、缺什么 |
| `patch` | 升级 dsh-pet 后重新打补丁（`--restore` 先从原生包整份还原） |
| `uninstall` | 移除开机自启（`--purge` 连运行数据一起删，会先备份配置） |

装之前想知道"补丁打不打得上去"，跑 `node tools/check-patch.mjs --apply`（只读，不碰安装目录）。

---

## 关于凭证

**本包不含任何 API key，也不往任何地方写 key** —— 代码里只有「读」，没有硬编码兜底。

要让桌宠能查余额、能碎碎念，你自己准备一个 DeepSeek key：

| 加法 | 怎么做 |
|---|---|
| 设环境变量（优先） | 给运行桌宠的进程设 `DEEPSEEK_API_KEY=sk-...` |
| 写进 Hermes 的 `.env` | 在 Hermes 安装目录的 `.env` 里加一行 `DEEPSEEK_API_KEY=sk-...` |

包就从这两处读（Hermes 安装目录按 `HERMES_HOME` → `C:\Hermes` → `~\.hermes` 顺序找）。
读到的 key 只做两件事：查余额、调碎碎念/对话 —— 所以**谁用谁自己的 key，花的是谁的钱**。

没配 key 也能用：桌宠本体、工作状态、右键菜单都照常，只有「查看用量与余额」和「碎碎念/对话」不可用。
跑 `doctor` 能看到读没读到（**只报长度，不回显**）。

---

## 升级与适配

- **升级本包**：重跑一遍 `install`。
- **升级 dsh-pet**：改 `package.json` 里 `dsh-pet` 的版本再 `install`。注意
  **0.x 的 `^` 只放行同一 minor**（`^0.2.11` 装不到 `0.3.x`，必须显式写 `^0.3.6`）。

> **当前适配：dsh-pet 0.3.6** —— 18 条补丁规则照这个版本的产物逐字校对过，实测 **18/18 命中**。

0.3.x 相比 0.2.x 有几处破坏性改动（余额模型改成白名单构造、字段语义变更等）。
升级前建议先备份 `user/` —— 认主记录、气泡配置与对话记忆都在里面。

---

## 往哪升级

终极形态是 **「桌宠独立版 + Provider 接口」**：

```text
桌宠  ←  宿主（只认接口，不认具体服务）  ←  Provider 接口  ←  hermes / ccswitch / ...
```

桌宠和宿主都不认具体服务，Hermes 退化成 Provider 的一个实现 —— **换服务 = 换一个文件**。
接口草案（6 个方法 + 路由清单）已经写好，**当前这一版仍是直连 Hermes 的实现，改造还没开始**。

---

## 出处与致谢

这只桌宠本身不是我写的，本包做的是「换绑」。三层署名：

| 层 | 作者 | 本包用了它什么 |
|---|---|---|
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | Gavin Wang (ooboqoo) | 桌宠本体、美术素材与动画。本包只在它的**构建产物上打补丁**，不修改、不重新分发其源码，也未内嵌其素材 |
| [dsh-pet-ccswitch](https://github.com/cloud666666666/dsh-pet-ccswitch) | Joker.Yun | 本包 `host.mjs` / `patch.mjs` / `cli.mjs` / `paths.mjs` 骨架的来源 |
| dsh-pet-hermes（本包） | LindaCasablanca | Hermes 数据层、工作状态叙事、器灵应节、自验工具链 |

三部分均以 MIT 发布，完整声明见 [`LICENSE`](LICENSE)。

License: MIT
