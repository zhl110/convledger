<div align="center">

<img src="tool/web/icon.svg" width="88" alt="convledger">

# convledger

### 把 Agent 的聊天记录，变成一本**查得到、回得去、接得上**的账

零 Node 运行时依赖 · 只用 Node 内置模块 · 三维路线页内置 Three.js（本地 vendor） · 全程只读宿主日志 · 数据只在你本机

**制作人：再来一杯海星酒** · GitHub [@zhl110](https://github.com/zhl110) · 仓库 [zhl110/convledger](https://github.com/zhl110/convledger)

[![zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-4fd6a7)](#为什么它不糊弄你)
[![node](https://img.shields.io/badge/Node-%E2%89%A520-5aa9ff)](#五分钟跑起来)
[![release](https://img.shields.io/badge/release-v0.1.0-b98cff)](https://github.com/zhl110/convledger/releases)
[![served locally](https://img.shields.io/badge/served%20on-127.0.0.1%3A8765-f2b45a)](#页面长这样)

![一张画布上的三十程：章带、阶段括号、每块一句题名](docs/img/canvas-far.png)

<sub>画布全图（远景）。这张图跑的是**合成演示账本**——界面是真的，数据是编的。</sub>

</div>

---

## 你是不是也踩过这三件事

| 没有它 | 有它 |
| --- | --- |
| 上下文一压缩，前面几十程被尾部截掉，新会话里 agent 只会说「我们之前做了什么」——说得像，但对不上 | 压缩边界自动注入**章层**：一开始的目的、走到哪、碰过的壁、怎么接手，一次给全，且每格都能回源核对 |
| 想查「那次改存储的结论是什么」，只能翻聊天记录，或者让模型重读整段会话（实测 226 段全读约 560 万 token） | `convledger body S07` 按锚点现读那一段；一次恢复记忆的第一跳 `brief` 只要 **1,200 token 左右** |
| 界面越做越多，进度只存在某个人的记忆里，别人接手要先问一遍 | 一个 hub 固定 `http://127.0.0.1:8765`：应用看板、会话库、每段会话的画布、项目工作台与架构页都在里面，任务状态有验收闸门 |

## 页面长这样

<table>
<tr>
<td width="50%"><img width="100%" src="docs/img/canvas-mid.png" alt="画布中景：每块一句题名与依据"></td>
<td width="50%"><img width="100%" src="docs/img/library.png" alt="会话库：一个 hub 服务所有会话"></td>
</tr>
<tr>
<td><b>中景</b>——滚轮缩放换的是<b>一套描述</b>，不是字号：近景全明细、中景一行干什么、远景只剩步号。每张卡都写着「模型综述 · 依据 Sxx」。</td>
<td><b>会话库</b>——一个 hub 服务本机所有会话，绿点＝15 分钟内写过，行尾色标直接告诉你这段整理过没有。</td>
</tr>
<tr>
<td><img width="100%" src="docs/img/progress.png" alt="项目工作台：四档缩放与依赖箭头"></td>
<td><img width="100%" src="docs/img/architecture.png" alt="架构页：运行链路、模块图与运行时路线"></td>
</tr>
<tr>
<td><b>项目工作台</b>——按工作目录归项目，四档查看阶段与任务、依赖箭头、验收证据；顶部还有**经验（按阶段收拢）与用户画像**，每 5 秒随账本刷新。这张就是<b>本仓自己的任务表</b>。</td>
<td><b>架构页</b>——运行链路、八层模块图与 Three.js 三维运行时路线，可点、可搜、可旋转；工具把自己的运行时摊开给人看。</td>
</tr>
</table>

## 一条对话是怎么变成账本的

<img src="docs/img/layers.svg" width="100%" alt="段 → 块 → 步 → 阶段 → 章 五层，正文留在源文件里按锚点回读">

| 层 | 是什么 | 谁写的 |
| --- | --- | --- |
| **段** | 压缩边界切出的区间，锚点＝源文件行区间 | 规则 |
| **块** | 一次真人提问管的那几段 | 规则 |
| **步** | 只有含主线块的步才编号，插曲另起一行 | 规则 |
| **阶段** | 连续几步算一程，配六格说明 | 模型写 · 工具验 |
| **章** | 几十程并成「一大块」，九格接手页 | 模型写 · 工具验 |

**正文一个字都不搬进账本。** 段、块、步、阶段、章都只是索引；要读原文就 `body S07`，锚点解引用回源 JSONL。源日志被宿主清掉了，会回落到画布服务过的那份逐字归档，并明确声明「读自归档，不是新的真相」。

## 五分钟跑起来

```bash
# 1) 装 Node ≥20（接 OpenCode 要 22.5，低于它只是那一家来源跳过）
# 2) 克隆仓库
git clone https://github.com/zhl110/convledger.git
cd convledger
# 已配 SSH 的也可以用：git clone git@github.com:zhl110/convledger.git

# 3) 装起来（按 Agent 选装，不再一键把所有检测到的全装上）
#    Windows：双击 install.cmd → 列出现有 Agent，问你装哪个；
#             或双击对应的 install-<agent>.cmd（如 install-qoder.cmd）只装那一家
#    Linux/macOS：跑下面这条（会问你装哪个），或 setup --client <agent>
node tool/bin/convledger.mjs setup --choose
```

`setup` **按 Agent 装**：先问装哪一家（`--choose`），只装你选的那家的 Skill 与 hooks，其余不碰；每家有独立脚本 `install-<agent>.cmd`；要一次装全部才用 `--client all`。装的样子：体检 Node、账本目录与 8765 端口 → 找本机装了哪几家宿主（**只数这台机器上真有源的**）→ 按选中那家装 Skill 与 hooks → **只建「你此刻正在用的这一段」的账，历史一段都不建**（打开哪段建哪段；要历史加 `--build N` 或 `--all`）→ 建桌面与开始菜单快捷方式。**默认不起常驻服务**（装完不占后台内存，不让人一装就卡）：双击桌面「convledger 地图」或跑 `convledger map` 才起；想装完就起加 `--hub`。结尾固定四行「下一步」，包括**还缺什么**（没建账的个数、没接的来源），不写「一切就绪」。

**全局暂停**：App 界面顶栏有「全局暂停」按钮——点一下写 `tool/out/HUB-PAUSED`、停掉常驻 hub 释放内存；之后 `setup`/`upgrade`/宿主事件都不会自动再起。恢复：双击桌面图标或 `convledger map`（会先删标记再起）。即使 hub 在跑，没有活动会话时也不会后台建账（`autoBuild` 默认关，综述只在会话收尾/压缩时由 agent 补）。

装完想先看看它长什么样，不用拿自己的会话试：

```bash
node tool/bin/convledger.mjs sessions --all      # 本机有哪些会话、建账了没有
node tool/bin/convledger.mjs map                 # 起 hub，打印本会话画布地址
node tool/bin/convledger.mjs outstanding         # 链路欠项自检
node tool/hooks/install.mjs --client all         # 单独重挂压缩边界注入（Qoder / WorkBuddy / OpenCode）
```

关掉窗口不会停 hub。要回来：双击桌面或开始菜单里的「convledger 地图」，或跑 `convledger app`——打开的是 Edge/Chrome 的 `--app` 应用窗口（无地址栏、无标签页、不加载扩展，落在 `/app` 本机看板：五家 agent 的接入状态与一键连接、最近会话、经验与记忆；重复点只会聚焦同一扇窗，没有 Chromium 浏览器才退回默认浏览器）。看板只认带 token 的桌面应用窗，直接开 `http://127.0.0.1:8765/` 会 403；需要地址时跑 `convledger url --copy`。

### 桌面窗口：Edge/Chrome 应用窗

桌面入口和 `convledger app` 用 Edge/Chrome 的 `--app` 打开 `/app`：没有地址栏和标签页，也不加载浏览器扩展；并发/重复点击由 `out/app-launch.lock` 原子锁串行，只开一扇并聚焦已有窗口。窗口、任务栏分组与 Alt-Tab 归浏览器进程。窗口图标由 hub 的 `/favicon.ico`、`/convledger.ico` 与 `/manifest.webmanifest` 提供，这些静态资源免 token，避免任务栏回退成浏览器默认 logo。应用启动后，Windows 通知区域（任务栏右下角）常驻一个 ConvLedger 小图标；关掉主窗后仍留在这里。左键打开，右键有「打开 / 重启 / 退出」。Windows 首次可能把它收进 `^` 溢出区，拖到任务栏一次即可固定。

**不使用 Electron 壳**：2026-11-14 用户明确否决（有 bug），因此仓库不再有 `tool/app/`、`electronApp()` 或 Electron 依赖，运行时依赖仍为零。Edge 首次启动专用 profile 时会往桌面生成名为 **Microsoft Edge** 的快捷方式（目标带 `--source-shortcut-location=desktop`）；应用窗启动参数已加 `--no-first-run` 与 `--no-default-browser-check`，真机复现验证不再生成。若机器上还有历史遗留的 Edge 快捷方式，可以直接删；安装器只写「convledger 地图」这一个快捷方式（目标 `wscript.exe … open-app.vbs`，图标 `convledger.ico`）。以后若要独立进程或独立任务栏身份，先提原生壳或 PWA 方案并获批，不擅自恢复 Electron。

在 Agent 里让它自己开页面：`map` / `setup` 别加 `--open`（那只开系统浏览器），拿到打印的地址后由 agent 用宿主的浏览器面板打开。

看板「本机 agent」每张卡片里直接调两件事：**收尾**（把本会话新记录并入项目任务，按真人回合：每轮 / 每 5 轮 / 压缩时）与**补账**（补缺综述的块，按缺块数：每轮 / 缺 5 块 / 压缩时）。地图顶栏和模型配置页都不再放这些开关。所有 Agent 默认跟机器级，不再给 WorkBuddy 写死「压缩时」；需要时自己在 WorkBuddy 卡片里选。

项目工作台顶部的**「经验 · 按阶段」**把块综述里的 lesson 按会话与阶段收拢，**「用户画像 · 做事方式」**读两张记忆表的条目，0 条就如实写 0 条。用户画像全局一份；brief 会先保底验收/边界/反馈，再按「条目场景标签优先 + 旧条目维度兜底 + 关键词补位」挑相关条目注入，不整表塞入。场景标签覆盖活动/阶段、产物/领域、互动/习惯、环境四轴，条目没标签时退回维度匹配。`convledger export` 会把经验写进 `PROGRESS.md`，并在 `out/exports/projects/<项目名>--<项目键>/sessions/<会话>-notes.md` 生成可直接拿走的会话笔记（章、阶段、经验、回读命令）。

## 给 Agent 用的时候

新上下文进来，第一跳不用人提醒就有东西读——压缩边界由 hooks 注入这一层：

```text
[convledger · 工具派生，不是模型记忆] 会话启动自动续上：
账本 demo0001 · 596 段 / 253 块 / 179 步 · 阶段 35 段覆盖第 1–176 步 · 章 6 段覆盖第 1–176 步
章 6 · 第 168–176 步 · 块 240–250 · 读得出也装得上
  目的：把前面每一层交给人读、交给新机器装：读的一方不点也能看懂一大块，装的一方一条命令就用得上。
查法：handoff（接手一页）· brief --chapter n（九格）· steps（全块）· body Sxx（逐字原文）
```

一整块（章）的接手页长这样——`convledger handoff` 的真实输出，数据取自上面那张演示账本：

```text
章 2 · 第 16–30 步 · 块 16–30 · 阶段 4–6 · 搜得出也带得走
basis=model（归纳，不过六条判据） · 写于 2026-11-03 03:30
一开始的目的：让五千条笔记既搜得快、筛得准，又能整库导出与备份，最后打成别人双击就能用的包
走到哪：倒排索引与增量更新接上，组合筛选与高亮可用，导出备份恢复定时四条路跑通，免安装包在干净目录走过一遍
核心规则与原则：两处要显示同一件事就共用一份函数；性能要有基线才谈回归；首跑要在隔离环境从头走
碰过的壁：慢响应会盖住新结果，需按序号丢弃；安装路径含空格与中文时启动脚本没加引号直接起不来
怎么接手：这一章的产物都在文档与打包脚本下，接手先读上手指南，再从块表找对应块回读原文
```

块表是给人和 agent 共用的同一份编号——`convledger steps` 一次调用拿到全部块，每行自带回读命令：

```text
块 30 · 主线步 30 · 插曲支 0 条 · 已证增量 0/30 段（其余块只有结构，没有过判据的话可说）
  6   步6 主线     S06         第 6 句     支1 写2 | 换存储｜JSON 文件改数据库 ⇒ 写入不再整档重写，崩溃不留半截文件 | convledger body S06
  7   步7 主线     S07         第 7 句     支1 写1 | 迁数据｜迁老数据｜逐条核对条数 ⇒ 迁移可重放，核对报告可复查 | convledger body S07
```

## 为什么它不糊弄你

- **工具一次模型都不调。** 综述、阶段、章、记忆都是「模型写、工具验」的外挂表，写入口各有闸门：块综述四道、阶段八类、认识增量六条反编造判据、记忆 G0–G9。闸门不过就整批不写，**不改判据迁就文字**。
- **锚点带 hash，账本一变旧说明自动失效**，回落成结构事实，绝不把旧的概括挂到新的内容上。
- **模型写的一律标注**：页面上写着「模型综述／模型说明（归纳，不过六条判据）」，`basis=model` 永远不等于 `verified`。
- **标题不许截原话**：卡片题名优先用综述；没有综述只许写「写 xx 等 n 件」这类派生标题并标注，不拿半句用户原话顶替。
- **派生数据可整目录重建**，对源日志全程只读；`tool/out/` 删掉，账本从源文件重新长出来。
- **hook 是只读推送层**：拿不到账本就一个字都不注（fail-open），也不许在 hook 里现写阶段或综述——那等于绕过闸门往上下文里塞话。

## 命令一览

`[--session 会话前8位] [--store 账本根]` 所有命令通用。下面是最常用的那几条，全部命令见 `convledger help`。

| 想做的事 | 命令 |
| --- | --- |
| 新设备按 Agent 选装 / 撤干净 | `install-<agent>.cmd` · `setup --choose` · `setup --client <id\|all>` · `setup --uninstall` · `setup --check` |
| 知道自己在哪 | `brief` · `brief --chapter n` · `handoff` |
| 逐程检索 | `steps` · `show` · `card S07` · `body S07-S11` |
| 写外挂表（模型写、工具验） | `digest --block N` → `summarise --put` · `phases --put` · `chapters --put` · `claim` |
| 给工具接一个模型（全面接管补账） | 打开 App 左栏「设置」填 API Key 即可；命令行等价：`llm --key <key>`（只给 key，自己认端点与模型）· `llm --bridge`（读本机 OW Bridge）· `llm --key <k> --base-url <url>`（任意 OpenAI 兼容网关）· `llm --test`。接上后 `closeout --auto` 接管块综述/收尾任务/题名/阶段/记忆/画像，hook 不再向当前 Agent 派活 |
| 链路自检与经验出口 | `outstanding` · `lessons` · `rules` · `requests --pending` |
| 跨会话记忆与交接 | `memory` · `memory --digest` · `export` · `export --check` |
| 看 token 消耗 | `usage` · `usage --json`（App 壳「用量」页同源） |
| 代码更新后同步工具 | `upgrade` · `upgrade --check`（Skill 副本／常驻 hub／版本水位）；`git pull` 后自动跑一次，触发器由 `convledger on` 装进本机 git hooks。**纯版本升级（无本地源码改动）只做 `upgrade --check` + hub `/health` 两项**；全量自测只在改过 `tool/src` 或 `tool/test` 时跑 |
| 项目任务闭环 | `progress --project <键>` · `sync --prepare` → `sync --put` |
| 把页面拉起来 | `app` · `map` · `url --copy` · `map --stop` |

## 系统与运行时支持

以 2026-11-14 本机核对为准。**平台门槛、常驻方式或桌面窗口有变化时，改这一节，并在同一次提交里重跑对应平台的测试。** 不拿旧平台的结论套新版本。

| 层面 | 现状 | 未覆盖 / 注意 |
| --- | --- | --- |
| 运行时 | Node ≥20；当前 24.15；运行时零 npm 依赖 | OpenCode 来源需要 Node ≥22.5（`node:sqlite`）；Node 20 会跳过它，其它四家不受影响 |
| Windows | 已验证：全量自测（以最近一次输出为准；本机缺校准会话时会有 3 项既有夹具失败）；桌面与开始菜单快捷方式、ICO、PowerShell 进程识别、端口占用回退 | 「干净机器双击 `install.cmd`」只在隔离用户目录里走过装与撤，没在真桌面点过；无代码签名 |
| Linux / WSL | 部分验证：安装器写 `~/.local/share/applications/convledger.desktop`，剪贴板走 `xclip`、打开走 `xdg-open`；WSL Ubuntu 上次跑到 68/68（旧版本） | 用量看板之后**没有在 Linux 重跑全量**；应用菜单入口没在真桌面点过；WSL 必须用 `/mnt/c/...`，日志不要放 `/tmp` |
| macOS | 未实测：代码里有 `open` / `pbcopy` 分支 | 没有 `.app` 打包、签名或公证；用 `bash open-map.sh` 或 `convledger url --copy` 回到页面 |
| 常驻服务 | Hub 固定 `127.0.0.1:8765`，只绑本机回环；端口被占时自动顺延到空位并打印临时地址（`--port` 可手动指定） | **没有 Windows 服务、systemd unit 或 launchd**：hub 是当前用户进程，重启/注销后不会自己起来；靠桌面快捷方式、`convledger map` 或 `map --serve` 拉起 |
| 桌面窗口 | Edge/Chrome `--app` 应用窗：无地址栏/标签页、不加载扩展、单实例聚焦；窗口图标由 favicon/manifest 免票提供 | 窗口、任务栏分组与 Alt-Tab 归浏览器进程；Edge 首次启动专用 profile 可能自建「Microsoft Edge」桌面快捷方式，已用 `--no-first-run` / `--no-default-browser-check` 抑制，历史遗留可直接删；不内置 Electron 或原生桌面壳 |
| 权限与数据 | 按用户安装，不需要管理员；只读宿主日志，写 `tool/out` 与用户级 Skill/hooks 配置；hub 只监听回环 | 系统休眠、锁屏、多用户并发没有专门验证；宿主 hook 投递仍依赖宿主应用本身在运行 |

宿主（Qoder / Claude Code / WorkBuddy / OpenCode / Codex）的接入位置、事件名与投递证据**不在本节**，用 `convledger caps --json` 的 `status` / `gaps` 查看；状态分「已验证 / 部分验证 / 未实测」。

## 如实的边界

- 「干净机器上双击 `install.cmd`」这条路径在开发机上没法验（会动真桌面），只在隔离的临时用户目录里从头走过装与撤。
- OpenCode 插件投递与后台派活已在真机跑通，但**改完插件要重启 OpenCode**：常驻 service 不热加载用户目录里的插件；它的投影是缓存，锚点指向投影字节而非宿主原始行。Claude Code 真机也跑通了 SessionStart 注入、Stop 回流建账与 **Agent（`run_in_background: true`）后台派活**——后台子代理在主线结束后仍写出文件，压缩事件未单独取证；headless 用 `--allowedTools` 时要放行 Bash/PowerShell，子代理才跑得了 convledger。派活方式必须与该宿主当前版本的 SDK/文档对得上，并有真机留痕；`convledger caps` 会点名缺出处或已证伪的表项。当前接入状态以 `convledger caps --json` 的 `status` / `gaps` 为唯一权威：**Qoder / Claude Code / WorkBuddy / OpenCode 四家都已真机跑通，Codex 未实测**；CHANGELOG 历史条目里的「未实测」是当时结论，不代表现在。
- 块综述、阶段与章说明**必须由模型在会话里补**，工具不代写；`outstanding` 是链路欠项的唯一出口，缺的就摆在报告里。
- 上面那两张画布图来自**合成演示账本**；本机的真实界面长同样的结构，但内容是你自己的。

## 版本、升级与卸载

- **版本看 tag 与 CHANGELOG**：`v0.1.0` 是第一个对外发布的版本，发布记录在 [Releases](https://github.com/zhl110/convledger/releases)，行为级变更逐条在 [CHANGELOG.md](CHANGELOG.md)。
- **机制总览**：运行流程、收尾/补账/画像、档位位置、规则与已知边界，见 `convledger --help` 与 `tool/skill/convledger/SKILL.md`。
- **升级**：`git pull --ff-only` 后重跑一次 `setup`——它会重装 Skill 正本（路径按新位置渲染）、补挂 hooks、给还没建账的会话建账。改了 `tool/web/` 或 `src/` 要重启 hub（`map --stop` 再 `map`），**已经开着的页面刷新一次**。
- **卸载**：`setup --uninstall` 只撤自己写过的东西——Skill 文件、`settings.json.hooks` 里自己的四个条目（别人的 hook 与配置键原样保留）、那两个快捷方式。账本与导出是派生数据，命令只打印路径，删不删由你决定。

## 目录与工程侧

```
tool/
  bin/convledger.mjs        唯一入口（命令分发全在 src/cli.mjs）
  src/                      账本与派生：project/segment/build/facts/store/view
                            外挂表：claims/summaries/phases/chapters/topics/notes
                            读面：brief/map/project-page/library/current/projects
                            项目闭环：progress/state-io/sync/export/memories
  web/                      hub、atlas（画布）、architecture（架构页）
  hooks/                    ledger-brief.mjs（Qoder/WorkBuddy）、opencode.mjs + 插件、install.mjs
  skill/                    convledger 正本与 install.mjs（同步到各宿主用户级目录）
  out/                      派生数据：store/<会话>/、projects/<键>/（可整目录重建，不入库）
docs/img/                   README 用的图
```

- 提交前密钥扫描：`node tool/scan-secrets.mjs`（gitleaks 扫历史与暂存区；`--staged` 只扫暂存）。
- 自测：`node tool/test/selftest.mjs`（含 OpenCode 投影与跨实例派活闸门、Claude Code 会话根与补建账本、setup 宿主检测与隔离 HOME 端到端装/撤、Skill 与命令面漂移守卫）。
- 几条不能破的纪律：**正文不搬进账本**、**闸门不过就不写**、**没验过的不说通过**、**hook 只读**。细则在代码注释与 Skill 正本里。

## 免责声明

- **代码可见/可用不等于作者兜底**：本项目仅供学习与自用，使用者自行承担使用风险。
- 本工具会读取本机会话日志、在本机起一个只监听 `127.0.0.1` 的服务，并可选地注册 hooks（会执行命令行）。请只在本机使用，不要暴露到公网，也不要把不信任的数据喂给它。
- **赞赏属于自愿捐赠**：不承诺 bug 修复、技术支持或售后。
- **不得用于任何违规用途**：使用者对自己的行为负责；因使用本项目引起的任何责任由使用者承担。

## 许可

源码可见，采用 **PolyForm Shield License 1.0.0**：**免费使用全部功能、允许二创与非竞争性分发**；**不可以提供与 convledger 竞争的产品**；分发时必须随附本许可与 `Required Notice`。完整条款见 [LICENSE.md](LICENSE.md)——这是 PolyForm 的源码可见许可，不是 OSI 开源许可。

## 数据与隐私

会话原文、按锚点派生的账本、项目导出与会话笔记都只留在使用者本机：`tool/out/`（派生账本与导出）刻意不入库，删掉也能从源日志重建。仓库里只有代码、文档与合成演示图；演示图不包含任何真人会话内容。

## 如果它帮到了你

这个工具免费，Node 运行时零依赖；三维架构页把 Three.js 作为本地 vendor 文件随仓库分发（`tool/web/vendor/three.module.min.js`，MIT），不装 npm 包、不访问 CDN，也不会为了功能向你要钱。
如果它确实替你省了时间，可以自愿请我喝杯咖啡——**这是个人打赏，不是购买服务**：不影响功能、排期与支持，也不开具发票。

<p align="center">
  <img src="docs/img/reward-qr-wechat.png" width="160" alt="微信赞赏码">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/img/reward-qr-alipay.png" width="160" alt="支付宝赞赏码">
</p>

<p align="center"><sub>微信 · 支付宝</sub></p>

<sub>扫码即表示你了解：这是个人赞赏，不是商品或服务交易。感谢支持。</sub>
